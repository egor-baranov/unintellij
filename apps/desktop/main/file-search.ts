import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { ProjectEntry } from '../src/bridge';
import type { FileSearchBatch, FileSearchRequest, FileSearchResult, SearchDirectory, SearchOccurrence } from '../../shared/search/types';
import { GitService, runGit } from './git';

export const FILE_SEARCH_RESULT_LIMIT = 500;
const MAX_QUERY_LENGTH = 512;
const MAX_FILES = 100000;
const MAX_PATH_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_SCAN_MS = 30000;
const BATCH_LINES = 25;
const SNIPPET_LENGTH = 360;
interface DirectoryCapability { repositoryId: string; relativePath: string; public: SearchDirectory }
interface SearchJob { repositoryId: string; request: FileSearchRequest; controller: AbortController }
interface OwnerState {
  directories: Map<string, DirectoryCapability>;
  active?: SearchJob;
  queue: Promise<void>;
  disposed: boolean;
}

/** Preserve source UTF-16 positions; never lowercase the source to find offsets. */
function literalPattern(query: string): RegExp { return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'); }

function snippet(line: string, firstColumn: number): Pick<FileSearchResult, 'snippet' | 'snippetStartColumn'> {
  let start = Math.max(0, firstColumn - 1 - 80);
  let end = Math.min(line.length, start + SNIPPET_LENGTH);
  // Avoid cutting a surrogate pair while retaining UTF-16 source coordinates.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start]) && /[\uD800-\uDBFF]/.test(line[start - 1])) start--;
  if (end < line.length && /[\uDC00-\uDFFF]/.test(line[end]) && /[\uD800-\uDBFF]/.test(line[end - 1])) end--;
  return { snippet: line.slice(start, end), snippetStartColumn: start + 1 };
}

/** Main-process application service. No renderer path is ever accepted here. */
export class FileSearchService {
  private readonly owners = new Map<string, OwnerState>();
  private readonly waiting = new Set<() => void>();
  private running = 0;

  constructor(private readonly git: GitService) {}

  private owner(id: string): OwnerState {
    let owner = this.owners.get(id);
    if (!owner) { owner = { directories: new Map(), queue: Promise.resolve(), disposed: false }; this.owners.set(id, owner); }
    return owner;
  }

  async authorizeDirectory(ownerId: string, repositoryId: string, nativePickedPath: string): Promise<SearchDirectory> {
    const owner = this.owner(ownerId);
    const root = this.git.getRepositoryRoot(repositoryId);
    if (typeof nativePickedPath !== 'string' || !path.isAbsolute(nativePickedPath) || nativePickedPath.includes('\0') || nativePickedPath.length > 32768) throw new Error('Invalid search directory.');
    const selected = await realpath(nativePickedPath);
    const relative = path.relative(root, selected);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Choose a directory inside the current project.');
    const relativePath = relative.split(path.sep).join('/');
    await this.git.inspectSearchDirectory(repositoryId, relativePath);
    if (owner.disposed) throw new Error('The search window is no longer available.');
    const previous = [...owner.directories.values()].find(directory => directory.repositoryId === repositoryId && directory.relativePath === relativePath);
    if (previous) return { ...previous.public };
    const directory = { id: randomUUID(), path: selected };
    owner.directories.set(directory.id, { repositoryId, relativePath, public: directory });
    if (owner.directories.size > 32) owner.directories.delete(owner.directories.keys().next().value!);
    return directory;
  }

  /** Resolves once scheduled, not when the project scan completes. */
  async start(ownerId: string, repositoryId: string, request: FileSearchRequest, emit: (batch: FileSearchBatch) => void): Promise<void> {
    this.git.getRepositoryRoot(repositoryId);
    if (!request || typeof request !== 'object' || typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128 || typeof request.query !== 'string' || request.query.length > MAX_QUERY_LENGTH || /[\0\r\n]/.test(request.query) || (request.directoryId !== undefined && typeof request.directoryId !== 'string')) throw new Error('Search requires a request identifier and a single-line query of at most 512 characters.');
    const owner = this.owner(ownerId);
    const directory = request.directoryId === undefined ? undefined : owner.directories.get(request.directoryId);
    if (request.directoryId !== undefined && (!directory || directory.repositoryId !== repositoryId)) throw new Error('Unknown search directory. Choose the directory again.');
    owner.active?.controller.abort();
    const job: SearchJob = { repositoryId, request: { ...request }, controller: new AbortController() };
    owner.active = job;
    const current = () => !owner.disposed && owner.active === job && !job.controller.signal.aborted;
    // A replacement waits for the previous subprocess to close; rapid typing
    // cannot accumulate concurrent Git processes for one window.
    owner.queue = owner.queue.then(async () => {
      if (!current()) return;
      if (!await this.acquire(job.controller.signal)) return;
      try {
        await this.scan(job, directory?.relativePath ?? '', batch => { if (current()) emit(batch); });
      } finally { this.release(); if (owner.active === job) owner.active = undefined; }
    }).catch(error => {
      if (current()) {
        emit({ repositoryId, requestId: request.requestId, results: [], occurrences: 0, matchingLines: 0, files: 0, done: true, truncated: false, error: error instanceof Error ? error.message : 'Search failed.' });
        owner.active = undefined;
      }
    });
  }

  cancel(ownerId: string, requestId: string): void {
    const owner = this.owners.get(ownerId);
    if (owner?.active?.request.requestId === requestId) { owner.active.controller.abort(); owner.active = undefined; }
  }

  disposeOwner(ownerId: string): void {
    const owner = this.owners.get(ownerId);
    if (!owner) return;
    owner.disposed = true;
    owner.active?.controller.abort();
    owner.directories.clear();
    this.owners.delete(ownerId);
  }

  private acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.running < 4) { this.running++; return Promise.resolve(true); }
    return new Promise(resolve => {
      const ready = () => {
        this.waiting.delete(ready);
        signal.removeEventListener('abort', ready);
        if (signal.aborted) resolve(false);
        else { this.running++; resolve(true); }
      };
      this.waiting.add(ready);
      signal.addEventListener('abort', ready, { once: true });
    });
  }

  private release() { this.running--; this.waiting.values().next().value?.(); }

  private async scan(job: SearchJob, directory: string, emit: (batch: FileSearchBatch) => void): Promise<void> {
    const { repositoryId, request, controller: { signal } } = job;
    let occurrences = 0;
    let matchingLines = 0;
    let files = 0;
    let truncated = false;
    let pending: FileSearchResult[] = [];
    let lastFlush = Date.now();
    const flush = (done = false, error?: string) => {
      if (signal.aborted) return;
      emit({ repositoryId, requestId: request.requestId, results: pending, occurrences, matchingLines, files, done, truncated, ...(error ? { error } : {}) });
      pending = [];
      lastFlush = Date.now();
    };
    try {
      if (!request.query) { flush(true); return; }
      await this.git.inspectSearchDirectory(repositoryId, directory);
      if (signal.aborted) return;
      // Limit enumeration itself to the authorized scope. Literal pathspecs keep
      // spaces, brackets and other punctuation in native-picked paths literal.
      const pathspec = directory ? ['--', `:(top,literal)${directory}/`] : [];
      const output = this.git.isGitRepository(repositoryId) ? await runGit(this.git.getRepositoryRoot(repositoryId), ['ls-files', '--cached', '--others', '--exclude-standard', '-z', ...pathspec], MAX_PATH_BYTES, { signal }) : undefined;
      if (signal.aborted) return;
      const pattern = literalPattern(request.query);
      const prefix = directory ? `${directory}/` : '';
      const seen = new Set<string>();
      const paths = output ? new TextDecoder('utf-8', { fatal: true }).decode(output) : '';
      if (paths && !paths.endsWith('\0')) throw new Error('Git returned an invalid search file listing.');
      const candidates: Iterable<string> | AsyncIterable<string> = output ? paths.split('\0') : this.git.iterateProjectSearchPaths(repositoryId, directory, signal);
      const deadline = Date.now() + MAX_SCAN_MS;
      let readBytes = 0;
      for await (const filePath of candidates) {
        if (signal.aborted) return;
        if (!filePath || !filePath.startsWith(prefix) || seen.has(filePath)) continue;
        if (seen.size >= MAX_FILES || readBytes >= MAX_SCAN_BYTES || Date.now() >= deadline) { truncated = true; break; }
        seen.add(filePath);
        const content = await this.git.readSearchFile(repositoryId, filePath);
        if (signal.aborted) return;
        if (!content) continue;
        readBytes += content.bytes;
        const lines = /\r\n|[\r\n]/g;
        let lineStart = 0;
        let lineNumber = 0;
        let entry: ProjectEntry | undefined;
        do {
          if (signal.aborted) return;
          const newline = lines.exec(content.text);
          const line = content.text.slice(lineStart, newline?.index ?? content.text.length);
          lineNumber++;
          pattern.lastIndex = 0;
          const matches: SearchOccurrence[] = [];
          let match: RegExpExecArray | null;
          while (occurrences < FILE_SEARCH_RESULT_LIMIT && (match = pattern.exec(line))) { matches.push({ column: match.index + 1, length: match[0].length }); occurrences++; }
          if (matches.length) {
            if (!entry) {
              entry = await this.git.issueSearchResult(repositoryId, filePath) ?? undefined;
              if (signal.aborted) return;
              if (!entry) { occurrences -= matches.length; break; }
              files++;
            }
            matchingLines++;
            pending.push({ id: `${entry.id}:${lineNumber}`, entry, relativePath: filePath.slice(prefix.length), lineNumber, matches, ...snippet(line, matches[0].column) });
            if (pending.length >= BATCH_LINES || Date.now() - lastFlush >= 50) flush();
          }
          if (occurrences >= FILE_SEARCH_RESULT_LIMIT) { truncated = true; break; }
          if (!newline) break;
          lineStart = newline.index + newline[0].length;
          // A multi-megabyte minified file or many empty lines cannot block
          // cancellation, window events, or another window's search for long.
          if (lineNumber % 256 === 0) {
            await yieldToEventLoop();
            if (Date.now() >= deadline) { truncated = true; break; }
          }
        } while (lineStart <= content.text.length);
        if (truncated) break;
        if (pending.length && Date.now() - lastFlush >= 50) flush();
        if (seen.size % 16 === 0) await yieldToEventLoop();
      }
      flush(true);
    } catch (error) {
      if (!signal.aborted) flush(true, error instanceof Error ? error.message : 'The project could not be searched.');
    }
  }
}
