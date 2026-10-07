import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, opendir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChangeGroup, ComparisonSide, FileActionTarget, FileComparison, FileState, GitChange, MarkdownImage, ProjectDirectory, ProjectEntry, ProjectFile, Repository, RepositorySnapshot, SaveTextResult, TextMetadata, TreeActionTarget } from '../src/bridge';
import type { MediaContent } from '../../shared/media/types';
import { ABSOLUTE_MAX_PREVIEW_BYTES, DEFAULT_MAX_PREVIEW_BYTES, mediaContent, sniffMedia } from './media';
import type { RepositoryWatchState } from './repository-watcher';
import { defaultNodeFacts, emptyChangeSummary, type DirectoryMarking, type ProjectTreePreferences, type TreeNodeFacts } from '../../shared/project/semantics';
import { nodeGitFacts, parseIgnoreFacts, projectGitSnapshot, type IgnoreFact, type ProjectGitSnapshot } from './project-facts';
import { ProjectMetadata } from './project-metadata';
import { GitIndexReader, MAX_GIT_INDEX_BYTES, type GitIndexSnapshot } from './git-index';
import { markdownProjectPath, MAX_MARKDOWN_IMAGE_BYTES } from './markdown';

export interface StatusRecord {
  kind: 'ordinary' | 'rename' | 'untracked' | 'conflict';
  xy: string;
  path: string;
  oldPath?: string;
  submodule: string;
  headMode: string;
  indexMode: string;
  workMode: string;
  headOid: string;
  indexOid: string;
}

/** Git paths follow the fixed fields, and are never split on whitespace. */
function fields(record: string, count: number): [string[], string] {
  const result: string[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const space = record.indexOf(' ', offset);
    if (space < 0) throw new Error('Malformed Git porcelain record.');
    result.push(record.slice(offset, space));
    offset = space + 1;
  }
  return [result, record.slice(offset)];
}

export function parsePorcelainV2(input: Buffer | string): StatusRecord[] {
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
  const tokens = text.split('\0');
  const result: StatusRecord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const item = tokens[i];
    if (!item || item.startsWith('# ') || item.startsWith('! ')) continue;
    if (item.startsWith('? ')) {
      result.push({ kind: 'untracked', xy: '??', path: item.slice(2), submodule: 'N...', headMode: '000000', indexMode: '000000', workMode: '100644', headOid: '', indexOid: '' });
      continue;
    }
    if (item.startsWith('1 ') || item.startsWith('2 ')) {
      const rename = item[0] === '2';
      const [f, filePath] = fields(item, rename ? 9 : 8);
      const oldPath = rename ? tokens[++i] : undefined;
      if (!filePath || (rename && !oldPath)) throw new Error('Malformed Git rename record.');
      result.push({ kind: rename ? 'rename' : 'ordinary', xy: f[1], submodule: f[2], headMode: f[3], indexMode: f[4], workMode: f[5], headOid: f[6], indexOid: f[7], path: filePath, ...(oldPath === undefined ? {} : { oldPath }) });
      continue;
    }
    if (item.startsWith('u ')) {
      const [f, filePath] = fields(item, 10);
      result.push({ kind: 'conflict', xy: f[1], path: filePath, submodule: f[2], headMode: f[3], indexMode: f[4], workMode: f[6], headOid: f[7], indexOid: f[8] });
      continue;
    }
    throw new Error('Unsupported Git porcelain record.');
  }
  return result;
}

export type Endpoint = { kind: 'empty' } | { kind: 'blob'; oid: string } | { kind: 'working'; path: string };
export interface ResolvedChange {
  group: ChangeGroup;
  status: string;
  original: Endpoint;
  modified: Endpoint;
  unsupported?: FileState;
}

const blob = (mode: string, oid: string): Endpoint => mode === '000000' || /^0+$/.test(oid) ? { kind: 'empty' } : { kind: 'blob', oid };

/** Resolve endpoints once from a status snapshot; object IDs remain immutable. */
export function resolveEndpoints(record: StatusRecord): ResolvedChange[] {
  const head = blob(record.headMode, record.headOid);
  const index = blob(record.indexMode, record.indexOid);
  const working: Endpoint = record.workMode === '000000' ? { kind: 'empty' } : { kind: 'working', path: record.path };
  if (record.kind === 'conflict') return [{ group: 'unstaged', status: 'U', original: head, modified: working, unsupported: 'conflicted' }];
  let unsupported: FileState | undefined;
  const modes = [record.headMode, record.indexMode, record.workMode];
  if (record.submodule.startsWith('S') || modes.includes('160000')) unsupported = 'submodule';
  else if (modes.includes('120000')) unsupported = 'symlink';
  else if (record.xy.includes('T')) unsupported = 'type-change';
  const result: ResolvedChange[] = [];
  if (record.kind === 'untracked') result.push({ group: 'untracked', status: '?', original: { kind: 'empty' }, modified: working, unsupported });
  else {
    if (record.xy[0] !== '.') result.push({ group: 'staged', status: record.xy[0], original: head, modified: index, unsupported });
    if (record.xy[1] !== '.') result.push({ group: 'unstaged', status: record.xy[1], original: index, modified: working, unsupported });
  }
  return result;
}

/** A staged deletion plus an untracked recreation describes one working path. */
function workingRecords(records: StatusRecord[]): StatusRecord[] {
  const paths = new Map<string, StatusRecord>();
  for (const record of records) {
    const previous = paths.get(record.path);
    if (!previous) paths.set(record.path, record);
    else {
      const tracked = record.kind === 'untracked' ? previous : record;
      const untracked = record.kind === 'untracked' ? record : previous;
      paths.set(record.path, { ...tracked, workMode: untracked.workMode });
    }
  }
  return [...paths.values()];
}

function workingEndpoints(record: StatusRecord): ResolvedChange {
  if (record.kind === 'untracked') return resolveEndpoints(record)[0];
  const original = blob(record.headMode, record.headOid);
  const modified: Endpoint = record.workMode === '000000' ? { kind: 'empty' } : { kind: 'working', path: record.path };
  const unsupported = resolveEndpoints(record).find(change => change.unsupported)?.unsupported;
  const status = record.kind === 'conflict' ? 'U' : original.kind === 'empty' ? 'A' : modified.kind === 'empty' ? 'D' : record.xy.includes('R') ? 'R' : record.xy.includes('T') ? 'T' : 'M';
  return { group: 'working', status, original, modified, unsupported };
}

function comparisonRecords(records: StatusRecord[]): Array<{ record: StatusRecord; endpoints: ResolvedChange }> {
  return [
    ...records.flatMap(record => resolveEndpoints(record).map(endpoints => ({ record, endpoints }))),
    ...workingRecords(records).filter(record => record.kind !== 'untracked').map(record => ({ record, endpoints: workingEndpoints(record) })),
  ];
}

interface StoredChange extends GitChange { original: Endpoint; modified: Endpoint; modifiedMode: string; fingerprint?: string; gitIdentity?: string }
export interface CapturedCommitChange {
  id: string;
  path: string;
  oldPath?: string;
  group: ChangeGroup;
  mode: string;
  oid?: string;
  contents?: Buffer;
}
/** Only the selected comparison endpoints determine whether its contents are current. */
function comparisonIdentity(change: Pick<StoredChange, 'path' | 'oldPath'> & ResolvedChange): string {
  return JSON.stringify([change.path, change.oldPath ?? null, change.group, change.status, change.original, change.modified, change.unsupported ?? null]);
}
interface StoredProjectEntry { public: ProjectEntry; unavailable?: boolean }
interface StoredEdit { id: string; path: string; version: string; fingerprint: string; metadata: TextMetadata; lineEnding: 'LF' | 'CRLF' | 'CR' }
export interface ResolvedFileActionTarget {
  path: string;
  absolutePath: string;
  source?: ProjectEntry;
  fingerprint?: string;
  unavailableReason?: string;
}
interface StoredRepository {
  public: Repository;
  generation: number;
  statusHash: string;
  gitDirectory: string;
  changes: Map<string, StoredChange>;
  watchPaths: string[];
  watchInterests: Map<string, 'file' | 'directory'>;
  refreshSequence: number;
  projectEntries: Map<string, StoredProjectEntry>;
  projectPaths: Map<string, string>;
  submodules: Set<string>;
  edits: Map<string, StoredEdit>;
  editPaths: Map<string, string>;
  savingPaths: Set<string>;
  snapshot?: RepositorySnapshot;
  projectGit?: ProjectGitSnapshot;
  ignored: Map<string, IgnoreFact>;
  ignoreSources: Set<string>;
  metadata: ProjectMetadata;
  metadataText: Map<string, { fingerprint: string; text: string | null }>;
  metadataTextBytes: number;
  metadataObserved: Map<string, Promise<boolean>>;
  nestedRepositories: Map<string, Promise<boolean>>;
}

class FileProblem extends Error {
  constructor(readonly state: FileState, message: string) { super(message); }
}

const messages: Partial<Record<FileState, string>> = {
  conflicted: 'This file has unresolved conflicts. Two-way conflict rendering is not supported.',
  submodule: 'Submodule changes are not text comparisons.',
  'type-change': 'The file type changed. This comparison cannot be rendered as text.',
  symlink: 'Symbolic links are not opened or followed by this viewer.',
};

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
}

/** All Git commands use argument arrays and explicitly disable shell/external helpers. */
export function runGit(cwd: string, args: string[], maxBytes = 32 * 1024 * 1024, options: { env?: NodeJS.ProcessEnv; allowedExitCodes?: number[]; versionCheck?: boolean; input?: Buffer; beforeTransactionCommit?: () => Promise<void>; signal?: AbortSignal; onStdout?: (chunk: Buffer) => void; timeoutMs?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new DOMException('Git operation canceled.', 'AbortError')); return; }
    const process = spawn('git', ['--no-optional-locks', ...(options.versionCheck ? [] : ['--no-lazy-fetch']), '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'diff.external=', ...args], { cwd, shell: false, windowsHide: true, env: { ...gitEnvironment(), ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let failure: Error | undefined;
    let validating = false;
    let closed = false;
    const abort = () => { failure = new DOMException('Git operation canceled.', 'AbortError'); process.kill(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    process.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure = error; });
    if (options.beforeTransactionCommit) process.stdin.write(options.input!);
    else process.stdin.end(options.input);
    const timeoutMs = options.timeoutMs ?? 15000;
    const timer = setTimeout(() => { failure = new Error(`Git timed out after ${timeoutMs / 1000} seconds. Try refreshing the repository.`); process.kill(); }, timeoutMs);
    process.stdout.on('data', (data: Buffer) => {
      if (failure) return;
      size += data.length;
      if (size > maxBytes) { failure = new Error('Git output exceeds the safety limit.'); process.kill(); return; }
      if (options.onStdout) {
        try { options.onStdout(data); }
        catch (error) { failure = error instanceof Error ? error : new Error(String(error)); process.kill(); return; }
      } else chunks.push(data);
      // A prepared update-ref transaction holds Git's own reference/HEAD locks.
      // Keep stdin open until the caller validates its reviewed HEAD under them.
      if (options.beforeTransactionCommit && !validating && Buffer.concat(chunks).toString('utf8').includes('prepare: ok\n')) {
        validating = true;
        void options.beforeTransactionCommit().then(() => { if (!closed) process.stdin.end('commit\n'); }, error => {
          failure = error instanceof Error ? error : new Error(String(error));
          if (!closed) process.stdin.end('abort\n');
        });
      }
    });
    process.stderr.on('data', (data: Buffer) => { errorSize += data.length; if (errorSize <= 16 * 1024) errors.push(data); });
    process.on('error', error => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(new Error(`Could not run Git: ${error.message}`)); });
    process.on('close', code => {
      closed = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 && (code === null || !options.allowedExitCodes?.includes(code))) reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `Git exited with code ${code}.`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
// Full index/status scans can touch hundreds of thousands of entries. Keep
// them bounded, but allow more time than small metadata and blob operations.
const REPOSITORY_SCAN_TIMEOUT_MS = 60000;

/** Commit-review identity needs all index bytes, but never a buffered copy of
 * them. Hash Git's logical listing so split indexes and worktrees behave alike. */
export async function readGitIndexFingerprint(root: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const fingerprint = createHash('sha256');
  await runGit(root, ['ls-files', '--stage', '-z'], MAX_GIT_INDEX_BYTES, {
    env, onStdout: chunk => { fingerprint.update(chunk); }, timeoutMs: REPOSITORY_SCAN_TIMEOUT_MS,
  });
  return fingerprint.digest('hex');
}

async function status(root: string, includeUntracked = true): Promise<Buffer> {
  return safeWorkingGit(root, ['status', '--porcelain=v2', '-z', includeUntracked ? '--untracked-files=all' : '--untracked-files=no', '--ignore-submodules=dirty'], undefined, { timeoutMs: REPOSITORY_SCAN_TIMEOUT_MS });
}

/** Validate only this capability's paths. A full untracked scan per editor read
 * can take minutes in a large worktree and does not strengthen its identity. Both
 * sides of a rename remain in scope; literal pathspecs preserve unusual names. */
async function comparisonStatus(root: string, change: StoredChange): Promise<Buffer> {
  const paths = [...new Set([change.path, ...(change.oldPath ? [change.oldPath] : [])])];
  return safeWorkingGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--',
    ...paths.map(filePath => `:(top,literal)${filePath}`)]);
}

async function readGitIndex(root: string): Promise<GitIndexSnapshot> {
  const reader = new GitIndexReader(filePath => { safeRepositoryPath(root, filePath); });
  await runGit(root, ['ls-files', '--stage', '-z'], MAX_GIT_INDEX_BYTES, { onStdout: chunk => reader.write(chunk), timeoutMs: REPOSITORY_SCAN_TIMEOUT_MS });
  return reader.finish();
}

/** A private Git facade preserves safe formatting/ignore settings, never executable configuration. */
export async function safeWorkingGit(root: string, args: string[], input?: Buffer, options: { timeoutMs?: number } = {}): Promise<Buffer> {
  // Status can execute clean/process filters. A private repository facade avoids
  // loading the source config entirely, including a concurrently added driver.
  // These original-repository metadata commands never run hooks or filters.
  const optional = { allowedExitCodes: [1] };
  const [indexPath, objectsPath, excludePath, attributesPath, sparsePath, sharedIndexPath, objectFormat, head, safeConfig] = await Promise.all([
    runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']),
    runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']),
    runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']),
    runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes']),
    runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/sparse-checkout']),
    runGit(root, ['rev-parse', '--path-format=absolute', '--shared-index-path']),
    runGit(root, ['rev-parse', '--show-object-format']),
    runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], 100, optional),
    runGit(root, ['config', '--null', '--get-regexp', '^(core\\.(filemode|ignorecase|symlinks|autocrlf|eol|safecrlf|trustctime|ignorestat|checkstat|precomposeunicode|excludesfile|sparsecheckout|sparsecheckoutcone)|index\\.(sparse|version))$'], 1024 * 1024, optional),
  ]);
  const oid = stripLastNewline(head);
  if (oid && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error('Git returned an invalid HEAD identity.');
  // Missing detached/corrupt HEAD is an error; a missing symbolic HEAD is unborn.
  if (!oid) await runGit(root, ['symbolic-ref', '--quiet', 'HEAD']);
  const format = stripLastNewline(objectFormat);
  if (format !== 'sha1' && format !== 'sha256') throw new Error('Unsupported Git object format.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-status-'));
  try {
    await Promise.all([mkdir(path.join(directory, 'refs')), mkdir(path.join(directory, 'objects')), mkdir(path.join(directory, 'info'))]);
    await Promise.all([
      writeFile(path.join(directory, 'HEAD'), oid ? `${oid}\n` : 'ref: refs/heads/unborn\n'),
      writeFile(path.join(directory, 'config'), `[core]\nrepositoryformatversion = ${format === 'sha256' ? 1 : 0}\nbare = false\n${format === 'sha256' ? '[extensions]\nobjectformat = sha256\n' : ''}`),
      writeFile(path.join(directory, 'empty-config'), ''),
    ]);
    for (const [source, name] of [[excludePath, 'exclude'], [attributesPath, 'attributes'], [sparsePath, 'sparse-checkout']] as const) {
      try { await copyFile(stripLastNewline(source), path.join(directory, 'info', name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const shared = stripLastNewline(sharedIndexPath);
    if (shared) await copyFile(shared, path.join(directory, path.basename(shared)));
    const overrides: string[] = [];
    for (const entry of safeConfig.toString('utf8').split('\0')) {
      const newline = entry.indexOf('\n');
      if (newline < 0) continue;
      const key = entry.slice(0, newline).toLowerCase();
      const value = entry.slice(newline + 1);
      // Recheck the allowlist before producing command-line configuration.
      if (/^(?:core\.(?:filemode|ignorecase|symlinks|autocrlf|eol|safecrlf|trustctime|ignorestat|checkstat|precomposeunicode|excludesfile|sparsecheckout|sparsecheckoutcone)|index\.(?:sparse|version))$/.test(key)) overrides.push('-c', `${key}=${value}`);
    }
    return await runGit(root, [...overrides, ...args], 32 * 1024 * 1024, { input, timeoutMs: options.timeoutMs, env: {
      GIT_DIR: directory,
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: stripLastNewline(indexPath),
      GIT_OBJECT_DIRECTORY: stripLastNewline(objectsPath),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: path.join(directory, 'empty-config'),
      GIT_CONFIG_GLOBAL: path.join(directory, 'empty-config'),
      GIT_ATTR_NOSYSTEM: '1',
    } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const stripLastNewline = (buffer: Buffer) => buffer.toString('utf8').replace(/\r?\n$/, '');

export function safeRepositoryPath(root: string, filePath: string): string {
  if (!filePath || filePath.includes('\0') || path.isAbsolute(filePath) || filePath.split('/').some(part => !part || part === '.' || part === '..')) throw new FileProblem('unavailable', 'Invalid repository-relative path.');
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new FileProblem('unavailable', 'File is outside the selected repository.');
  return absolute;
}

function fingerprint(stat: Awaited<ReturnType<typeof lstat>>): string {
  return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Directory reads get the same ancestor and canonical-path checks as file reads. */
async function inspectDirectory(root: string, directoryPath: string): Promise<{ absolute: string; fingerprint: string }> {
  const absolute = directoryPath ? safeRepositoryPath(root, directoryPath) : root;
  const parts = directoryPath ? path.relative(root, absolute).split(path.sep) : [];
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new FileProblem('symlink', messages.symlink!);
    if (!info.isDirectory()) throw new FileProblem('unavailable', 'This path is no longer a directory. Refresh the project.');
    if (current === absolute) {
      if (await realpath(absolute) !== absolute) throw new FileProblem('symlink', 'The directory path changed or traverses a symbolic link. Refresh the project.');
      return { absolute, fingerprint: fingerprint(info) };
    }
  }
  throw new FileProblem('unavailable', 'Directory is unavailable.');
}

/** Check every ancestor, not just the final path. Never traverse repository symlinks. */
async function inspectWorkingPath(root: string, filePath: string): Promise<{ absolute: string; fingerprint: string; size: number }> {
  await inspectDirectory(root, '');
  const absolute = safeRepositoryPath(root, filePath);
  const relative = path.relative(root, absolute);
  const parts = relative.split(path.sep);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new FileProblem('symlink', messages.symlink!);
    if (i < parts.length - 1 && !info.isDirectory()) throw new FileProblem('unavailable', 'A parent of this file is no longer a directory.');
    if (i === parts.length - 1) {
      if (!info.isFile()) throw new FileProblem('type-change', 'This path is not a regular file.');
      const resolved = await realpath(absolute);
      if (resolved !== absolute) throw new FileProblem('symlink', 'The file path changed or traverses a symbolic link. Refresh the repository.');
      return { absolute, fingerprint: fingerprint(info), size: info.size };
    }
  }
  throw new FileProblem('unavailable', 'File is unavailable.');
}

export function decodeText(buffer: Buffer): { text: string; metadata: TextMetadata } {
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff) || (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 0xfe && buffer[3] === 0xff)) throw new FileProblem('encoding', 'UTF-16/UTF-32 files are not supported. Convert to UTF-8 to view this file.');
  if (buffer.includes(0)) throw new FileProblem('binary', 'This file contains binary data and cannot be displayed as a text diff.');
  const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new FileProblem('encoding', 'This file is not valid UTF-8. Other encodings are not supported.'); }
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  const lineEnding: TextMetadata['lineEnding'] = kinds > 1 ? 'mixed' : crlf ? 'CRLF' : lf ? 'LF' : cr ? 'CR' : 'none';
  return { text, metadata: { bytes: buffer.length, encoding: hasBom ? 'utf-8-bom' : 'utf-8', lineEnding, finalNewline: /[\r\n]$/.test(text) } };
}

/** The only owner of repository paths and comparison endpoint capabilities. */
export class GitService {
  private readonly repositories = new Map<string, StoredRepository>();
  private gitVersionCheck?: Promise<void>;
  private readonly mutationQueues = new Map<string, Promise<unknown>>();
  readonly maxFileBytes: number;
  readonly maxPreviewBytes: number;
  readonly maxDirectoryEntries: number;
  private readonly projectSettingsDirectory?: string;
  constructor(options: { maxFileBytes?: number; maxPreviewBytes?: number; maxDirectoryEntries?: number; projectSettingsDirectory?: string } = {}) {
    this.projectSettingsDirectory = options.projectSettingsDirectory;
    this.maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1) throw new Error('maxFileBytes must be a positive integer.');
    this.maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES;
    if (!Number.isSafeInteger(this.maxPreviewBytes) || this.maxPreviewBytes < 1 || this.maxPreviewBytes > ABSOLUTE_MAX_PREVIEW_BYTES) throw new Error('maxPreviewBytes must be an integer between 1 and 104,857,600.');
    this.maxDirectoryEntries = options.maxDirectoryEntries ?? 2000;
    if (!Number.isSafeInteger(this.maxDirectoryEntries) || this.maxDirectoryEntries < 1 || this.maxDirectoryEntries > 10000) throw new Error('maxDirectoryEntries must be an integer between 1 and 10,000.');
  }

  async registerRepository(selectedPath: string, options: { deferUntracked?: boolean } = {}): Promise<RepositorySnapshot> {
    if (typeof selectedPath !== 'string' || selectedPath.includes('\0')) throw new Error('Invalid repository directory.');
    const selected = await realpath(selectedPath);
    await inspectDirectory(selected, '');
    let probe = selected;
    let hasGit = false;
    while (true) {
      try { await lstat(path.join(probe, '.git')); hasGit = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (hasGit) { this.gitVersionCheck ??= this.checkGitVersion(selected); await this.gitVersionCheck; }
    const root = hasGit ? await realpath(stripLastNewline(await runGit(selected, ['rev-parse', '--show-toplevel']))) : selected;
    const existing = [...this.repositories.values()].find(item => item.public.path === root);
    if (existing) return options.deferUntracked ? this.listChanges(existing.public.id) : this.refreshRepository(existing.public.id);
    const [gitDirectory, commonDirectory] = hasGit ? await Promise.all([
      runGit(root, ['rev-parse', '--path-format=absolute', '--git-dir']),
      runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]) : [Buffer.from(root), Buffer.from(root)];
    const metadata = new ProjectMetadata(root, this.projectSettingsDirectory);
    await metadata.load();
    const repository: StoredRepository = { public: { id: randomUUID(), name: path.basename(root), path: root, ...(!hasGit ? { gitAvailable: false } : {}) }, generation: 0, statusHash: '', gitDirectory: stripLastNewline(gitDirectory), changes: new Map(), projectEntries: new Map(), projectPaths: new Map(), submodules: new Set(), edits: new Map(), editPaths: new Map(), savingPaths: new Set(), refreshSequence: 0, watchInterests: new Map(), watchPaths: [...new Set([root, stripLastNewline(gitDirectory), stripLastNewline(commonDirectory)])], ignored: new Map(), ignoreSources: new Set(), metadata, metadataText: new Map(), metadataTextBytes: 0, metadataObserved: new Map(), nestedRepositories: new Map() };
    this.repositories.set(repository.public.id, repository);
    // The application can publish tracked changes and authorize project browsing
    // before an expensive untracked-directory walk. Its main process publishes
    // a complete refresh later; ordinary service callers keep the full snapshot.
    return options.deferUntracked && hasGit ? this.scanRepository(repository.public.id, false) : this.refreshRepository(repository.public.id);
  }

  private async checkGitVersion(cwd: string): Promise<void> {
    const version = stripLastNewline(await runGit(cwd, ['version'], 1024, { versionCheck: true }));
    const match = /^git version (\d+)\.(\d+)(?:\.|$)/.exec(version);
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 50)) throw new Error(`unintellij requires Git 2.50 or newer to disable lazy fetching safely. Found: ${version}. Install a newer Git and restart.`);
  }

  private repository(id: string): StoredRepository {
    if (typeof id !== 'string') throw new Error('Invalid repository identifier.');
    const repository = this.repositories.get(id);
    if (!repository) throw new Error('Unknown repository. Select the repository again.');
    return repository;
  }

  /** Main-process-only helpers; none of these paths/endpoints cross the preload bridge. */
  getRepositoryRoot(id: string): string { return this.repository(id).public.path; }
  isGitRepository(id: string): boolean { return this.repository(id).public.gitAvailable !== false; }

  /** Closed windows must not retain a monorepo's index, tree and edit capabilities.
   * Finish already-authorized operations first, then recheck window ownership:
   * another window may have opened the same project while an operation ran.
   */
  async releaseRepository(id: string, unused: () => boolean): Promise<boolean> {
    const repository = this.repositories.get(id);
    if (!repository) return false;
    let pending: Promise<unknown> | undefined;
    while ((pending = this.mutationQueues.get(repository.public.path))) await pending.catch(() => undefined);
    if (this.repositories.get(id) !== repository || !unused()) return false;
    this.repositories.delete(id);
    return true;
  }

  /** Menu hints use the already loaded index/status, never walk a selected folder. */
  getTreeGitPresence(id: string, filePath: string): { indexed: boolean; pending: boolean } {
    const snapshot = this.repository(id).projectGit;
    const contains = (candidate: string) => !filePath || candidate === filePath || candidate.startsWith(`${filePath}/`);
    let indexed = false, pending = false;
    if (snapshot) {
      // Iterate lazily: a directory-menu hint must not expand the entire compact
      // monorepo index back into an array of hundreds of thousands of strings.
      for (const candidate of snapshot.tracked) {
        if (contains(candidate) && snapshot.states.get(candidate)?.index !== 'deleted') { indexed = true; break; }
      }
      for (const [candidate, facts] of snapshot.states) {
        if (contains(candidate) && !['clean', 'not-applicable', 'unavailable', 'ignored'].includes(facts.workingTree)) { pending = true; break; }
      }
    }
    return { indexed, pending };
  }

  /** Group headers authorize exact current comparison members, never a root path. */
  resolveTreeActionGroup(id: string, changeIds: string[]): { label: string; fileCount: number; addPaths: string[]; removePaths: string[] } {
    const repository = this.repository(id);
    if (repository.public.gitAvailable === false) throw new Error('This project has no Git repository.');
    const changes = changeIds.map(changeId => {
      const change = repository.changes.get(changeId);
      if (!change) throw new Error('This change is no longer current. Refresh and open its menu again.');
      if (change.group !== 'working' && change.group !== 'untracked') throw new Error('Choose current Changes or Unversioned Files entries.');
      return change;
    });
    if (changes.some(change => change.group !== changes[0].group)) throw new Error('Changes and Unversioned Files must be acted on separately.');
    const members = new Map(changes.map(change => [change.path, change]));
    const addPaths: string[] = [], removePaths: string[] = [];
    for (const change of members.values()) {
      if (change.unsupported && !['binary', 'oversized', 'encoding'].includes(change.unsupported)) continue;
      const facts = repository.projectGit?.states.get(change.path);
      if (!facts || facts.state === 'conflicted') continue;
      if (!['clean', 'not-applicable', 'unavailable', 'ignored'].includes(facts.workingTree)) addPaths.push(change.path);
      if (repository.projectGit?.tracked.has(change.path) && facts.index !== 'deleted') removePaths.push(change.path);
    }
    return { label: changes[0].group === 'untracked' ? 'Unversioned Files' : 'Changes', fileCount: members.size, addPaths, removePaths };
  }

  /** One queue shared by branch, index, and tree mutations in every window. */
  serializeRepositoryOperation<T>(id: string, operation: (root: string) => Promise<T>): Promise<T> {
    const root = this.getRepositoryRoot(id);
    const previous = this.mutationQueues.get(root) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => operation(root));
    this.mutationQueues.set(root, next);
    void next.finally(() => { if (this.mutationQueues.get(root) === next) this.mutationQueues.delete(root); }).catch(() => undefined);
    return next;
  }

  async resolveTreeActionPath(id: string, target: TreeActionTarget): Promise<string> {
    const repository = this.repository(id);
    if (!target || typeof target !== 'object') throw new Error('Invalid tree action target.');
    if (target.kind === 'project') return target.id === null ? '' : this.projectEntry(repository, target.id).public.path;
    if (target.kind !== 'change' && target.kind !== 'change-directory') throw new Error('Invalid tree action target.');
    const change = repository.changes.get(target.kind === 'change' ? target.id : target.changeId);
    if (!change) throw new Error('This change is no longer current. Refresh and open its menu again.');
    if (target.kind === 'change') return change.path;
    if (typeof target.path !== 'string' || !target.path || !change.path.startsWith(`${target.path}/`)) throw new Error('The selected directory is not an ancestor of this change.');
    if ((await this.inspectTreeActionPath(id, target.path)).kind !== 'directory') throw new Error('The selected change directory no longer exists.');
    return target.path;
  }

  /** Main-process-only paths derived from a capability or a validated child name. */
  async inspectTreeActionPath(id: string, filePath: string): Promise<{ absolutePath: string; kind: ProjectEntry['kind'] | 'missing'; fingerprint?: string }> {
    const repository = this.repository(id);
    if (filePath.split('/').some(part => part.toLowerCase() === '.git')) throw new Error('Git metadata cannot be changed here.');
    if (this.isInsideSubmodule(repository, filePath)) return { absolutePath: safeRepositoryPath(repository.public.path, filePath), kind: 'submodule' };
    const parent = filePath ? path.posix.dirname(filePath) : '';
    try { await inspectDirectory(repository.public.path, parent === '.' ? '' : parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { absolutePath: safeRepositoryPath(repository.public.path, filePath), kind: 'missing' }; throw error; }
    const parts = filePath ? filePath.split('/') : [];
    let current = '';
    // Recheck boundaries rather than trusting decoration caches before a mutation.
    for (let index = 0; index < parts.length; index++) {
      current = current ? `${current}/${parts[index]}` : parts[index];
      repository.nestedRepositories.delete(current);
      if (await this.nestedRepository(repository, current)) throw new Error('Open the nested repository as a separate project to change its files.');
    }
    const absolutePath = filePath ? safeRepositoryPath(repository.public.path, filePath) : repository.public.path;
    try {
      const info = await lstat(absolutePath);
      return { absolutePath, kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'missing', fingerprint: fingerprint(info) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { absolutePath, kind: 'missing' }; throw error; }
  }

  remapTreeActionPaths(id: string, from: string, to: string): void {
    const repository = this.repository(id);
    const remap = (value: string) => value === from ? to : value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;
    for (const entry of repository.projectEntries.values()) {
      const previous = entry.public.path, next = remap(previous);
      if (next === previous) continue;
      repository.projectPaths.delete(previous);
      entry.public = { ...entry.public, path: next, name: path.posix.basename(next), facts: undefined };
      repository.projectPaths.set(next, entry.public.id);
    }
    for (const [editId, edit] of repository.edits) if (remap(edit.path) !== edit.path) { repository.edits.delete(editId); repository.editPaths.delete(edit.path); }
    for (const [filePath, kind] of [...repository.watchInterests]) { const next = remap(filePath); if (next !== filePath) { repository.watchInterests.delete(filePath); repository.watchInterests.set(next, kind); } }
  }

  async issueTreeActionEntry(id: string, filePath: string): Promise<ProjectEntry> {
    const repository = this.repository(id);
    const inspected = await this.inspectTreeActionPath(id, filePath);
    if (inspected.kind !== 'file' && inspected.kind !== 'directory') throw new Error('The new project entry is unavailable.');
    const previousId = repository.projectPaths.get(filePath);
    const previous = previousId ? repository.projectEntries.get(previousId)?.public : undefined;
    if (!previous && repository.projectEntries.size >= 100000) throw new Error('The project capability limit was reached. Restart the app to open more files.');
    const entry: ProjectEntry = { id: previous?.id ?? randomUUID(), name: path.posix.basename(filePath), path: filePath, kind: inspected.kind };
    repository.projectPaths.set(filePath, entry.id); repository.projectEntries.set(entry.id, { public: entry });
    this.trackWatchInterest(repository, filePath, inspected.kind);
    return { ...entry };
  }

  private metadataIo(repository: StoredRepository) {
    const root = repository.public.path;
    return {
      readText: async (filePath: string): Promise<string | null> => {
        try {
          const inspected = await inspectWorkingPath(root, filePath);
          if (inspected.size > 256 * 1024) return null;
          const previous = repository.metadataText.get(filePath);
          if (previous?.fingerprint === inspected.fingerprint) return previous.text;
          const text = decodeText(await this.readEndpoint(root, { kind: 'working', path: filePath }, inspected.fingerprint)).text;
          repository.metadataTextBytes -= previous?.text?.length ?? 0;
          repository.metadataText.set(filePath, { fingerprint: inspected.fingerprint, text });
          repository.metadataTextBytes += text.length;
          while (repository.metadataText.size > 256 || repository.metadataTextBytes > 2 * 1024 * 1024) {
            const oldest = repository.metadataText.keys().next().value!;
            repository.metadataTextBytes -= repository.metadataText.get(oldest)?.text?.length ?? 0;
            repository.metadataText.delete(oldest);
          }
          return text;
        } catch { return null; }
      },
      listDirectory: async (directory: string): Promise<Array<{ name: string; kind: 'file' | 'directory' | 'symlink' }>> => {
        const result: Array<{ name: string; kind: 'file' | 'directory' | 'symlink' }> = [];
        let handle: Awaited<ReturnType<typeof opendir>> | undefined;
        try {
          const inspected = await inspectDirectory(root, directory);
          handle = await opendir(inspected.absolute, { bufferSize: 32 });
          while (result.length < 512) {
            const entry = await handle.read();
            if (!entry) break;
            if (entry.name.toLowerCase() === '.git') continue;
            result.push({ name: entry.name, kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file' });
          }
        } catch { /* Missing/unreadable metadata is not invented project configuration. */ }
        finally { await handle?.close(); }
        return result;
      },
    };
  }

  private observeMetadata(repository: StoredRepository, filePath: string, directory: boolean): Promise<boolean> {
    const parent = directory ? filePath : path.posix.dirname(filePath) === '.' ? '' : path.posix.dirname(filePath);
    const previous = repository.metadataObserved.get(parent);
    if (previous) return previous;
    const work = (async () => {
      if (parent) {
        if (!await this.observeMetadata(repository, parent, false)) return false;
        if (this.isInsideSubmodule(repository, parent) || await this.nestedRepository(repository, parent)) return false;
      }
      await repository.metadata.observeDirectory(parent, this.metadataIo(repository));
      return true;
    })();
    repository.metadataObserved.set(parent, work);
    return work;
  }

  private nestedRepository(repository: StoredRepository, filePath: string): Promise<boolean> {
    if (!filePath) return Promise.resolve(false);
    const previous = repository.nestedRepositories.get(filePath);
    if (previous) return previous;
    const work = (async () => {
      try {
        const directory = await inspectDirectory(repository.public.path, filePath);
        await lstat(path.join(directory.absolute, '.git'));
        return true;
      } catch { return false; }
    })();
    repository.nestedRepositories.set(filePath, work);
    return work;
  }

  private async ignoreFacts(repository: StoredRepository, paths: Array<{ path: string; directory: boolean }>): Promise<void> {
    if (repository.public.gitAvailable === false) return;
    const missing = paths.filter(item => item.path && !repository.ignored.has(item.path));
    if (!missing.length) return;
    const generation = repository.generation;
    const input = Buffer.from(missing.map(item => `${item.path}${item.directory ? '/' : ''}\0`).join(''));
    let output: Buffer;
    try { output = await runGit(repository.public.path, ['check-ignore', '--verbose', '--non-matching', '-z', '--stdin'], 4 * 1024 * 1024, { input, allowedExitCodes: [1] }); }
    catch {
      if (repository.generation !== generation) throw new FileProblem('stale', 'Project state changed while checking ignore rules. Refresh the project.');
      for (const item of missing) repository.ignored.set(item.path, { unavailable: true });
      return;
    }
    if (repository.generation !== generation) throw new FileProblem('stale', 'Project state changed while checking ignore rules. Refresh the project.');
    for (const [filePath, ignored] of parseIgnoreFacts(output)) repository.ignored.set(filePath, ignored);
  }

  private async factsFor(repository: StoredRepository, filePath: string, kind: TreeNodeFacts['identity']['kind']): Promise<TreeNodeFacts> {
    const directory = kind === 'directory' || kind === 'submodule';
    await this.observeMetadata(repository, filePath, directory);
    const facts = defaultNodeFacts(repository.public.id, filePath, kind, repository.generation);
    Object.assign(facts, repository.metadata.classify(filePath, kind));
    facts.git = nodeGitFacts(repository.projectGit, filePath, directory, repository.ignored.get(filePath), repository.public.gitAvailable !== false);
    const summary = repository.projectGit?.summaries.get(filePath);
    facts.changes = summary ? { immediate: { ...summary.immediate }, descendants: { ...summary.descendants } } : { immediate: emptyChangeSummary(), descendants: emptyChangeSummary() };
    const parts = filePath.split('/');
    if (!directory) parts.pop();
    let boundary = '';
    for (const part of parts) {
      boundary = boundary ? `${boundary}/${part}` : part;
      if (!boundary) break;
      if (boundary === filePath && kind === 'submodule') break;
      if (repository.submodules.has(boundary) || await this.nestedRepository(repository, boundary)) {
        facts.identity.repositoryRoot = boundary;
        if (boundary === filePath && directory) facts.identity.nestedRepository = true;
        facts.git = { state: 'not-applicable', index: 'not-applicable', workingTree: 'not-applicable', tracked: 'unknown', ignored: 'unknown', reason: { source: 'git', description: 'Git state belongs to a separate nested repository', path: boundary } };
        facts.changes = { immediate: emptyChangeSummary(), descendants: emptyChangeSummary() };
        break;
      }
    }
    if (kind === 'symlink') {
      facts.identity.symlink = 'unknown';
      try {
        const absolute = safeRepositoryPath(repository.public.path, filePath);
        const target = path.resolve(path.dirname(absolute), await readlink(absolute));
        const relative = path.relative(repository.public.path, target).split(path.sep).join('/');
        if (!relative) facts.identity.symlink = 'directory';
        else if (!relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative)) {
          const parent = path.posix.dirname(relative);
          await inspectDirectory(repository.public.path, parent === '.' ? '' : parent);
          const info = await lstat(safeRepositoryPath(repository.public.path, relative));
          facts.identity.symlink = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unknown';
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') facts.identity.symlink = 'broken'; }
    }
    return facts;
  }

  getProjectTreePreferences(id: string): ProjectTreePreferences { return this.repository(id).metadata.getPreferences(); }

  async setProjectTreePreferences(id: string, patch: Partial<ProjectTreePreferences>): Promise<ProjectTreePreferences> {
    const repository = this.repository(id);
    return repository.metadata.setPreferences(patch);
  }

  async markProjectDirectory(id: string, directoryId: string | null, marking: DirectoryMarking | null): Promise<void> {
    const repository = this.repository(id);
    const directory = directoryId === null ? undefined : this.projectEntry(repository, directoryId).public;
    if (directory && directory.kind !== 'directory') throw new Error('Only directories can be marked.');
    const filePath = directory?.path ?? '';
    await inspectDirectory(repository.public.path, filePath);
    if (filePath.split('/').some(part => part.toLowerCase() === '.git') || this.isInsideSubmodule(repository, filePath) || await this.nestedRepository(repository, filePath)) throw new Error('Git metadata and nested repositories cannot be marked here.');
    await repository.metadata.mark(filePath, marking);
    repository.generation++;
    if (repository.snapshot) repository.snapshot = { ...repository.snapshot, generation: repository.generation };
  }

  /** Search and project-tree classification share authoritative inclusion metadata. */
  async isSearchPathIncluded(id: string, filePath: string, directory = false): Promise<boolean> {
    const repository = this.repository(id);
    if (filePath.split('/').some(part => part.toLowerCase() === '.git') || this.isInsideSubmodule(repository, filePath)) return false;
    if (!await this.observeMetadata(repository, filePath, directory)) return false;
    return repository.metadata.classify(filePath, directory ? 'directory' : 'file').inclusion.state === 'included';
  }

  /** Search scopes are issued by the native picker, then revalidated before every scan. */
  async inspectSearchDirectory(id: string, relativePath: string): Promise<void> {
    const repository = this.repository(id);
    if (relativePath.split('/').some(part => part.toLowerCase() === '.git') || this.isInsideSubmodule(repository, relativePath)) throw new Error('Git metadata and submodule directories are excluded from search.');
    await inspectDirectory(repository.public.path, relativePath);
    if (!await this.isSearchPathIncluded(id, relativePath, true)) throw new Error('This directory is excluded from project search.');
  }

  /** Non-Git projects use a bounded lazy walk, without issuing tree capabilities. */
  async *iterateProjectSearchPaths(id: string, directory: string, signal: AbortSignal): AsyncGenerator<string> {
    const repository = this.repository(id);
    const pending = [directory];
    const seen = new Set<string>();
    let visited = 0;
    while (pending.length && !signal.aborted) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (!await this.isSearchPathIncluded(id, current, true)) {
        // Only explicitly included descendants are revisited, never all dependencies.
        if (await this.observeMetadata(repository, current, true)) pending.push(...repository.metadata.includedRootsBelow(current));
        continue;
      }
      let handle: Awaited<ReturnType<typeof opendir>> | undefined;
      try {
        const inspected = await inspectDirectory(repository.public.path, current);
        handle = await opendir(inspected.absolute, { bufferSize: 32 });
        while (!signal.aborted) {
          const child = await handle.read();
          if (!child) break;
          if (++visited > 100000) throw new Error('The project search enumeration limit was reached. Choose a smaller directory.');
          if (child.name.toLowerCase() === '.git' || child.isSymbolicLink()) continue;
          const relative = current ? `${current}/${child.name}` : child.name;
          if (child.isDirectory()) pending.push(relative);
          else if (child.isFile()) yield relative;
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      } finally { await handle?.close(); }
    }
  }

  /** Safe, bounded text-only reads without issuing an edit or UI capability per scanned file. */
  async readSearchFile(id: string, filePath: string): Promise<{ text: string; bytes: number } | null> {
    const repository = this.repository(id);
    if (!await this.isSearchPathIncluded(id, filePath)) return null;
    try {
      const inspected = await inspectWorkingPath(repository.public.path, filePath);
      if (inspected.size > this.maxFileBytes) return null;
      const data = await this.readEndpoint(repository.public.path, { kind: 'working', path: filePath }, inspected.fingerprint);
      const content = this.decodeContent(data);
      return content.kind === 'text' ? { text: content.text.text, bytes: data.length } : null;
    } catch (error) {
      // Unsupported files and files changing during a scan are ineligible. Real
      // repository/listing errors are reported by the search service itself.
      if (error instanceof FileProblem || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
  }

  /** Called only for backend-discovered matches, never with renderer-supplied paths. */
  async issueSearchResult(id: string, filePath: string): Promise<ProjectEntry | null> {
    const repository = this.repository(id);
    if (filePath.split('/').some(part => part.toLowerCase() === '.git') || this.isInsideSubmodule(repository, filePath)) throw new Error('This file cannot be opened.');
    try { await inspectWorkingPath(repository.public.path, filePath); }
    catch (error) {
      if (error instanceof FileProblem || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
    const previousId = repository.projectPaths.get(filePath);
    const previous = previousId ? repository.projectEntries.get(previousId)?.public : undefined;
    if (!previous && repository.projectEntries.size >= 100000) throw new Error('The project capability limit was reached. Restart the app to open more files.');
    const status = [...repository.changes.values()].find(change => change.path === filePath && (change.group === 'working' || change.group === 'untracked'))?.status;
    const entry: ProjectEntry = { id: previous?.id ?? randomUUID(), name: path.basename(filePath), path: filePath, kind: 'file', ...(status ? { status } : {}) };
    repository.projectPaths.set(filePath, entry.id);
    repository.projectEntries.set(entry.id, { public: entry });
    return { ...entry };
  }

  /** Read status without replacing the consumer's comparison capabilities. */
  async inspectRepositoryChanges(id: string): Promise<Array<Omit<GitChange, 'id'>>> {
    const root = this.repository(id).public.path;
    return parsePorcelainV2(await status(root)).flatMap(record => {
      safeRepositoryPath(root, record.path);
      if (record.oldPath) safeRepositoryPath(root, record.oldPath);
      return resolveEndpoints(record).map(item => ({ path: record.path, oldPath: record.oldPath, group: item.group, status: item.status, unsupported: item.unsupported }));
    });
  }

  /** Capture reviewed capabilities, never renderer-supplied paths, for a commit. */
  async captureCommitChanges(id: string, changeIds: string[]): Promise<{ changes: CapturedCommitChange[]; assertCurrent(): Promise<void> }> {
    const repository = this.repository(id);
    const captured = changeIds.map(changeId => {
      const change = repository.changes.get(changeId);
      if (!change) throw new Error('Selected files changed after review. Refresh and select the files again.');
      if (change.unsupported) throw new Error(`Cannot commit ${change.path}: ${messages[change.unsupported] ?? change.unsupported} Use Git externally for this file.`);
      return change;
    });
    const currentRecords = async () => {
      const records = parsePorcelainV2(await status(repository.public.path));
      const identities = new Map(comparisonRecords(records).map(({ record, endpoints }) =>
        [comparisonIdentity({ path: record.path, oldPath: record.oldPath, ...endpoints }), record] as const));
      const matched = [];
      for (const change of captured) {
        const record = identities.get(comparisonIdentity(change));
        const mode = record && (change.group === 'staged' ? record.indexMode : record.workMode);
        if (!record || mode !== change.modifiedMode || repository.changes.get(change.id) !== change) throw new Error(`Selected file changed after review: ${change.path}. Refresh and review the commit again.`);
        if (change.modified.kind === 'working' && (await inspectWorkingPath(repository.public.path, change.path)).fingerprint !== change.fingerprint) {
          throw new Error(`Selected file changed after review: ${change.path}. Refresh and review the commit again.`);
        }
        matched.push(record);
      }
      return matched;
    };
    const records = await currentRecords();
    const changes: CapturedCommitChange[] = [];
    let capturedBytes = 0;
    for (let i = 0; i < captured.length; i++) {
      const change = captured[i];
      const modified = change.modified;
      let mode = change.group === 'staged' ? records[i].indexMode : records[i].workMode;
      let contents: Buffer | undefined;
      if (modified.kind === 'working') {
        contents = await this.readEndpoint(repository.public.path, modified, change.fingerprint);
        capturedBytes += contents.length;
        if (capturedBytes > 128 * 1024 * 1024) throw new Error('The selected working files exceed the 128 MiB commit preview limit. Commit a smaller selection or use Git externally.');
        // Untracked files (including a recreated staged deletion) do not carry
        // executable mode information in porcelain. Capture the actual mode.
        if (change.group === 'untracked' || change.group === 'working') {
          const info = await lstat(safeRepositoryPath(repository.public.path, change.path));
          if (fingerprint(info) !== change.fingerprint) throw new Error(`Selected file changed while reading: ${change.path}. Refresh and review it again.`);
          mode = info.mode & 0o111 ? '100755' : '100644';
        }
      }
      if (modified.kind === 'empty') mode = '000000';
      if (!['000000', '100644', '100755'].includes(mode)) throw new Error(`Unsupported file mode for ${change.path}. Use Git externally for this file.`);
      changes.push({ id: change.id, path: change.path, group: change.group, mode,
        oldPath: records[i].kind === 'rename' && records[i].xy.includes('R') ? change.oldPath : undefined,
        oid: modified.kind === 'blob' ? modified.oid : undefined, contents });
    }
    await currentRecords();
    return { changes, assertCurrent: async () => { await currentRecords(); } };
  }

  async captureWorkingEndpoint(id: string, filePath: string): Promise<{ endpoint: Endpoint; fingerprint?: string; unsupported?: FileState }> {
    const root = this.repository(id).public.path;
    safeRepositoryPath(root, filePath);
    try {
      const inspected = await inspectWorkingPath(root, filePath);
      return { endpoint: { kind: 'working', path: filePath }, fingerprint: inspected.fingerprint };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { endpoint: { kind: 'empty' } };
      return { endpoint: { kind: 'working', path: filePath }, unsupported: error instanceof FileProblem ? error.state : 'unavailable' };
    }
  }

  async capturedEndpointMatchesBlob(id: string, endpoint: Endpoint, expectedFingerprint: string | undefined, oid: string): Promise<boolean> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error('Invalid Git blob identity.');
    try {
      const data = await this.readEndpoint(this.repository(id).public.path, endpoint, expectedFingerprint);
      return createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${data.length}\0`).update(data).digest('hex') === oid;
    } catch {
      // Unsupported/oversized/stale files stay listed and report their exact
      // state through readCapturedComparison, never disappear as unchanged.
      return false;
    }
  }

  async readCapturedComparison(id: string, changeId: string, filePath: string, original: Endpoint, modified: Endpoint, labels: [string, string], fingerprints: [string | undefined, string | undefined], unsupported?: FileState): Promise<FileComparison> {
    const repository = this.repository(id);
    if (original.kind === 'working' || modified.kind === 'working') this.trackWatchInterest(repository, filePath, 'file');
    const base = { repositoryId: id, changeId, generation: repository.generation, path: filePath, originalLabel: labels[0], modifiedLabel: labels[1] };
    if (unsupported) return { ...base, state: unsupported, message: messages[unsupported] ?? 'This comparison is unavailable. Refresh and try again.' };
    try {
      const [before, after] = await Promise.all([this.readEndpoint(repository.public.path, original, fingerprints[0]), this.readEndpoint(repository.public.path, modified, fingerprints[1])]);
      const contents = this.comparisonContents(original, modified, before, after, labels);
      if (contents.modified && modified.kind === 'working' && fingerprints[1]) await this.makeEditable(repository, modified.path, fingerprints[1], after, contents.modified);
      return { ...base, ...contents };
    } catch (error) {
      return { ...base, state: error instanceof FileProblem ? error.state : 'unavailable', message: error instanceof Error ? error.message : 'The comparison could not be read.' };
    }
  }

  getRepositoryWatchPaths(id: string): string[] {
    const repository = this.repository(id);
    // Watch changed-file parent directories without recursively entering .git/objects.
    const parents = [...repository.changes.values()].map(change => path.dirname(safeRepositoryPath(repository.public.path, change.path)));
    const interests = [...repository.watchInterests].reverse().map(([filePath, kind]) => kind === 'file' ? path.dirname(safeRepositoryPath(repository.public.path, filePath)) : filePath ? safeRepositoryPath(repository.public.path, filePath) : repository.public.path);
    return [...new Set([...repository.watchPaths, ...interests, ...parents])].slice(0, 512);
  }

  private trackWatchInterest(repository: StoredRepository, filePath: string, kind: 'file' | 'directory') {
    if (filePath) safeRepositoryPath(repository.public.path, filePath);
    repository.watchInterests.delete(filePath);
    repository.watchInterests.set(filePath, kind);
    // Recently opened files/directories receive priority. Inactive tabs are
    // read again on activation; there is no unbounded filesystem watch tree.
    if (repository.watchInterests.size > 512) repository.watchInterests.delete(repository.watchInterests.keys().next().value!);
  }

  /** Probe without replacing comparison capabilities or advancing generations.
   * Git status catches new changes outside watched directories; fingerprints
   * catch repeated edits that leave porcelain status unchanged, including open
   * ignored files. Never recurse into objects, logs, submodules, or symlinks.
   */
  async getRepositoryWatchState(id: string): Promise<RepositoryWatchState> {
    const repository = this.repository(id);
    const root = repository.public.path;
    const raw = repository.public.gitAvailable === false ? Buffer.alloc(0) : await status(root);
    const records = parsePorcelainV2(raw).filter(record => !record.path.endsWith('/'));
    const interests = [...repository.watchInterests].reverse();
    const files = [...new Set([...interests.filter(([, kind]) => kind === 'file').map(([name]) => name), ...records.map(record => record.path), '.gitignore', ...repository.metadata.getMetadataPaths().filter(name => name && name !== '.idea')])].slice(0, 2048).sort();
    const directoryPaths = new Set<string>(['']);
    const addParents = (relative: string) => {
      let current = relative;
      while (current && current !== '.') { directoryPaths.add(current); current = path.posix.dirname(current); }
    };
    for (const [name, kind] of interests) addParents(kind === 'directory' ? name : path.posix.dirname(name));
    for (const name of files) addParents(path.posix.dirname(name));
    const fingerprints: Record<string, string> = Object.create(null);
    const state: RepositoryWatchState = { signature: '', paths: [], fingerprints };
    const digest = createHash('sha256').update(raw);
    const observe = (kind: string, name: string, ...values: unknown[]) => {
      fingerprints[JSON.stringify([kind, name])] = JSON.stringify(values);
    };
    // Ignore provenance can change without changing porcelain status. Probe the
    // actual rule sources (including global/info excludes) independently.
    const ignoreSources = new Set(repository.ignoreSources);
    for (const ignored of repository.ignored.values()) if (ignored.rule) ignoreSources.add(path.resolve(root, ignored.rule.source));
    for (const metadataPath of repository.metadata.getMetadataPaths()) {
      const parent = metadataPath === '.idea' ? metadataPath : path.posix.dirname(metadataPath);
      ignoreSources.add(path.join(root, parent === '.' ? '' : parent, '.gitignore'));
    }
    for (const source of [...ignoreSources].sort()) {
      try { observe('ignore', source, fingerprint(await lstat(source)), fingerprint(await lstat(await realpath(source)))); }
      catch (error) { observe('ignore', source, (error as NodeJS.ErrnoException).code ?? 'unavailable'); }
    }
    if (repository.metadata.getMetadataPaths().includes('.idea')) directoryPaths.add('.idea');
    const failure = (error: unknown) => error instanceof FileProblem ? error.state : (error as NodeJS.ErrnoException).code ?? 'unavailable';
    for (const directory of repository.watchPaths.filter(directory => directory !== root)) {
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) continue;
        state.paths.push({ path: directory, identity: `${info.dev}:${info.ino}`, kind: 'git' });
        for (const name of ['HEAD', 'index', 'packed-refs', 'config', 'shallow']) {
          try { digest.update(JSON.stringify([directory, name, fingerprint(await lstat(path.join(directory, name)))])); }
          catch (error) { digest.update(JSON.stringify([directory, name, failure(error)])); }
        }
      } catch (error) { digest.update(JSON.stringify([directory, failure(error)])); }
    }
    const directories = [...directoryPaths].slice(0, 512 - state.paths.length).sort();
    for (const name of directories) {
      if (name.split('/').some(part => part.toLowerCase() === '.git') || this.isInsideSubmodule(repository, name)) continue;
      try {
        const directory = await inspectDirectory(root, name);
        state.paths.push({ path: directory.absolute, identity: directory.fingerprint.split(':').slice(0, 2).join(':'), kind: 'working' });
        observe('directory', name, directory.fingerprint);
      } catch (error) { observe('directory', name, failure(error)); }
    }
    // Bound concurrent filesystem work even for repositories with many changes.
    for (let offset = 0; offset < files.length; offset += 16) {
      const batch = await Promise.all(files.slice(offset, offset + 16).map(async name => {
        if (name.split('/').some(part => part.toLowerCase() === '.git') || this.isInsideSubmodule(repository, name)) return [name, 'unsupported'];
        try { return [name, (await inspectWorkingPath(root, name)).fingerprint]; }
        catch (error) { return [name, failure(error)]; }
      }));
      for (const [name, value] of batch) observe('file', name, value);
    }
    // Watching another directory is not a repository mutation. Keep the global
    // signature separate so newly discovered metadata/files can be baselined
    // without refreshing every expanded folder and invalidating pending reads.
    state.baseSignature = digest.digest('hex');
    state.signature = createHash('sha256').update(state.baseSignature).update(JSON.stringify(Object.entries(fingerprints).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
    return state;
  }

  async listChanges(id: string): Promise<RepositorySnapshot> {
    return this.repository(id).snapshot ?? this.refreshRepository(id);
  }

  private projectEntry(repository: StoredRepository, id: string): StoredProjectEntry {
    if (typeof id !== 'string') throw new Error('Invalid project entry identifier.');
    const entry = repository.projectEntries.get(id);
    if (!entry) throw new Error('Unknown project entry. Refresh the project and select the entry again.');
    return entry;
  }

  private isInsideSubmodule(repository: StoredRepository, filePath: string): boolean {
    return [...repository.submodules].some(directory => filePath === directory || filePath.startsWith(`${directory}/`));
  }

  /** Resolve an issued UI capability to its current working file, never a blob. */
  async resolveFileActionTarget(id: string, target: FileActionTarget): Promise<ResolvedFileActionTarget> {
    const repository = this.repository(id);
    if (!target || typeof target !== 'object' || !['project', 'change'].includes(target.kind) || typeof target.id !== 'string') throw new Error('Invalid file action target.');
    const project = target.kind === 'project' ? this.projectEntry(repository, target.id).public : undefined;
    const change = target.kind === 'change' ? repository.changes.get(target.id) : undefined;
    if (!project && !change) throw new Error('This change is no longer current. Refresh and open its menu again.');
    const filePath = (project ?? change)!.path;
    const base = { path: filePath, absolutePath: safeRepositoryPath(repository.public.path, filePath) };
    if (filePath.split('/').some(part => part.toLowerCase() === '.git') || this.isInsideSubmodule(repository, filePath)) return { ...base, unavailableReason: 'Git metadata and submodule contents cannot be opened here.' };
    if (project && project.kind !== 'file') return { ...base, unavailableReason: project.kind === 'symlink' ? messages.symlink : 'Select a regular file to open its source.' };
    try {
      const inspected = await inspectWorkingPath(repository.public.path, filePath);
      if (change && (repository.changes.get(target.id) !== change || (change.fingerprint && change.fingerprint !== inspected.fingerprint))) return { ...base, unavailableReason: 'This file changed after the comparison snapshot. Refresh and open its menu again.' };
      let source = project;
      if (!source) {
        const previousId = repository.projectPaths.get(filePath);
        const previous = previousId ? repository.projectEntries.get(previousId)?.public : undefined;
        if (!previous && repository.projectEntries.size >= 100000) return { ...base, unavailableReason: 'The project capability limit was reached. Restart the app to open more files.' };
        source = { id: previous?.id ?? randomUUID(), name: path.basename(filePath), path: filePath, kind: 'file', ...(change?.status ? { status: change.status } : {}) };
        repository.projectPaths.set(filePath, source.id);
        repository.projectEntries.set(source.id, { public: source });
      }
      return { ...base, source: { ...source }, fingerprint: inspected.fingerprint };
    } catch (error) {
      return { ...base, unavailableReason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'The working-tree file does not exist. Its path can still be copied.' : error instanceof Error ? error.message : 'This working-tree file is unavailable.' };
    }
  }

  async listProjectDirectory(id: string, directoryId: string | null): Promise<ProjectDirectory> {
    const repository = this.repository(id);
    const directory = directoryId === null ? undefined : this.projectEntry(repository, directoryId);
    if (directory && directory.public.kind !== 'directory') throw new Error('This project entry is not a browsable directory.');
    const directoryPath = directory?.public.path ?? '';
    if (this.isInsideSubmodule(repository, directoryPath)) throw new Error('Submodule directories are not browsed by this viewer.');
    const generation = repository.generation;
    if (!await this.observeMetadata(repository, directoryPath, true)) throw new Error('Nested repository directories belong to a separate project.');
    const inspected = await inspectDirectory(repository.public.path, directoryPath);
    this.trackWatchInterest(repository, directoryPath, 'directory');
    const statuses = new Map<string, { status: string; rank: number }>();
    const prefix = directoryPath ? `${directoryPath}/` : '';
    for (const change of repository.changes.values()) {
      if (!change.path.startsWith(prefix)) continue;
      const name = change.path.slice(prefix.length).split('/')[0];
      const rank = change.status === 'U' ? 4 : change.group === 'working' ? 3 : change.group === 'unstaged' ? 2 : change.group === 'staged' ? 1 : 0;
      if (!statuses.has(name) || statuses.get(name)!.rank < rank) statuses.set(name, { status: change.status, rank });
    }
    const handle = await opendir(inspected.absolute, { bufferSize: 32 });
    const entries: StoredProjectEntry[] = [];
    let truncated = false;
    try {
      if ((await inspectDirectory(repository.public.path, directoryPath)).fingerprint !== inspected.fingerprint) throw new FileProblem('stale', 'The directory changed while opening. Refresh the project.');
      listing: while (true) {
        // Keep filesystem identity checks, but do not pay one serial filesystem
        // round trip per child. The bound also avoids flooding the I/O queue when
        // a dependency directory contains thousands of immediate entries.
        const children: Dirent[] = [];
        const batchSize = Math.min(16, Math.max(1, this.maxDirectoryEntries - entries.length));
        while (children.length < batchSize) {
          const child = await handle.read();
          if (!child) break;
          if (child.name.toLowerCase() !== '.git') children.push(child);
        }
        if (!children.length) break;
        if (entries.length >= this.maxDirectoryEntries) { truncated = true; break; }
        const inspectedChildren = await Promise.all(children.map(async child => {
          const filePath = directoryPath ? `${directoryPath}/${child.name}` : child.name;
          const absolute = safeRepositoryPath(repository.public.path, filePath);
          let info: Awaited<ReturnType<typeof lstat>> | undefined;
          try { info = await lstat(absolute); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; }
          return { child, filePath, info };
        }));
        for (const inspectedChild of inspectedChildren) {
          if (!inspectedChild) continue;
          const { child, filePath, info } = inspectedChild;
          const identity = info ?? child;
          const kind: ProjectEntry['kind'] = identity.isSymbolicLink() ? 'symlink' : repository.submodules.has(filePath) ? 'submodule' : identity.isDirectory() ? 'directory' : 'file';
          const existingId = repository.projectPaths.get(filePath);
          const existing = existingId ? repository.projectEntries.get(existingId) : undefined;
          // Cap issued capabilities as well as each listing. Old paths are not trusted
          // if they reappear: all file accesses recheck the current identity below.
          if (!existing && repository.projectEntries.size + entries.length >= 100000) { truncated = true; break listing; }
          const state = statuses.get(child.name)?.status;
          entries.push({
            ...(!info ? { unavailable: true } : {}),
            public: { id: existing?.public.id ?? randomUUID(), name: child.name, path: filePath, kind, ...(state ? { status: state } : {}) },
          });
        }
      }
      // Do not release paths or capabilities from a replaced/escaped directory.
      if ((await inspectDirectory(repository.public.path, directoryPath)).fingerprint !== inspected.fingerprint) throw new FileProblem('stale', 'The directory changed while listing. Refresh the project.');
    } finally { await handle.close(); }
    await this.ignoreFacts(repository, [{ path: directoryPath, directory: true }, ...entries.map(entry => ({ path: entry.public.path, directory: entry.public.kind === 'directory' || entry.public.kind === 'submodule' }))]);
    const facts = await this.factsFor(repository, directoryPath, 'directory');
    // Bounded batches; never enumerate descendants to decorate a directory.
    for (let offset = 0; offset < entries.length; offset += 16) await Promise.all(entries.slice(offset, offset + 16).map(async entry => { entry.public.facts = await this.factsFor(repository, entry.public.path, entry.unavailable ? 'unavailable' : entry.public.kind); }));
    if (generation !== repository.generation) throw new FileProblem('stale', 'Project state changed while listing. Refresh the project.');
    entries.sort((a, b) => {
      const folder = (entry: StoredProjectEntry) => entry.public.kind === 'directory' || entry.public.kind === 'submodule' ? 0 : 1;
      return folder(a) - folder(b) || a.public.name.localeCompare(b.public.name, 'en', { numeric: true });
    });
    for (const entry of entries) {
      repository.projectEntries.set(entry.public.id, entry);
      repository.projectPaths.set(entry.public.path, entry.public.id);
    }
    return { repositoryId: id, directoryId, generation, facts, path: directoryPath, entries: entries.map(entry => ({ ...entry.public })), truncated };
  }

  private async markdownResourcePath(id: string, entryId: string, href: string): Promise<string> {
    const source = this.projectEntry(this.repository(id), entryId).public;
    if (source.kind !== 'file' || (await this.inspectTreeActionPath(id, source.path)).kind !== 'file') throw new Error('The Markdown source file is no longer available.');
    const resolved = markdownProjectPath(source.path, href);
    if ((await this.inspectTreeActionPath(id, resolved)).kind !== 'file') throw new Error('The Markdown resource is not an available project file.');
    return resolved;
  }

  async readMarkdownImage(id: string, entryId: string, href: string): Promise<MarkdownImage> {
    const filePath = await this.markdownResourcePath(id, entryId, href);
    const root = this.repository(id).public.path;
    const inspected = await inspectWorkingPath(root, filePath);
    const limit = Math.min(MAX_MARKDOWN_IMAGE_BYTES, this.maxPreviewBytes);
    if (inspected.size > limit) throw this.oversized(inspected.size, limit, 'Markdown image');
    const bytes = await this.readEndpoint(root, { kind: 'working', path: filePath }, inspected.fingerprint);
    const probe = sniffMedia(bytes);
    if (!probe || !('format' in probe) || probe.format.kind !== 'image') throw new Error(probe && 'unsupported' in probe ? probe.unsupported : 'This Markdown resource is not a supported image.');
    return { mimeType: probe.format.mimeType, base64: bytes.toString('base64'), bytes: bytes.length };
  }

  async resolveMarkdownLink(id: string, entryId: string, href: string): Promise<ProjectEntry> {
    const filePath = await this.markdownResourcePath(id, entryId, href);
    // Issue an ordinary file capability so linked files follow the existing
    // editor/read/save lifecycle rather than exposing a filesystem URL.
    return this.issueTreeActionEntry(id, filePath);
  }

  async readProjectFile(id: string, entryId: string): Promise<ProjectFile> {
    const repository = this.repository(id);
    const entry = this.projectEntry(repository, entryId);
    await this.ignoreFacts(repository, [{ path: entry.public.path, directory: entry.public.kind === 'directory' }]);
    const facts = await this.factsFor(repository, entry.public.path, entry.public.kind);
    const base = { repositoryId: id, entryId, path: entry.public.path, facts };
    if (this.isInsideSubmodule(repository, entry.public.path)) return { ...base, state: 'submodule', message: messages.submodule };
    if (facts.identity.repositoryRoot) return { ...base, state: 'unavailable', message: 'Open the nested repository as a separate project to view its files.' };
    if (entry.public.kind === 'directory') return { ...base, state: 'unavailable', message: 'Select a file to view its contents.' };
    if (entry.public.kind === 'symlink' || entry.public.kind === 'submodule') return { ...base, state: entry.public.kind, message: messages[entry.public.kind] };
    this.trackWatchInterest(repository, entry.public.path, 'file');
    try {
      // Project view reads the current working file, including clean and ignored
      // files, independently of Commit's captured index/HEAD comparisons.
      const inspected = await inspectWorkingPath(repository.public.path, entry.public.path);
      const data = await this.readEndpoint(repository.public.path, { kind: 'working', path: entry.public.path }, inspected.fingerprint);
      const content = this.decodeContent(data);
      if (content.kind === 'media') return { ...base, state: 'media', media: { label: 'Working tree', ...content.media } };
      const side: ComparisonSide = { label: 'Working tree', ...content.text };
      await this.makeEditable(repository, entry.public.path, inspected.fingerprint, data, side);
      return { ...base, state: 'text', content: side };
    } catch (error) {
      return { ...base, state: error instanceof FileProblem ? error.state : 'unavailable', message: error instanceof Error ? error.message : 'The file could not be read. Refresh the project.' };
    }
  }

  private async makeEditable(repository: StoredRepository, filePath: string, expectedFingerprint: string, data: Buffer, content: ComparisonSide): Promise<void> {
    if (repository.savingPaths.has(filePath)) throw new FileProblem('stale', 'A save is in progress for this file. Reload it after the save finishes.');
    if (content.metadata.lineEnding === 'mixed') {
      content.readOnlyReason = 'Mixed line endings are read-only to preserve the original file bytes.';
      return;
    }
    if (filePath.split('/').some(part => part.toLowerCase() === '.git') || this.isInsideSubmodule(repository, filePath)) {
      content.readOnlyReason = 'Git metadata and submodule contents cannot be edited here.';
      return;
    }
    const inspected = await inspectWorkingPath(repository.public.path, filePath);
    if (inspected.fingerprint !== expectedFingerprint) throw new FileProblem('stale', 'The file changed while preparing the editor. Reload it before editing.');
    const info = await lstat(inspected.absolute);
    // A save may begin during either awaited inspection. Do not replace its
    // capability with a token for bytes observed partway through that save.
    if (repository.savingPaths.has(filePath)) throw new FileProblem('stale', 'A save is in progress for this file. Reload it after the save finishes.');
    if (fingerprint(info) !== expectedFingerprint) throw new FileProblem('stale', 'The file changed while preparing the editor. Reload it before editing.');
    if (info.nlink !== 1) {
      content.readOnlyReason = 'Files with multiple hard links are read-only to avoid changing another path.';
      return;
    }
    const version = hash(data);
    const previousId = repository.editPaths.get(filePath);
    const previous = previousId ? repository.edits.get(previousId) : undefined;
    if (previous?.version === version && previous.fingerprint === expectedFingerprint) {
      content.editable = { id: previous.id, version };
      return;
    }
    if (previous) repository.edits.delete(previous.id);
    if (repository.edits.size >= 10000) {
      content.readOnlyReason = 'The session has reached its open-file editing limit. Restart the app to edit more files.';
      return;
    }
    const edit: StoredEdit = { id: randomUUID(), path: filePath, version, fingerprint: expectedFingerprint, metadata: { ...content.metadata }, lineEnding: content.metadata.lineEnding === 'CRLF' || content.metadata.lineEnding === 'CR' ? content.metadata.lineEnding : 'LF' };
    repository.edits.set(edit.id, edit);
    repository.editPaths.set(filePath, edit.id);
    content.editable = { id: edit.id, version };
  }

  /** Save only to a working file identified by a capability from a successful read. */
  async saveText(id: string, editId: string, version: string, text: string): Promise<SaveTextResult> {
    const repository = this.repository(id);
    if (typeof editId !== 'string' || typeof version !== 'string' || typeof text !== 'string') throw new Error('Invalid save payload.');
    const edit = repository.edits.get(editId);
    const base = { repositoryId: id, path: edit?.path ?? '' };
    if (!edit || edit.version !== version) return { ...base, state: 'stale', message: 'This editing version is no longer current. Reload the file before saving.' };
    if (repository.savingPaths.has(edit.path)) return { ...base, state: 'stale', message: 'A save is already in progress for this file.' };
    if (text.length > this.maxFileBytes) return { ...base, state: 'oversized', message: `The edited text exceeds the ${this.maxFileBytes.toLocaleString()} byte limit.` };
    if (text.includes('\0')) return { ...base, state: 'encoding', message: 'Text files cannot contain NUL characters.' };
    const separator = edit.lineEnding === 'CRLF' ? '\r\n' : edit.lineEnding === 'CR' ? '\r' : '\n';
    // Monaco normalizes its model EOL. Restore the original uniform EOL style;
    // the submitted text deliberately determines whether a final newline exists.
    const normalized = text.replace(/\r\n|\r|\n/g, separator);
    const encodedSize = Buffer.byteLength(normalized, 'utf8') + (edit.metadata.encoding === 'utf-8-bom' ? 3 : 0);
    if (encodedSize > this.maxFileBytes) return { ...base, state: 'oversized', message: `The edited text exceeds the ${this.maxFileBytes.toLocaleString()} byte limit.` };
    const encoded = Buffer.from(normalized, 'utf8');
    if (encoded.toString('utf8') !== normalized) return { ...base, state: 'encoding', message: 'The edited text contains an invalid Unicode surrogate.' };
    const data = edit.metadata.encoding === 'utf-8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]) : encoded;
    repository.savingPaths.add(edit.path);
    try {
      if (edit.path.split('/').some(part => part.toLowerCase() === '.git') || this.isInsideSubmodule(repository, edit.path)) throw new FileProblem('unavailable', 'Git metadata and submodule contents cannot be edited here.');
      const inspected = await inspectWorkingPath(repository.public.path, edit.path);
      if (inspected.fingerprint !== edit.fingerprint) throw new FileProblem('stale', 'This file was changed outside the editor. Reload it before saving.');
      const file = await open(inspected.absolute, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || fingerprint(before) !== edit.fingerprint) throw new FileProblem('stale', 'The file identity changed. Reload it before saving.');
        const existing = Buffer.alloc(before.size + 1);
        let offset = 0;
        while (offset < existing.length) {
          const read = await file.read(existing, offset, existing.length - offset, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        const current = await inspectWorkingPath(repository.public.path, edit.path);
        if (offset !== before.size || hash(existing.subarray(0, offset)) !== edit.version || fingerprint(await file.stat()) !== edit.fingerprint || current.fingerprint !== edit.fingerprint || repository.edits.get(editId) !== edit) throw new FileProblem('stale', 'This file changed before saving. Reload it before saving your edits.');
        // Writing through the verified descriptor never follows a replaced path
        // or symlink. Preserve permissions and truncate only after all bytes write.
        offset = 0;
        while (offset < data.length) {
          const written = await file.write(data, offset, data.length - offset, offset);
          if (!written.bytesWritten) throw new Error('The filesystem did not accept the file contents.');
          offset += written.bytesWritten;
        }
        await file.truncate(data.length);
        await file.sync();
        const after = await file.stat();
        const saved = await inspectWorkingPath(repository.public.path, edit.path);
        if (saved.fingerprint !== fingerprint(after) || after.dev !== before.dev || after.ino !== before.ino) throw new FileProblem('stale', 'The file path changed during the save. Reload it to inspect the current contents.');
        const content: ComparisonSide = { label: 'Working tree', ...decodeText(data), editable: { id: edit.id, version: hash(data) } };
        edit.version = content.editable!.version;
        edit.fingerprint = saved.fingerprint;
        edit.metadata = { ...content.metadata };
        return { ...base, state: 'saved', content };
      } finally { await file.close(); }
    } catch (error) {
      const state: SaveTextResult['state'] = error instanceof FileProblem && ['stale', 'unavailable', 'symlink', 'oversized', 'encoding'].includes(error.state) ? error.state as SaveTextResult['state'] : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'error';
      return { ...base, state, message: error instanceof Error ? error.message : 'The file could not be saved. Your editor contents have been kept.' };
    } finally { repository.savingPaths.delete(edit.path); }
  }

  async refreshRepository(id: string, options: { deferUntracked?: boolean } = {}): Promise<RepositorySnapshot> {
    return this.scanRepository(id, !options.deferUntracked || this.repository(id).public.gitAvailable === false);
  }

  private async scanRepository(id: string, includeUntracked: boolean): Promise<RepositorySnapshot> {
    const repository = this.repository(id);
    const sequence = ++repository.refreshSequence;
    const beforeIdentity = repository.public.gitAvailable === false ? undefined : await this.comparisonGitIdentity(repository);
    const [raw, index, excludes] = await Promise.all([
      repository.public.gitAvailable === false ? Buffer.alloc(0) : status(repository.public.path, includeUntracked),
      repository.public.gitAvailable === false ? { tracked: new Set<string>(), submodules: new Set<string>() } : readGitIndex(repository.public.path),
      repository.public.gitAvailable === false ? Buffer.alloc(0) : runGit(repository.public.path, ['config', '--path', '--get', 'core.excludesFile'], 32768, { allowedExitCodes: [1] }),
    ]);
    let records: StatusRecord[];
    try { records = parsePorcelainV2(raw).filter(record => !record.path.endsWith('/')); }
    catch (error) { throw new Error(`Could not read Git status (filenames must be valid UTF-8): ${String(error)}`); }
    if (!includeUntracked) {
      // An index deletion can have a recreated, untracked working file at the
      // same path. It belongs to the tracked comparison, so resolve these few
      // exact paths before publishing instead of temporarily showing a deletion.
      const recreated: string[] = [];
      for (const record of records) {
        if (record.indexMode !== '000000' || record.workMode !== '000000' || record.kind === 'conflict') continue;
        try { await inspectWorkingPath(repository.public.path, record.path); recreated.push(record.path); }
        catch (error) { if (error instanceof FileProblem && error.state === 'symlink') recreated.push(record.path); }
      }
      for (let offset = 0; offset < recreated.length; offset += 100) {
        const paths = recreated.slice(offset, offset + 100);
        const scoped = await safeWorkingGit(repository.public.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--', ...paths.map(filePath => `:(top,literal)${filePath}`)]);
        records.push(...parsePorcelainV2(scoped).filter(record => record.kind === 'untracked' && paths.includes(record.path)));
      }
    }
    const afterIdentity = repository.public.gitAvailable === false ? undefined : await this.comparisonGitIdentity(repository);
    const gitIdentity = beforeIdentity === afterIdentity ? afterIdentity : undefined;
    const projectGit = projectGitSnapshot(records, index.tracked);
    // Index paths were validated while streaming; changed paths are checked below.
    await repository.metadata.refresh(this.metadataIo(repository));
    const nextChanges = new Map<string, StoredChange>();
    const previousChanges = new Map([...repository.changes.values()].map(change => [comparisonIdentity(change), change]));
    const workingPaths = new Map<string, { inspected?: Awaited<ReturnType<typeof inspectWorkingPath>>; problem?: FileState }>();
    for (const { record, endpoints: endpointsForGroup } of comparisonRecords(records)) {
      safeRepositoryPath(repository.public.path, record.path);
      if (record.oldPath !== undefined) safeRepositoryPath(repository.public.path, record.oldPath);
      if (endpointsForGroup.modified.kind === 'working' && !endpointsForGroup.unsupported && !workingPaths.has(record.path)) {
        try { workingPaths.set(record.path, { inspected: await inspectWorkingPath(repository.public.path, record.path) }); }
        catch (error) { workingPaths.set(record.path, { problem: error instanceof FileProblem ? error.state : 'unavailable' }); }
      }
      const change: StoredChange = { id: randomUUID(), gitIdentity, path: record.path, ...(record.oldPath !== undefined ? { oldPath: record.oldPath } : {}), ...endpointsForGroup, modifiedMode: endpointsForGroup.group === 'staged' ? record.indexMode : record.workMode };
      if (change.modified.kind === 'working') {
        const workingPath = workingPaths.get(record.path);
        if (workingPath?.inspected) change.fingerprint = workingPath.inspected.fingerprint;
        else change.unsupported ??= workingPath?.problem;
      }
      // A focus/poll refresh must not revoke capabilities or invalidate an
      // in-flight read when this comparison's endpoints have not changed.
      const previous = previousChanges.get(comparisonIdentity(change));
      const current = previous?.fingerprint === change.fingerprint && previous?.modifiedMode === change.modifiedMode ? previous : undefined;
      if (current) current.gitIdentity = gitIdentity;
      nextChanges.set(current?.id ?? change.id, current ?? change);
    }
    // A slower refresh cannot overwrite a newer request's snapshot.
    if (sequence !== repository.refreshSequence) {
      // Reopening can publish a newer tracked-only snapshot while an old full
      // scan finishes. A caller awaiting complete discovery must not mistake
      // that partial snapshot for completion and leave untracked files pending.
      return !repository.snapshot || includeUntracked && repository.snapshot.untrackedPending
        ? this.refreshRepository(id) : repository.snapshot;
    }
    repository.generation++;
    repository.statusHash = hash(raw);
    repository.changes = nextChanges;
    // Clean gitlinks do not appear in status; retain boundaries from the index.
    repository.submodules = index.submodules;
    repository.projectGit = projectGit;
    repository.ignored.clear();
    const configuredExcludes = stripLastNewline(excludes);
    repository.ignoreSources = new Set(repository.public.gitAvailable === false ? [] : [
      ...repository.watchPaths.filter(directory => directory !== repository.public.path).map(directory => path.join(directory, 'info', 'exclude')),
      configuredExcludes ? path.resolve(repository.public.path, configuredExcludes) : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'ignore'),
    ]);
    repository.metadataObserved.clear();
    repository.nestedRepositories.clear();
    const publicChanges: GitChange[] = [...nextChanges.values()].map(({ id: changeId, path: filePath, oldPath, group, status: changeStatus, unsupported }) => ({ id: changeId, path: filePath, ...(oldPath !== undefined ? { oldPath } : {}), group, status: changeStatus, ...(unsupported ? { unsupported } : {}) }));
    const trackedPaths = new Set(publicChanges.filter(change => change.group === 'working').map(change => change.path));
    const stagedByPath = new Map(publicChanges.filter(change => change.group === 'staged').map(change => [change.path, change]));
    const workingChanges = publicChanges.filter(change => change.group === 'working' || change.group === 'untracked' && !trackedPaths.has(change.path)).map(change => {
      const stored = nextChanges.get(change.id)!;
      const staged = stagedByPath.get(change.path);
      // A staged addition deleted on disk (AD) exists only in the index.
      // HEAD → working would compare two absent files and hide its contents.
      // Use the actual staged capability so labels, read-only state and commit
      // capture all refer to the same reviewed index blob.
      return stored.original.kind === 'empty' && stored.modified.kind === 'empty' && !stored.unsupported && staged
        ? staged : change;
    });
    repository.snapshot = {
      repository: { ...repository.public }, generation: repository.generation,
      ...(!includeUntracked ? { untrackedPending: true } : {}),
      changes: publicChanges.filter(change => change.group !== 'working'),
      workingChanges,
    };
    return repository.snapshot;
  }

  private async readEndpoint(root: string, endpoint: Endpoint, expectedFingerprint?: string): Promise<Buffer> {
    const readLimit = Math.max(this.maxFileBytes, this.maxPreviewBytes);
    if (endpoint.kind === 'empty') return Buffer.alloc(0);
    if (endpoint.kind === 'blob') {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(endpoint.oid)) throw new FileProblem('unavailable', 'Invalid Git object identifier.');
      const size = Number(stripLastNewline(await runGit(root, ['cat-file', '-s', endpoint.oid], 100)));
      if (!Number.isSafeInteger(size) || size < 0) throw new FileProblem('unavailable', 'Git returned an invalid object size.');
      if (size > readLimit) throw this.oversized(size, readLimit, 'file preview');
      const data = await runGit(root, ['cat-file', 'blob', endpoint.oid], readLimit);
      if (data.length !== size) throw new FileProblem('unavailable', 'The Git blob size did not match its contents. Refresh and try again.');
      return data;
    }
    const inspected = await inspectWorkingPath(root, endpoint.path);
    if (!expectedFingerprint || expectedFingerprint !== inspected.fingerprint) throw new FileProblem('stale', 'The file changed after this snapshot. Refresh to load the current contents.');
    if (inspected.size > readLimit) throw this.oversized(inspected.size, readLimit, 'file preview');
    const file = await open(inspected.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || fingerprint(before) !== inspected.fingerprint) throw new FileProblem('stale', 'The file changed while opening. Refresh and try again.');
      // Bounded read prevents a concurrent growing file from bypassing the limit.
      const data = Buffer.alloc(Math.min(before.size + 1, readLimit + 1));
      let offset = 0;
      while (offset < data.length) {
        const result = await file.read(data, offset, data.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const after = await file.stat();
      const current = await inspectWorkingPath(root, endpoint.path);
      if (fingerprint(before) !== fingerprint(after) || current.fingerprint !== inspected.fingerprint || offset !== before.size) throw new FileProblem('stale', 'The file changed while reading. Refresh and try again.');
      return data.subarray(0, offset);
    } finally { await file.close(); }
  }

  private oversized(bytes: number, limit = this.maxFileBytes, kind = 'text'): FileProblem {
    return new FileProblem('oversized', `This file is ${bytes.toLocaleString()} bytes; the ${kind} limit is ${limit.toLocaleString()} bytes. The file has not been truncated.`);
  }

  private decodeContent(data: Buffer): { kind: 'text'; text: Omit<ComparisonSide, 'label'> } | { kind: 'media'; media: MediaContent } {
    const probe = sniffMedia(data);
    if (probe && 'unsupported' in probe) throw new FileProblem('binary', probe.unsupported);
    if (probe && 'format' in probe) {
      if (data.length > this.maxPreviewBytes) throw this.oversized(data.length, this.maxPreviewBytes, 'media preview');
      return { kind: 'media', media: mediaContent(data, probe.format) };
    }
    if (data.length > this.maxFileBytes) throw this.oversized(data.length);
    return { kind: 'text', text: decodeText(data) };
  }

  private comparisonContents(original: Endpoint, modified: Endpoint, before: Buffer, after: Buffer, labels: [string, string]): Pick<FileComparison, 'state' | 'changeType' | 'original' | 'modified' | 'originalMedia' | 'modifiedMedia'> {
    const left = this.decodeContent(before);
    const right = this.decodeContent(after);
    const changeType = original.kind === 'empty' && modified.kind !== 'empty' ? 'added'
      : modified.kind === 'empty' && original.kind !== 'empty' ? 'deleted' : 'modified';
    if (left.kind === 'media' || right.kind === 'media') {
      // Only an explicit empty endpoint is absent. An existing zero-byte text
      // file must not silently disappear from an image/audio/video comparison.
      if ((left.kind === 'text' && original.kind !== 'empty') || (right.kind === 'text' && modified.kind !== 'empty') || (left.kind === 'media' && right.kind === 'media' && left.media.kind !== right.media.kind)) {
        throw new FileProblem('type-change', 'The comparison contains incompatible content types (text, image, audio, or video). A mixed-content preview is not supported.');
      }
      return { state: 'media', changeType, ...(left.kind === 'media' ? { originalMedia: { label: labels[0], ...left.media } } : {}), ...(right.kind === 'media' ? { modifiedMedia: { label: labels[1], ...right.media } } : {}) };
    }
    return { state: 'text', changeType, original: { label: labels[0], ...left.text }, modified: { label: labels[1], ...right.text } };
  }

  /** Endpoint identities come from the published status snapshot. A matching HEAD
   * and index identity means they still name exactly the same immutable blobs.
   * Reading HEAD through Git also supports worktrees, packed refs and reftables;
   * it never refreshes/parses the index or walks the working tree. */
  private async comparisonGitIdentity(repository: StoredRepository): Promise<string> {
    const indexPath = path.join(repository.gitDirectory, 'index');
    const [head, index] = await Promise.all([
      runGit(repository.public.path, ['rev-parse', '--verify', '--quiet', 'HEAD'], 100, { allowedExitCodes: [1] }),
      (async () => {
        try {
          const info = await lstat(indexPath);
          return info.isSymbolicLink() ? [fingerprint(info), fingerprint(await lstat(await realpath(indexPath)))] : [fingerprint(info)];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ['missing'];
          throw error;
        }
      })(),
    ]);
    return JSON.stringify([stripLastNewline(head), index]);
  }

  async readComparison(id: string, changeId: string): Promise<FileComparison> {
    const repository = this.repository(id);
    if (typeof changeId !== 'string') throw new Error('Invalid comparison identifier.');
    const change = repository.changes.get(changeId);
    const base = { repositoryId: id, changeId, generation: repository.generation, path: change?.path ?? '' };
    if (!change) return { ...base, state: 'stale', message: 'This comparison belongs to an older snapshot. Refresh and select the file again.' };
    this.trackWatchInterest(repository, change.path, 'file');
    if (change.unsupported) return { ...base, state: change.unsupported, message: messages[change.unsupported] ?? 'The file is unavailable. Refresh the repository and try again.' };
    const isCurrent = async () => {
      // Most reads need only a cheap HEAD/index check plus the selected file's
      // fingerprint. Re-running status twice used to launch 20+ subprocesses and
      // parse the entire index, even for a tiny file. If Git moved, fall back to
      // its literal-path porcelain authority; unrelated staging remains valid.
      // Ignore rules can change without changing HEAD/index. Query Git's actual
      // ignore authority for untracked paths; check-ignore cannot execute clean
      // filters or hooks, so it needs no status facade (like the Project tree).
      const [gitIdentity, ignoreOutput] = await Promise.all([
        this.comparisonGitIdentity(repository),
        change.group === 'untracked' ? runGit(repository.public.path, ['check-ignore', '--verbose', '--non-matching', '-z', '--stdin'], 4 * 1024 * 1024,
          { input: Buffer.from(`${change.path}\0`), allowedExitCodes: [1] }) : undefined,
      ]);
      if (ignoreOutput && parseIgnoreFacts(ignoreOutput).get(change.path)?.ignored !== false) return false;
      if (!change.gitIdentity || change.gitIdentity !== gitIdentity) {
        const matches = comparisonRecords(parsePorcelainV2(await comparisonStatus(repository.public.path, change))).some(({ record, endpoints }) => record.path === change.path && (change.group === 'staged' ? record.indexMode : record.workMode) === change.modifiedMode &&
          endpoints.group === change.group && comparisonIdentity({ path: record.path, oldPath: record.oldPath, ...endpoints }) === comparisonIdentity(change));
        if (!matches) return false;
        // A race during status must not install a fast-path identity for a
        // different index. The next read can validate through status again.
        if (gitIdentity === await this.comparisonGitIdentity(repository)) change.gitIdentity = gitIdentity;
      }
      if (change.modified.kind === 'working' && (await inspectWorkingPath(repository.public.path, change.modified.path)).fingerprint !== change.fingerprint) return false;
      if (change.modified.kind === 'empty' && change.group !== 'staged') {
        try { await lstat(safeRepositoryPath(repository.public.path, change.path)); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      return repository.changes.get(change.id) === change;
    };
    try {
      if (!await isCurrent()) throw new FileProblem('stale', 'This comparison changed after the snapshot. Refresh to load its current contents.');
      const [before, after] = await Promise.all([
        this.readEndpoint(repository.public.path, change.original),
        this.readEndpoint(repository.public.path, change.modified, change.fingerprint),
      ]);
      if (!await isCurrent()) throw new FileProblem('stale', 'This comparison changed while loading. Refresh to load its current contents.');
      const labels: [string, string] = [change.group === 'staged' || change.group === 'working' ? 'HEAD' : change.group === 'untracked' ? 'Empty' : 'Index', change.group === 'staged' ? 'Index' : 'Working tree'];
      const contents = this.comparisonContents(change.original, change.modified, before, after, labels);
      if (contents.modified && change.group === 'staged' && repository.snapshot?.workingChanges?.some(item => item.id === change.id)) {
        contents.modified.readOnlyReason = 'This file is missing from the working tree. Showing the staged version from the index (read-only).';
      }
      if (contents.modified && change.modified.kind === 'working' && change.fingerprint) await this.makeEditable(repository, change.modified.path, change.fingerprint, after, contents.modified);
      return { ...base, originalLabel: labels[0], modifiedLabel: labels[1], ...contents };
    } catch (error) {
      return { ...base, state: error instanceof FileProblem ? error.state : 'unavailable', message: error instanceof Error ? error.message : 'The file could not be read. Refresh and try again.' };
    }
  }

  dispose(): void { this.repositories.clear(); }
}
