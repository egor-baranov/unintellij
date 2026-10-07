import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { GitService } from './git';
import { BranchService } from './branches';

/** Fixture commands use plumbing and an isolated configuration, with no hooks. */
function git(root: string, args: string[], input?: string, countOnly = false): Promise<{ text: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const child = spawn('git', ['--no-optional-locks', '-c', `core.hooksPath=${os.devNull}`, '-c', 'commit.gpgSign=false', ...args], {
      cwd: root, env: {
        ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
        GIT_AUTHOR_NAME: 'Large repository fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Large repository fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (!countOnly) chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ text: Buffer.concat(chunks).toString('utf8').trimEnd(), bytes })
      : reject(new Error(`Git ${args[0]} failed: ${Buffer.concat(errors).toString('utf8')}`)));
    child.stdin.end(input);
  });
}

it('opens, browses, lists branches, commits, and refreshes an index larger than the ordinary Git output budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-large-index-'));
  const service = new GitService();
  try {
    await git(root, ['init', '-b', 'main']);
    await git(root, ['config', 'core.autocrlf', 'false']);
    await git(root, ['config', 'user.name', 'Large repository fixture']);
    await git(root, ['config', 'user.email', 'fixture@example.invalid']);
    const visibleName = 'zz-visible 名\ttab\nline.ts';
    const source = 'export const visible = "complete contents";\n';
    await writeFile(path.join(root, visibleName), source);
    await git(root, ['add', '--', visibleName]);
    const initialTree = (await git(root, ['write-tree'])).text;
    const initialCommit = (await git(root, ['commit-tree', initialTree, '-m', 'Visible file'])).text;
    const blob = (await git(root, ['hash-object', '-w', '--stdin'], source)).text;

    // Long but valid filenames keep the fixture economical: only index entries
    // are created, while the actual worktree stays small and Git status is clean.
    const virtualPaths = Array.from({ length: 125000 }, (_, index) => `virtual/${String(index).padStart(6, '0')}-${'x'.repeat(200)}.ts`);
    await git(root, ['update-index', '-z', '--index-info'], virtualPaths.map(name => `100644 ${blob}\t${name}\0`).join(''));
    await git(root, ['update-index', '--skip-worktree', '-z', '--stdin'], `${virtualPaths.join('\0')}\0`);
    await mkdir(path.join(root, 'zz-submodule'));
    await git(root, ['update-index', '--add', '--cacheinfo', `160000,${initialCommit},zz-submodule`]);
    const tree = (await git(root, ['write-tree'])).text;
    const commit = (await git(root, ['commit-tree', tree, '-m', 'Large index'])).text;
    await git(root, ['update-ref', 'HEAD', commit]);
    const listing = await git(root, ['ls-files', '--stage', '-z'], undefined, true);
    expect(listing.bytes).toBeGreaterThan(32 * 1024 * 1024);
    expect((await git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])).bytes).toBe(0);

    const before = await readFile(path.join(root, '.git', 'index'));
    const snapshot = await service.registerRepository(root);
    expect(snapshot.changes).toEqual([]);
    expect(service.getTreeGitPresence(snapshot.repository.id, virtualPaths[0])).toEqual({ indexed: true, pending: false });
    expect(service.getTreeGitPresence(snapshot.repository.id, virtualPaths.at(-1)!)).toEqual({ indexed: true, pending: false });
    const directory = await service.listProjectDirectory(snapshot.repository.id, null);
    expect(directory.truncated).toBe(false);
    expect(directory.entries.map(entry => entry.name).sort()).toEqual(['zz-submodule', visibleName].sort());
    const visible = directory.entries.find(entry => entry.name === visibleName)!;
    expect(visible.facts?.git).toMatchObject({ state: 'clean', tracked: true });
    expect(await service.readProjectFile(snapshot.repository.id, visible.id)).toMatchObject({ state: 'text', content: { text: source } });
    const submodule = directory.entries.find(entry => entry.name === 'zz-submodule')!;
    expect(submodule.kind).toBe('submodule');
    expect(await service.readProjectFile(snapshot.repository.id, submodule.id)).toMatchObject({ state: 'submodule' });
    expect((await readFile(path.join(root, '.git', 'index'))).equals(before)).toBe(true);

    const branches = new BranchService(service);
    const branchSnapshot = await branches.listBranches(snapshot.repository.id);
    expect(branchSnapshot).toMatchObject({ current: 'refs/heads/main', head: commit, unborn: false, dirty: false, stagedCount: 0 });
    expect(branchSnapshot.branches.find(branch => branch.current)).toMatchObject({ name: 'main', oid: commit });
    expect((await branches.listBranches(snapshot.repository.id)).token).toBe(branchSnapshot.token);
    // Merely opening the branch menu must not invalidate existing file review
    // capabilities or rewrite a large index.
    expect((await service.listChanges(snapshot.repository.id)).generation).toBe(snapshot.generation);
    expect((await readFile(path.join(root, '.git', 'index'))).equals(before)).toBe(true);

    await writeFile(path.join(root, visibleName), 'first staged version\n');
    await git(root, ['add', '--', visibleName]);
    const firstReview = await branches.listBranches(snapshot.repository.id);
    expect(firstReview).toMatchObject({ head: commit, dirty: true, stagedCount: 1 });
    expect(firstReview.token).not.toBe(branchSnapshot.token);
    await writeFile(path.join(root, visibleName), 'reviewed staged version\n');
    await git(root, ['add', '--', visibleName]);
    const secondReview = await branches.listBranches(snapshot.repository.id);
    // Both snapshots have the same path and M status: the contents, rather
    // than just a status summary or the index byte count, must affect the token.
    expect(secondReview.token).not.toBe(firstReview.token);
    await expect(branches.runBranchOperation(snapshot.repository.id, firstReview.token,
      { kind: 'commit', message: 'Must reject stale contents', amend: false })).rejects.toThrow('Branches changed');
    expect((await git(root, ['rev-parse', 'HEAD'])).text).toBe(commit);

    await writeFile(path.join(root, visibleName), 'later working version\n');
    const reviewedIndex = await readFile(path.join(root, '.git', 'index'));
    await branches.runBranchOperation(snapshot.repository.id, secondReview.token,
      { kind: 'commit', message: 'Reviewed large index', amend: false });
    expect((await git(root, ['show', `HEAD:${visibleName}`])).text).toBe('reviewed staged version');
    expect(await readFile(path.join(root, visibleName), 'utf8')).toBe('later working version\n');
    expect((await readFile(path.join(root, '.git', 'index'))).equals(reviewedIndex)).toBe(true);
    expect((await git(root, ['rev-parse', `HEAD:${virtualPaths[0]}`, `HEAD:${virtualPaths.at(-1)!}`])).text.split('\n')).toEqual([blob, blob]);

    // Selected-file commits use a separate index-preservation path. Keep an
    // unchecked staged file and all unloaded virtual entries intact there too.
    const unchecked = 'zz-unchecked.ts';
    await writeFile(path.join(root, unchecked), 'keep staged\n');
    await git(root, ['add', '--', visibleName, unchecked]);
    await writeFile(path.join(root, visibleName), 'final working version\n');
    const changes = await service.refreshRepository(snapshot.repository.id);
    const selected = changes.changes.find(change => change.path === visibleName && change.group === 'staged')!;
    const selectedReview = await branches.listBranches(snapshot.repository.id);
    await branches.runBranchOperation(snapshot.repository.id, selectedReview.token,
      { kind: 'commit', message: 'Selected large index', amend: false, changeIds: [selected.id] });
    expect((await git(root, ['show', `HEAD:${visibleName}`])).text).toBe('later working version');
    expect(await readFile(path.join(root, visibleName), 'utf8')).toBe('final working version\n');
    expect((await git(root, ['show', `:${unchecked}`])).text).toBe('keep staged');
    expect((await git(root, ['diff', '--cached', '--name-only'])).text).toBe(unchecked);
    expect((await git(root, ['rev-parse', `:${virtualPaths[0]}`, `:${virtualPaths.at(-1)!}`])).text.split('\n')).toEqual([blob, blob]);
    expect((await git(root, ['ls-files', '--stage', '-z'], undefined, true)).bytes).toBeGreaterThan(32 * 1024 * 1024);

    // Nonzero stages at the end of the same large stream must remain a single
    // tracked conflict, and refreshing must preserve the existing capabilities.
    const conflict = 'zz-conflict.ts';
    await writeFile(path.join(root, conflict), 'unresolved working contents\n');
    await git(root, ['update-index', '-z', '--index-info'], [1, 2, 3].map(stage => `100644 ${blob} ${stage}\t${conflict}\0`).join(''));
    const refreshed = await service.refreshRepository(snapshot.repository.id);
    const unresolved = refreshed.changes.find(change => change.path === conflict)!;
    expect(unresolved).toMatchObject({ status: 'U', unsupported: 'conflicted' });
    expect(service.getTreeGitPresence(snapshot.repository.id, conflict)).toEqual({ indexed: true, pending: true });
    expect(await service.readComparison(snapshot.repository.id, unresolved.id)).toMatchObject({ state: 'conflicted' });
    expect(await service.readProjectFile(snapshot.repository.id, visible.id)).toMatchObject({ state: 'text', content: { text: 'final working version\n' } });
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }); }
}, 60000);
