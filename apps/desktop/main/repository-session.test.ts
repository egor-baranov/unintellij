import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_RECENT_PROJECTS, MAX_REPOSITORY_WINDOWS, RepositorySessionStore } from './repository-session';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'smart-diff-session-'));
  roots.push(root);
  return { root, store: new RepositorySessionStore(root) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('repository window session persistence', () => {
  it('keeps recent project history independent of the open workspace with stable opaque identities', async () => {
    const { root, store } = await fixture();
    const first = join(root, 'first');
    const second = join(root, 'second');
    await store.remember(first);
    const [original] = await store.readRecent();
    await store.remember(second);
    await store.remember(first);
    expect((await store.readRecent()).map(item => item.path)).toEqual([first, second]);
    expect((await store.readRecent())[0].id).toBe(original.id);
    await store.write([]);
    expect(await new RepositorySessionStore(root).readRecent()).toEqual(await store.readRecent());
    const copy = await store.readRecent(); copy[0].path = '/changed';
    expect((await store.readRecent())[0].path).toBe(first);
  });

  it('bounds recent history, serializes updates and removes duplicate canonical paths', async () => {
    const { root, store } = await fixture();
    const paths = Array.from({ length: MAX_RECENT_PROJECTS + 3 }, (_, index) => join(root, String(index)));
    await Promise.all(paths.map(path => store.remember(path)));
    await store.flush();
    expect((await store.readRecent()).map(item => item.path)).toEqual([...paths].reverse().slice(0, MAX_RECENT_PROJECTS));
    await store.remember(paths.at(-1)!);
    expect(await store.readRecent()).toHaveLength(MAX_RECENT_PROJECTS);
  });

  it('migrates trusted saved locations once even when projects have since disappeared', async () => {
    const { root, store } = await fixture();
    const path = join(root, 'missing');
    await store.write([{ id: randomUUID(), path }, { id: randomUUID(), path }]);
    const recent = await store.readRecent();
    expect(recent).toEqual([{ id: expect.any(String), name: 'missing', path, lastOpenedAt: 0 }]);
    await store.write([]);
    expect(await new RepositorySessionStore(root).readRecent()).toEqual(recent);
  });

  it('rejects invalid recent identities and paths instead of treating renderer paths as grants', async () => {
    const { root, store } = await fixture();
    const valid = { id: randomUUID(), path: root, lastOpenedAt: 10 };
    await writeFile(join(root, 'recent-projects.json'), JSON.stringify({ version: 1, projects: [valid, valid, { ...valid, id: randomUUID(), path: '../outside' }, { ...valid, id: root }, { ...valid, id: randomUUID(), path: '/different', lastOpenedAt: 'now' }] }));
    expect(await store.readRecent()).toEqual([{ ...valid, name: root.split('/').at(-1) }]);
  });

  it('migrates the old repository once and respects an intentionally empty session', async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, 'repository.json'), JSON.stringify({ path: root }));
    const migrated = await store.read();
    expect(migrated).toEqual([{ id: expect.any(String), path: root }]);
    await store.write(migrated);
    expect(await new RepositorySessionStore(root).read()).toEqual(migrated);
    await store.write([]);
    expect(await store.read()).toEqual([]);
  });

  it('retains independent same-repository windows and serializes concurrent saves', async () => {
    const { root, store } = await fixture();
    const first = { id: randomUUID(), path: root };
    const second = { id: randomUUID(), path: root };
    await Promise.all([store.write([first]), store.write([first, second])]);
    await store.flush();
    expect(await store.read()).toEqual([first, second]);
    expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'))).toEqual({ version: 1, windows: [first, second] });
  });

  it('bounds the durable window list and rejects malformed or duplicate session identities', async () => {
    const { root, store } = await fixture();
    const windows = Array.from({ length: MAX_REPOSITORY_WINDOWS + 4 }, () => ({ id: randomUUID(), path: root }));
    await store.write(windows);
    expect(await store.read()).toEqual(windows.slice(0, MAX_REPOSITORY_WINDOWS));
    await writeFile(join(root, 'workspace.json'), JSON.stringify({ version: 1, windows: [windows[0], windows[0], { id: randomUUID(), path: '../foreign' }, { id: 'raw-id', path: root }, { id: randomUUID(), path: `${root}\0foreign` }] }));
    expect(await store.read()).toEqual([windows[0]]);
  });

  it('treats corrupt and oversized session files as empty instead of resurrecting legacy state', async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, 'repository.json'), JSON.stringify({ path: root }));
    await writeFile(join(root, 'workspace.json'), '{invalid');
    expect(await store.read()).toEqual([]);
    await writeFile(join(root, 'workspace.json'), ' '.repeat(1024 * 1024 + 1));
    expect(await store.read()).toEqual([]);
  });
});
