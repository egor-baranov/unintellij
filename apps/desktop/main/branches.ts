import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BranchClient, BranchComparison, BranchCommit, BranchOperation, BranchOperationResult, BranchSnapshot, GitBranch } from '../../shared/branches/types';
import type { FileComparison, FileState, GitChange } from '../src/bridge';
import { GitService, readGitIndexFingerprint, runGit, safeRepositoryPath, type CapturedCommitChange, type Endpoint } from './git';
import { defaultCommitOptions, type CommitOptions } from '../../shared/commit/options';

const optional = { allowedExitCodes: [1] };
const decode = (value: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(value);
const line = (value: Buffer) => decode(value).replace(/\r?\n$/, '');
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const safeRef = /^refs\/(heads|remotes|tags)\/(?![-/])[^\x00-\x20\x7f~^:?*\[\\]+$/;
const safeName = /^(?![-/])[^\x00-\x20\x7f~^:?*\[\\]+$/;
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return value;
}
function ref(value: unknown): string {
  const result = text(value, 'branch reference');
  if (!safeRef.test(result) || result.includes('..') || result.includes('@{') || result.endsWith('/') || result.endsWith('.') || result.includes('//') || result.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw new Error('Invalid branch reference.');
  return result;
}
function name(value: unknown): string {
  const result = text(value, 'branch name');
  ref(`refs/heads/${result}`);
  if (!safeName.test(result) || result === 'HEAD') throw new Error('Invalid branch name.');
  return result;
}
function bool(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('Invalid boolean option.');
  return value;
}
function method(value: unknown): 'merge' | 'rebase' | 'ff-only' {
  if (value !== 'merge' && value !== 'rebase' && value !== 'ff-only') throw new Error('Invalid update method.');
  return value;
}
function commitOptions(value: unknown): CommitOptions {
  if (value === undefined) return { ...defaultCommitOptions };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid commit options.');
  const options = value as Record<string, unknown>;
  const author = options.author === undefined ? '' : options.author;
  if (typeof author !== 'string' || author.length > 512 || (author.trim() && !/^[^<>\r\n\x00-\x1f]+ <[^<>\s@]+@[^<>\s@]+>$/.test(author.trim()))) throw new Error('Author must be in the form Name <email@example.com>.');
  return { author: author.trim(), signOff: bool(options.signOff), checkWhitespace: bool(options.checkWhitespace), checkTodo: bool(options.checkTodo) };
}
/** Validate structured-clone payloads independently of the renderer's TypeScript types. */
export function validateBranchOperation(input: unknown): BranchOperation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid branch operation.');
  const op = input as Record<string, unknown>;
  const branch = () => ref(op.ref);
  switch (op.kind) {
    case 'checkout': return { kind: op.kind, ref: branch(), smart: bool(op.smart) };
    case 'checkout-revision': {
      const revision = text(op.revision, 'revision');
      // No path expressions, reflog shell aliases, options, or revision-set syntax.
      if (!/^[A-Za-z0-9_][A-Za-z0-9_./@~^{}-]*$/.test(revision) || revision.includes('..') || revision.includes('@{')) throw new Error('Invalid revision.');
      return { kind: op.kind, revision };
    }
    case 'create': return { kind: op.kind, name: name(op.name), startRef: op.startRef === undefined ? undefined : ref(op.startRef), checkout: bool(op.checkout) };
    case 'rename': return { kind: op.kind, ref: branch(), name: name(op.name), unsetUpstream: bool(op.unsetUpstream) };
    case 'delete': return { kind: op.kind, ref: branch(), force: bool(op.force) };
    case 'fetch': case 'abort': case 'continue': return { kind: op.kind };
    case 'update': return { kind: op.kind, method: method(op.method), ref: op.ref === undefined ? undefined : branch() };
    case 'push': return { kind: op.kind, ref: op.ref === undefined ? undefined : branch(), remote: op.remote === undefined ? undefined : name(op.remote), setUpstream: bool(op.setUpstream) };
    case 'merge': return { kind: op.kind, ref: branch() };
    case 'rebase': return { kind: op.kind, ref: branch(), checkout: bool(op.checkout) };
    case 'commit': {
      const message = text(op.message, 'commit message');
      if (!message.trim()) throw new Error('A commit message is required.');
      let changeIds: string[] | undefined;
      if (op.changeIds !== undefined) {
        if (!Array.isArray(op.changeIds) || !op.changeIds.length || op.changeIds.length > 10000 || op.changeIds.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))) throw new Error('Invalid selected change identifiers.');
        changeIds = [...new Set(op.changeIds as string[])];
      }
      return { kind: op.kind, message, amend: bool(op.amend), ...(changeIds ? { changeIds } : {}), ...(op.options === undefined ? {} : { options: commitOptions(op.options) }) };
    }
    case 'checkout-update': return { kind: op.kind, ref: branch(), method: method(op.method) };
    default: throw new Error('Unknown branch operation.');
  }
}

interface CapturedChange { public: GitChange; original: Endpoint; modified: Endpoint; fingerprints: [string | undefined, string | undefined] }
interface CapturedComparison { public: BranchComparison; changes: Map<string, CapturedChange> }
interface TreeEntry { mode: string; oid: string }
const empty = (): Endpoint => ({ kind: 'empty' });
function endpoint(entry?: TreeEntry): Endpoint { return entry ? { kind: 'blob', oid: entry.oid } : empty(); }
function unsupported(before?: TreeEntry, after?: TreeEntry): FileState | undefined {
  const modes = [before?.mode, after?.mode];
  if (modes.includes('160000')) return 'submodule';
  if (modes.includes('120000')) return 'symlink';
  if (before && after && before.mode.slice(0, 3) !== after.mode.slice(0, 3)) return 'type-change';
}

/** Git branch operations are serialized per repository, not per renderer request. */
export class BranchService implements BranchClient {
  private readonly comparisons = new Map<string, CapturedComparison>();
  constructor(private readonly git: GitService) {}

  private serial<T>(id: string, operation: (root: string) => Promise<T>): Promise<T> {
    return this.git.serializeRepositoryOperation(id, operation);
  }

  listBranches(repositoryId: string): Promise<BranchSnapshot> {
    return this.serial(repositoryId, root => this.snapshot(repositoryId, root));
  }

  private async snapshot(id: string, root: string, captureIndex?: (fingerprint: string) => void): Promise<BranchSnapshot> {
    const [raw, symbolic, headRaw, remoteRaw, status, recentRaw, gitPaths, index] = await Promise.all([
      runGit(root, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)%00%(worktreepath)%00%(symref)%00', 'refs/heads', 'refs/remotes', 'refs/tags']),
      runGit(root, ['symbolic-ref', '--quiet', 'HEAD'], 4096, optional),
      runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], 100, optional),
      runGit(root, ['remote']),
      this.git.inspectRepositoryChanges(id),
      runGit(root, ['reflog', 'show', '--no-show-signature', '--format=%gs', '-n', '100', 'HEAD'], 128 * 1024).catch(() => Buffer.alloc(0)),
      Promise.all(['MERGE_HEAD', 'rebase-merge', 'rebase-apply'].map(item => runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', item]))),
      readGitIndexFingerprint(root),
    ]);
    const current = line(symbolic) || null;
    const head = line(headRaw) || null;
    if (current) ref(current);
    if (head && !oidPattern.test(head)) throw new Error('Git returned an invalid HEAD.');
    const branches: GitBranch[] = [];
    // Each record ends in NUL + LF; worktree paths can themselves contain LF.
    const fields = decode(raw).split('\0');
    for (let i = 0; i + 5 < fields.length; i += 6) {
      const reference = fields[i].replace(/^\n/, '');
      if (!reference || fields[i + 5]) continue; // omit symbolic remote HEAD aliases
      ref(reference);
      const oid = fields[i + 1];
      if (!oidPattern.test(oid)) throw new Error('Git returned an invalid object identity.');
      const kind = reference.startsWith('refs/heads/') ? 'local' : reference.startsWith('refs/remotes/') ? 'remote' : 'tag';
      const track = fields[i + 3];
      branches.push({ ref: reference, name: reference.replace(/^refs\/(heads|remotes|tags)\//, ''), kind, oid, current: reference === current,
        upstream: fields[i + 2] || undefined, ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0), worktree: fields[i + 4] || undefined });
    }
    const exists = await Promise.all(gitPaths.map(async item => { try { await access(line(item)); return true; } catch { return false; } }));
    const operation = exists[1] || exists[2] ? 'rebase' : exists[0] ? 'merge' : null;
    const remotes = decode(remoteRaw).split('\n').filter(Boolean);
    remotes.forEach(name);
    const recent = [...new Set(decode(recentRaw).split('\n').flatMap(item => {
      const match = /^checkout: moving from (.+) to (.+)$/.exec(item);
      return match ? [match[2], match[1]].flatMap(branch => branches.find(entry => entry.kind === 'local' && entry.name === branch)?.ref ?? []) : [];
    }))].slice(0, 8);
    const token = createHash('sha256').update(raw).update(index).update(current ?? '').update(head ?? '').update(operation ?? '').digest('hex');
    captureIndex?.(index);
    return { repositoryId: id, token, current, head, unborn: !head, branches, remotes, recent, operation, dirty: status.length > 0, stagedCount: status.filter(change => change.group === 'staged').length, selectedCommitSupported: true };
  }

  /** Mutations must never invoke repository-defined programs. */
  private async ensureSafeMutation(root: string): Promise<void> {
    const configured = await runGit(root, ['config', '--null', '--get-regexp', /^(filter\..*\.(clean|smudge|process)|merge\..*\.driver|branch\..*\.mergeoptions|core\.(gitproxy|alternaterefscommand)|remote\..*\.(uploadpack|receivepack)|credential\..+\.helper)$/.source], 1024 * 1024, optional);
    if (configured.length) throw new Error('Git operations are unavailable while executable filters, custom merge/transport drivers, or credential helpers are configured. Use Git externally for this repository.');
  }

  private command(root: string, args: string[], env?: NodeJS.ProcessEnv, input?: Buffer, beforeTransactionCommit?: () => Promise<void>): Promise<Buffer> {
    // No shell, no editor/signing prompts, no hooks, no implicit submodule code,
    // no external diff/textconv, no remote-helper protocols supplied by a repo.
    return runGit(root, [
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
      '-c', 'core.editor=true', '-c', 'sequence.editor=true', '-c', 'core.pager=cat', '-c', 'core.sshCommand=ssh -oBatchMode=yes',
      '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
      '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'fetch.fsckObjects=true', '-c', 'receive.fsckObjects=true',
      '-c', 'merge.autoStash=false', '-c', 'rebase.autoStash=false', '-c', 'rebase.updateRefs=false', '-c', 'rebase.autoSquash=false', '-c', 'rebase.rescheduleFailedExec=false',
      '-c', 'merge.verifySignatures=false', '-c', 'rebase.instructionFormat=%s', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      '-c', 'push.gpgSign=false', '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', '-c', 'fetch.pruneTags=false', '-c', 'fetch.prune=false',
      ...args,
    ], 32 * 1024 * 1024, { env: { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true', ...env }, input, beforeTransactionCommit });
  }

  private async commitReviewedIndex(root: string, reviewed: string, operation: Extract<BranchOperation, { kind: 'commit' }>): Promise<void> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-commit-'));
    try {
      const source = line(await runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']));
      const frozen = path.join(directory, 'index');
      await copyFile(source, frozen);
      const env = { GIT_INDEX_FILE: frozen };
      const fingerprint = await readGitIndexFingerprint(root, env);
      if (fingerprint !== reviewed) throw new Error('Staged contents changed after review. Refresh and review the commit again.');
      const options = commitOptions(operation.options);
      await this.checkCommit(root, env, options);
      // Git's normal hooks/signing are disabled. This isolated index ensures a
      // concurrent external `git add` cannot enter the reviewed commit. The real
      // index remains untouched, so later staged changes stay staged afterward.
      await this.command(root, ['commit', '--no-gpg-sign', ...(operation.amend ? ['--amend'] : []), ...(options.author ? [`--author=${options.author}`] : []), ...(options.signOff ? ['--signoff'] : []), '-m', operation.message], env);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async checkCommit(root: string, env: NodeJS.ProcessEnv, options: CommitOptions): Promise<void> {
    const args = ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
    if (options.checkWhitespace) {
      const problems = await runGit(root, [...args, '--check'], 1024 * 1024, { env, allowedExitCodes: [1, 2] });
      if (problems.length) throw new Error(`Whitespace check failed. Fix the selected contents or disable this check:\n${decode(problems).trim()}`);
    }
    if (options.checkTodo) {
      const patch = await runGit(root, [...args, '--unified=0'], 32 * 1024 * 1024, { env });
      const lines = patch.toString('utf8').split('\n');
      let inHunk = false;
      const added = lines.filter(item => {
        if (item.startsWith('diff --git ')) inHunk = false;
        else if (item.startsWith('@@ ')) inHunk = true;
        return inHunk && item.startsWith('+') && /\bTODO\b/i.test(item);
      });
      if (added.length) throw new Error(`TODO check failed: ${added.length} added line${added.length === 1 ? '' : 's'} contain TODO. Resolve them or disable this check.\n${added.slice(0, 5).map(item => item.slice(1, 241)).join('\n')}`);
    }
  }

  /** Commit selected immutable contents while retaining every unchecked index entry. */
  private async commitSelectedChanges(repositoryId: string, root: string, snapshot: BranchSnapshot, reviewed: string, operation: Extract<BranchOperation, { kind: 'commit' }>): Promise<void> {
    if (snapshot.operation) throw new Error('Finish the merge or rebase with the staged commit action. Selected-file commits are unavailable during an operation.');
    const captured = await this.git.captureCommitChanges(repositoryId, operation.changeIds!);
    const selected = new Map<string, CapturedCommitChange>();
    // A checked working-tree version takes precedence over its checked index version.
    for (const change of captured.changes) if (!selected.has(change.path) || change.group !== 'staged') selected.set(change.path, change);
    const selectedStaged = new Set(captured.changes.filter(change => change.group === 'staged' || change.group === 'working').flatMap(change => [change.path, ...(change.oldPath ? [change.oldPath] : [])]));
    const stagedPaths = new Set((await this.git.inspectRepositoryChanges(repositoryId)).filter(change => change.group === 'staged').flatMap(change => [change.path, ...(change.oldPath ? [change.oldPath] : [])]));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-selected-commit-'));
    const indexPath = line(await runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']));
    const lockPath = `${indexPath}.lock`;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let committed = false;
    try {
      try { lock = await open(lockPath, 'wx'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Git is updating the index. Wait for it to finish, then retry the commit.'); throw error; }
      const currentIndex = await readGitIndexFingerprint(root);
      if (currentIndex !== reviewed) throw new Error('Staged contents changed after review. Refresh and review the commit again.');
      const retainedIndex = path.join(directory, 'retained-index');
      const commitIndex = path.join(directory, 'commit-index');
      const env = { GIT_INDEX_FILE: commitIndex };
      const retainedEnv = { GIT_INDEX_FILE: retainedIndex };
      try { await copyFile(indexPath, retainedIndex); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await runGit(root, ['read-tree', '--empty'], 1024, { env: retainedEnv }); }
      await runGit(root, ['-c', 'core.splitIndex=false', 'update-index', '--no-split-index'], 1024, { env: retainedEnv });
      await runGit(root, ['read-tree', ...(snapshot.head ? [snapshot.head] : ['--empty'])], 1024, { env });
      const updateRecords = new Map<string, string>();
      const nullOid = '0'.repeat(snapshot.head?.length ?? (line(await runGit(root, ['rev-parse', '--show-object-format'])) === 'sha256' ? 64 : 40));
      for (const change of selected.values()) {
        if (change.oldPath && change.oldPath !== change.path) updateRecords.set(change.oldPath, `0 ${nullOid}\t${change.oldPath}\0`);
      }
      // An independently selected file recreated at a rename source must win
      // over the source removal regardless of checkbox/request ordering.
      for (const change of selected.values()) {
        const oid = change.mode === '000000' ? nullOid : change.oid ?? line(await runGit(root, ['hash-object', '-w', '--stdin', '--no-filters'], 100, { input: change.contents }));
        if (!oidPattern.test(oid)) throw new Error('Git returned an invalid selected blob identity.');
        updateRecords.set(change.path, `${change.mode === '000000' ? '0' : change.mode} ${oid}\t${change.path}\0`);
      }
      await runGit(root, ['update-index', '-z', '--index-info'], 1024, { env, input: Buffer.from([...updateRecords.values()].join('')) });
      const retainedRecords = [...updateRecords].filter(([filePath]) => !stagedPaths.has(filePath) || selectedStaged.has(filePath)).map(([, record]) => record);
      if (retainedRecords.length) await runGit(root, ['update-index', '-z', '--index-info'], 1024, { env: retainedEnv, input: Buffer.from(retainedRecords.join('')) });
      const options = commitOptions(operation.options);
      await this.checkCommit(root, env, options);
      const tree = line(await runGit(root, ['write-tree'], 100, { env }));
      if (!operation.amend && snapshot.head && tree === line(await runGit(root, ['rev-parse', `${snapshot.head}^{tree}`], 100))) throw new Error('The selected files contain no changes to commit.');
      const authorEnv: NodeJS.ProcessEnv = {};
      let parents = snapshot.head ? [snapshot.head] : [];
      if (operation.amend && snapshot.head) {
        const [parentList, authorName, authorEmail, authorDate] = decode(await runGit(root, ['show', '-s', '--no-show-signature', '--format=%P%x00%an%x00%ae%x00%aI', snapshot.head])).replace(/\n$/, '').split('\0');
        parents = parentList.split(' ').filter(Boolean);
        Object.assign(authorEnv, { GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_AUTHOR_DATE: authorDate });
      }
      if (options.author) {
        const author = /^(.+) <([^<>]+)>$/.exec(options.author)!;
        Object.assign(authorEnv, { GIT_AUTHOR_NAME: author[1], GIT_AUTHOR_EMAIL: author[2] });
      }
      let message = operation.message;
      if (options.signOff) {
        const identity = line(await runGit(root, ['var', 'GIT_COMMITTER_IDENT'])).replace(/ \d+ [+-]\d{4}$/, '');
        const trailer = `Signed-off-by: ${identity}`;
        if (!message.split(/\r?\n/).includes(trailer)) message = `${message.trimEnd()}\n\n${trailer}\n`;
      }
      await captured.assertCurrent();
      // Build an unreachable object first, then atomically compare-and-swap HEAD.
      // An external commit cannot silently become the parent of this review.
      const commit = line(await this.command(root, ['commit-tree', '--no-gpg-sign', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message], authorEnv));
      if (!oidPattern.test(commit)) throw new Error('Git returned an invalid commit identity.');
      await captured.assertCurrent();
      await lock.writeFile(await readFile(retainedIndex));
      await lock.sync();
      const transaction = `start\noption no-deref\nupdate ${snapshot.current ?? 'HEAD'} ${commit} ${snapshot.head ?? nullOid}\nprepare\n`;
      await this.command(root, ['update-ref', '-m', `commit${operation.amend ? ' (amend)' : ''}: ${message.split(/\r?\n/)[0]}`, '--stdin'], undefined, Buffer.from(transaction), async () => {
        // Git locks HEAD when it updates the currently checked-out ref. If a
        // checkout won that race, abort before updating the formerly current ref.
        const current = line(await runGit(root, ['symbolic-ref', '--quiet', 'HEAD'], 4096, optional)) || null;
        if (current !== snapshot.current) throw new Error('The checked-out branch changed after review. Refresh and review the commit again.');
        await captured.assertCurrent();
      });
      committed = true;
      await lock.close(); lock = undefined;
      await rename(lockPath, indexPath);
    } catch (error) {
      if (committed) throw new Error(`The commit was created, but updating the Git index failed. Refresh before continuing. ${error instanceof Error ? error.message : ''}`);
      throw error;
    } finally {
      if (lock) await lock.close();
      // Only remove our lock; an EEXIST failure belongs to another Git process.
      if (lock || committed) await rm(lockPath, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async ensureSafeContinuation(root: string, operation: 'merge' | 'rebase'): Promise<void> {
    if (operation !== 'rebase') return;
    const directory = line(await runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge']));
    const read = async (name: string) => {
      try { return await readFile(`${directory}/${name}`, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
    };
    const [todo, strategy, signing] = await Promise.all([read('git-rebase-todo'), read('strategy'), read('gpg_sign_opt')]);
    // An externally started interactive rebase can contain arbitrary shell exec
    // steps. Showing it is safe, executing its plan from this app is not.
    if (/^\s*(exec|x|break|b)(?:\s|$)/m.test(todo) || signing.trim() || (strategy.trim() && !['ort', 'recursive', 'resolve', 'octopus', 'ours', 'subtree'].includes(strategy.trim()))) {
      throw new Error('This rebase contains executable steps, signing, or a custom strategy. Continue it using Git externally, or abort it here.');
    }
  }

  private branch(snapshot: BranchSnapshot, reference: string): GitBranch {
    const branch = snapshot.branches.find(item => item.ref === reference);
    if (!branch) throw new Error('This reference no longer exists. Refresh the branch menu.');
    return branch;
  }
  private local(snapshot: BranchSnapshot, reference: string): GitBranch {
    const branch = this.branch(snapshot, reference);
    if (branch.kind !== 'local') throw new Error('This action requires a local branch.');
    return branch;
  }
  private available(branch: GitBranch, root: string): void {
    if (branch.worktree && branch.worktree !== root) throw new Error(`This branch is checked out in another worktree: ${branch.worktree}`);
  }
  private async resolve(root: string, revision: string): Promise<string> {
    const oid = line(await runGit(root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], 100));
    if (!oidPattern.test(oid)) throw new Error('Could not resolve this revision to a commit.');
    return oid;
  }

  private async checkout(root: string, snapshot: BranchSnapshot, reference: string, smart = false): Promise<string> {
    const branch = this.branch(snapshot, reference);
    this.available(branch, root);
    const action = async () => {
      if (branch.kind === 'local') await this.command(root, ['switch', '--no-guess', '--', branch.name]);
      else if (branch.kind === 'remote') {
        const remote = snapshot.remotes.sort((a, b) => b.length - a.length).find(remote => branch.name.startsWith(`${remote}/`));
        if (!remote) throw new Error('The remote for this branch is unavailable.');
        const localName = name(branch.name.slice(remote.length + 1));
        if (snapshot.branches.some(item => item.ref === `refs/heads/${localName}`)) throw new Error(`Local branch “${localName}” already exists. Check out that branch or create a branch with another name.`);
        await this.command(root, ['switch', '--track', '-c', localName, '--', branch.ref]);
      } else await this.command(root, ['switch', '--detach', '--', await this.resolve(root, branch.ref)]);
    };
    if (!smart || !snapshot.dirty) { await action(); return `Checked out ${branch.name}.`; }
    if (snapshot.unborn) throw new Error('Smart checkout requires an existing commit.');
    const previousStash = line(await runGit(root, ['rev-parse', '--verify', '--quiet', 'refs/stash'], 100, optional));
    await this.command(root, ['stash', 'push', '--include-untracked', '-m', `unintellij checkout ${new Date().toISOString()}`]);
    const stash = line(await runGit(root, ['rev-parse', '--verify', 'refs/stash']));
    if (stash === previousStash) throw new Error('Git could not stash these changes. No branch was switched; handle submodule or special-file changes with Git first.');
    let checkoutError: unknown;
    try { await action(); } catch (error) { checkoutError = error; }
    try {
      await this.command(root, ['stash', 'apply', '--index', stash]);
      if (line(await runGit(root, ['rev-parse', '--verify', 'refs/stash'])) === stash) await this.command(root, ['stash', 'drop', 'stash@{0}']);
    } catch (error) {
      throw new Error(`${checkoutError ? 'Checkout failed.' : `Checked out ${branch.name}.`} Your changes remain saved in stash ${stash.slice(0, 12)}; restoring them needs attention. ${error instanceof Error ? error.message : ''}`);
    }
    if (checkoutError) throw checkoutError;
    return `Checked out ${branch.name} and restored local changes.`;
  }

  runBranchOperation(repositoryId: string, token: string, input: unknown): Promise<BranchOperationResult> {
    const operation = validateBranchOperation(input);
    text(token, 'branch snapshot');
    return this.serial(repositoryId, async root => {
      let reviewedIndex = '';
      let snapshot = await this.snapshot(repositoryId, root, index => { reviewedIndex = index; });
      if (snapshot.token !== token) throw new Error('Branches changed since this menu was opened. Refresh and try again.');
      if (snapshot.operation && !['abort', 'continue', 'commit'].includes(operation.kind)) throw new Error(`Finish or abort the ${snapshot.operation} in progress first.`);
      await this.ensureSafeMutation(root);
      let message = 'Git operation completed.';
      const completed: string[] = [];
      const current = () => {
        if (!snapshot.current) throw new Error('Check out a local branch first.');
        return snapshot.current;
      };
      const clean = () => { if (snapshot.dirty) throw new Error('Commit or stash local changes before this operation.'); };
      const update = async (reference: string, updateMethod: 'merge' | 'rebase' | 'ff-only') => {
        const branch = this.local(snapshot, reference);
        this.available(branch, root);
        if (!branch.upstream) throw new Error('This branch has no upstream. Push it with an upstream first.');
        const upstream = this.branch(snapshot, branch.upstream);
        const remote = snapshot.remotes.sort((a, b) => b.length - a.length).find(item => upstream.name.startsWith(`${item}/`));
        if (!remote) throw new Error('The upstream remote is unavailable.');
        await this.command(root, ['fetch', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--', remote]);
        completed.push(`Fetched ${remote}.`);
        const oid = await this.resolve(root, branch.upstream);
        if (updateMethod === 'rebase') await this.command(root, ['rebase', '--strategy=ort', '--no-autostash', oid]);
        else await this.command(root, ['merge', '--strategy=ort', '--no-edit', ...(updateMethod === 'ff-only' ? ['--ff-only'] : []), oid]);
      };
      try {
        switch (operation.kind) {
          case 'checkout': message = await this.checkout(root, snapshot, operation.ref, operation.smart); break;
          case 'checkout-revision': await this.command(root, ['switch', '--detach', '--', await this.resolve(root, operation.revision)]); message = `Checked out ${operation.revision} in detached HEAD mode.`; break;
          case 'create': {
            await runGit(root, ['check-ref-format', '--branch', operation.name]);
            const start = operation.startRef ? await this.resolve(root, this.branch(snapshot, operation.startRef).ref) : snapshot.head;
            if (!start) throw new Error('Create the first commit before creating another branch.');
            await this.command(root, operation.checkout ? ['switch', '-c', operation.name, '--', start] : ['branch', '--', operation.name, start]);
            message = `Created ${operation.name}.`; break;
          }
          case 'rename': {
            const branch = this.local(snapshot, operation.ref); this.available(branch, root);
            await runGit(root, ['check-ref-format', '--branch', operation.name]);
            await this.command(root, ['branch', '-m', '--', branch.name, operation.name]);
            if (operation.unsetUpstream && branch.upstream) await this.command(root, ['branch', '--unset-upstream', '--', operation.name]);
            message = `Renamed ${branch.name} to ${operation.name}.`; break;
          }
          case 'delete': {
            const branch = this.branch(snapshot, operation.ref); this.available(branch, root);
            if (branch.current) throw new Error('Check out another branch before deleting the current branch.');
            if (branch.kind === 'local') await this.command(root, ['branch', operation.force ? '-D' : '-d', '--', branch.name]);
            else if (branch.kind === 'tag') await this.command(root, ['tag', '-d', '--', branch.name]);
            else {
              const remote = snapshot.remotes.sort((a, b) => b.length - a.length).find(item => branch.name.startsWith(`${item}/`));
              if (!remote) throw new Error('The remote for this branch is unavailable.');
              const remoteRef = `refs/heads/${branch.name.slice(remote.length + 1)}`;
              // Lease rejects a remote tip that changed after the displayed snapshot.
              await this.command(root, ['push', '--no-mirror', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=${remoteRef}:${branch.oid}`, '--', remote, `:${remoteRef}`]);
            }
            message = `Deleted ${branch.name}.`; break;
          }
          case 'fetch': await this.command(root, ['fetch', '--all', '--no-prune', '--no-prune-tags', '--no-recurse-submodules']); message = 'Fetched all remotes.'; break;
          case 'checkout-update': clean(); completed.push(await this.checkout(root, snapshot, operation.ref)); snapshot = await this.snapshot(repositoryId, root); await update(current(), operation.method); message = 'Checked out and updated the branch.'; break;
          case 'update': {
            clean(); const reference = operation.ref ?? current();
            if (reference !== current()) throw new Error('Check out this branch before updating it.');
            await update(reference, operation.method); message = 'Updated the current branch.'; break;
          }
          case 'push': {
            const branch = this.branch(snapshot, operation.ref ?? current());
            if (branch.kind === 'remote') throw new Error('Check out this remote branch locally before pushing it.');
            const upstreamRemote = branch.upstream && snapshot.remotes.sort((a, b) => b.length - a.length).find(item => branch.upstream!.startsWith(`refs/remotes/${item}/`));
            const remote = operation.remote ?? upstreamRemote ?? (snapshot.remotes.includes('origin') ? 'origin' : snapshot.remotes[0]);
            if (!remote || !snapshot.remotes.includes(remote)) throw new Error('Select an available Git remote.');
            const target = branch.kind === 'tag' ? branch.ref : branch.upstream?.startsWith(`refs/remotes/${remote}/`) ? `refs/heads/${branch.upstream.slice(`refs/remotes/${remote}/`.length)}` : `refs/heads/${branch.name}`;
            await this.command(root, ['push', '--no-mirror', '--no-follow-tags', '--recurse-submodules=no', ...(operation.setUpstream && branch.kind === 'local' ? ['--set-upstream'] : []), '--', remote, `${branch.ref}:${target}`]);
            message = `Pushed ${branch.name} to ${remote}.`; break;
          }
          case 'merge': clean(); await this.command(root, ['merge', '--strategy=ort', '--no-edit', await this.resolve(root, this.branch(snapshot, operation.ref).ref)]); message = 'Merged the selected branch.'; break;
          case 'rebase': {
            clean(); const selected = this.branch(snapshot, operation.ref);
            const onto = operation.checkout ? snapshot.head : await this.resolve(root, selected.ref);
            if (!onto) throw new Error('Rebase requires an existing commit.');
            if (operation.checkout) completed.push(await this.checkout(root, snapshot, selected.ref));
            await this.command(root, ['rebase', '--strategy=ort', '--no-autostash', onto]); message = 'Rebased the branch.'; break;
          }
          case 'abort': if (!snapshot.operation) throw new Error('There is no merge or rebase to abort.'); await this.command(root, [snapshot.operation, '--abort']); message = `Aborted ${snapshot.operation}.`; break;
          case 'continue': if (!snapshot.operation) throw new Error('There is no merge or rebase to continue.'); await this.ensureSafeContinuation(root, snapshot.operation); await this.command(root, [snapshot.operation, '--continue']); message = `Continued ${snapshot.operation}.`; break;
          case 'commit': {
            if (!operation.changeIds && !operation.amend && snapshot.stagedCount === 0) throw new Error('There are no staged changes to commit. Stage files with Git first.');
            if (operation.amend && snapshot.unborn) throw new Error('There is no commit to amend.');
            if (operation.changeIds) await this.commitSelectedChanges(repositoryId, root, snapshot, reviewedIndex, operation);
            else await this.commitReviewedIndex(root, reviewedIndex, operation);
            message = operation.amend ? 'Amended the current commit.' : operation.changeIds ? 'Committed selected files.' : 'Committed staged changes.'; break;
          }
        }
      } catch (error) {
        const after = await this.snapshot(repositoryId, root);
        const detail = [...completed, error instanceof Error ? error.message : 'Git operation failed.'].join(' ');
        if (after.operation) throw new Error(`${detail}\nA ${after.operation} is now in progress. Resolve and stage conflicts with Git, then Continue here, or choose Abort.`);
        if (completed.length) throw new Error(detail);
        throw error;
      }
      return { snapshot: await this.snapshot(repositoryId, root), message };
    });
  }

  private async tree(root: string, revision: string | null): Promise<Map<string, TreeEntry>> {
    if (!revision) return new Map();
    const raw = decode(await runGit(root, ['ls-tree', '-r', '-z', '--full-tree', revision]));
    const result = new Map<string, TreeEntry>();
    for (const record of raw.split('\0')) {
      if (!record) continue;
      const match = /^(\d{6}) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
      if (!match || !oidPattern.test(match[3])) throw new Error('Unsupported Git tree record.');
      safeRepositoryPath(root, match[4]); result.set(match[4], { mode: match[1], oid: match[3] });
    }
    return result;
  }

  compareBranches(repositoryId: string, reference: string, target: 'head' | 'working', swap = false): Promise<BranchComparison> {
    ref(reference); bool(swap);
    if (target !== 'head' && target !== 'working') throw new Error('Invalid comparison target.');
    return this.serial(repositoryId, async root => {
      const snapshot = await this.snapshot(repositoryId, root);
      const source = this.branch(snapshot, reference);
      const sourceOid = await this.resolve(root, reference);
      const [originalTree, modifiedTree, status] = await Promise.all([this.tree(root, sourceOid), this.tree(root, snapshot.head), this.git.inspectRepositoryChanges(repositoryId)]);
      const paths = new Set([...originalTree.keys(), ...modifiedTree.keys()].filter(filePath => {
        const before = originalTree.get(filePath), after = modifiedTree.get(filePath);
        return before?.oid !== after?.oid || before?.mode !== after?.mode;
      }));
      if (target === 'working') for (const change of status) { paths.add(change.path); if (change.oldPath) paths.add(change.oldPath); }
      const changes: CapturedChange[] = [];
      for (const filePath of [...paths].sort()) {
        const before = originalTree.get(filePath), after = modifiedTree.get(filePath);
        let original = endpoint(before), modified = endpoint(after);
        let fingerprint: string | undefined;
        let problem = unsupported(before, after);
        if (target === 'working') {
          const captured = await this.git.captureWorkingEndpoint(repositoryId, filePath);
          modified = captured.endpoint; fingerprint = captured.fingerprint; problem = captured.unsupported ?? problem;
          problem = status.find(change => change.path === filePath && change.unsupported)?.unsupported ?? problem;
          if (!problem && before && modified.kind === 'working' && await this.git.capturedEndpointMatchesBlob(repositoryId, modified, fingerprint, before.oid)) continue;
        }
        if (original.kind === 'empty' && modified.kind === 'empty') continue;
        let fingerprints: [string | undefined, string | undefined] = [undefined, fingerprint];
        if (swap) { [original, modified] = [modified, original]; fingerprints = [fingerprint, undefined]; }
        changes.push({ public: { id: randomUUID(), path: filePath, group: 'unstaged', status: original.kind === 'empty' ? 'A' : modified.kind === 'empty' ? 'D' : 'M', unsupported: problem }, original, modified, fingerprints });
      }
      const labels: [string, string] = [source.name, target === 'working' ? 'Working tree' : snapshot.current?.replace('refs/heads/', '') ?? 'HEAD'];
      if (swap) labels.reverse();
      const commits: BranchCommit[] = [];
      let truncated = false;
      if (snapshot.head && sourceOid !== snapshot.head) {
        for (const [include, exclude, side] of [[sourceOid, snapshot.head, swap ? 'modified' : 'original'], [snapshot.head, sourceOid, swap ? 'original' : 'modified']] as const) {
          const rows = decode(await runGit(root, ['log', '--no-show-signature', '--format=%H%x00%s%x00%an%x00%aI%x00', '-n', '201', include, `^${exclude}`, '--'])).split('\0');
          let count = 0;
          for (let i = 0; i + 3 < rows.length; i += 4) {
            const oid = rows[i].replace(/^\n/, '');
            if (!oidPattern.test(oid)) throw new Error('Invalid commit record.');
            if (++count > 200) { truncated = true; break; }
            commits.push({ oid, subject: rows[i + 1], author: rows[i + 2], date: rows[i + 3], side });
          }
        }
      }
      const comparison: BranchComparison = { id: randomUUID(), repositoryId, sourceRef: reference, target, swapped: swap, originalLabel: labels[0], modifiedLabel: labels[1], changes: changes.map(change => change.public), commits, truncated };
      this.comparisons.set(comparison.id, { public: comparison, changes: new Map(changes.map(change => [change.public.id, change])) });
      while (this.comparisons.size > 20) this.comparisons.delete(this.comparisons.keys().next().value!);
      return comparison;
    });
  }

  async readBranchComparison(repositoryId: string, comparisonId: string, changeId: string): Promise<FileComparison> {
    this.git.getRepositoryRoot(repositoryId); text(comparisonId, 'comparison identifier'); text(changeId, 'change identifier');
    const comparison = this.comparisons.get(comparisonId);
    if (!comparison || comparison.public.repositoryId !== repositoryId) throw new Error('This branch comparison expired. Compare the branches again.');
    const change = comparison.changes.get(changeId);
    if (!change) throw new Error('Unknown file in this branch comparison.');
    return this.git.readCapturedComparison(repositoryId, changeId, change.public.path, change.original, change.modified, [comparison.public.originalLabel, comparison.public.modifiedLabel], change.fingerprints, change.public.unsupported);
  }

  releaseRepository(repositoryId: string): void {
    for (const [id, comparison] of this.comparisons) if (comparison.public.repositoryId === repositoryId) this.comparisons.delete(id);
  }

  dispose(): void { this.comparisons.clear(); }
}
