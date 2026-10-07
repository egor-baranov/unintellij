import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, workspaceReducer } from '../../shared/workspace/model';
import type { ProjectDirectory, ProjectEntry } from './bridge';
import { decodeWorkspaceSession, readWorkspaceSession, resolveProjectPaths, restoreWorkspace, saveWorkspaceSession, workspaceSessionKey } from './workspace-session';

const chrome = { mode: 'project' as const, sidebarVisible: false, sidebarWidth: 410 };
const preferences = { layout: 'compact' as const, sync: false, collapse: true, whitespace: false, wrap: true };
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe('workspace sessions', () => {
  it('restores mixed tab order, split copies, active groups and chrome with fresh document identities', () => {
    let id = 0;
    let state = createWorkspace([{ id: 'old:file', kind: 'file', path: 'src/a.ts' }, { id: 'old:diff', kind: 'comparison', path: 'src/a.ts', comparisonGroup: 'working' }], () => `instance-${++id}`);
    state = workspaceReducer(state, { type: 'move', id: 'old:diff', sourceGroup: 'primary', targetGroup: 'primary', index: 0 });
    state = workspaceReducer(state, { type: 'split', groupId: 'primary', direction: 'down', instanceId: 'split-copy' });
    state = workspaceReducer(state, { type: 'ratio', ratio: .63 });
    saveWorkspaceSession('/repo', 'window-1', state, { 'instance-2': { preferences }, 'split-copy': { preferences: { ...preferences, wrap: false } } }, chrome);
    const session = readWorkspaceSession('/repo', 'window-1')!;
    const restored = restoreWorkspace(session, tab => ({ ...tab, id: `fresh:${tab.kind}:${tab.path}` }));
    expect(restored.groups[0].tabs.map(tab => tab.kind)).toEqual(['comparison', 'file']);
    expect(restored.groups[1].tabs[0]).toMatchObject({ id: 'fresh:comparison:src/a.ts', instanceId: 'split-copy' });
    expect(restored).toMatchObject({ activeGroupId: 'secondary', direction: 'down', splitRatio: .63 });
    expect(restored.groups[0].activeId).toBe('fresh:comparison:src/a.ts');
    expect(session.chrome).toEqual(chrome);
    expect(session.views['split-copy'].preferences?.wrap).toBe(false);
    expect(storage.get(workspaceSessionKey('/repo', 'window-1'))).not.toContain('old:');
  });

  it('keeps simultaneous windows independent and lets a fresh window inherit the latest repository layout', () => {
    const a = createWorkspace([{ id: 'a', kind: 'file', path: 'a.ts' }]);
    const b = createWorkspace([{ id: 'b', kind: 'file', path: 'b.ts' }]);
    saveWorkspaceSession('/repo', 'one', a, {}, chrome);
    saveWorkspaceSession('/repo', 'two', b, {}, chrome);
    expect(readWorkspaceSession('/repo', 'one')?.groups[0].tabs[0].path).toBe('a.ts');
    expect(readWorkspaceSession('/repo', 'two')?.groups[0].tabs[0].path).toBe('b.ts');
    expect(readWorkspaceSession('/repo', 'new')?.groups[0].tabs[0].path).toBe('b.ts');
    expect(readWorkspaceSession('/other-repo', 'one')).toBeUndefined();
  });

  it('retains an intentionally empty workspace instead of reopening a default comparison', () => {
    saveWorkspaceSession('/repo', 'one', createWorkspace(), {}, chrome);
    const session = readWorkspaceSession('/repo', 'one')!;
    expect(restoreWorkspace(session, () => { throw new Error('No document should be restored'); }).groups).toEqual([{ id: 'primary', tabs: [], activeId: null }]);
  });

  it('rejects invalid paths, duplicate instances and stale payload fields while clamping layout values', () => {
    const session = decodeWorkspaceSession({ version: 1, activeGroupId: 'missing', splitRatio: 99,
      groups: [{ id: 'primary', activeInstanceId: 'missing', tabs: [
        { instanceId: 'valid', kind: 'file', path: 'ok.ts', editId: 'stale' },
        { instanceId: 'valid', kind: 'file', path: 'other.ts' },
        { instanceId: 'duplicate-document', kind: 'file', path: 'ok.ts' },
        { instanceId: 'escape', kind: 'file', path: '../secret' },
        { instanceId: 'absolute', kind: 'file', path: '/secret' },
      ] }], views: { valid: { preferences }, closed: { preferences } }, chrome: { sidebarWidth: -5 } })!;
    expect(session.groups[0].tabs).toEqual([{ instanceId: 'valid', kind: 'file', path: 'ok.ts' }]);
    expect(session.groups[0].activeInstanceId).toBe('valid');
    expect(session.activeGroupId).toBe('primary');
    expect(session.splitRatio).toBe(.85);
    expect(session.chrome.sidebarWidth).toBe(280);
    expect(Object.keys(session.views)).toEqual(['valid']);
    expect(decodeWorkspaceSession({ version: 2, groups: [] })).toBeUndefined();
  });

  it('ignores damaged storage and tolerates unavailable browser storage', () => {
    storage.set(workspaceSessionKey('/repo', 'one'), '{bad');
    expect(readWorkspaceSession('/repo', 'one')).toBeUndefined();
    vi.stubGlobal('localStorage', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } });
    expect(readWorkspaceSession('/repo', 'one')).toBeUndefined();
    expect(() => saveWorkspaceSession('/repo', 'one', createWorkspace(), {}, chrome)).not.toThrow();
  });

  it('reissues nested file capabilities through shared allowed directory listings', async () => {
    const entry = (path: string, kind: ProjectEntry['kind'] = 'file'): ProjectEntry => ({ id: `fresh:${path}`, name: path.split('/').at(-1)!, path, kind });
    const listings = new Map<string | null, ProjectEntry[]>([[null, [entry('src', 'directory'), entry('link', 'symlink')]], ['fresh:src', [entry('src/a.ts'), entry('src/b.ts')]]]);
    const load = vi.fn(async (id: string | null): Promise<ProjectDirectory> => ({ repositoryId: 'fresh-repo', directoryId: id, path: id ?? '', entries: listings.get(id) ?? [], truncated: false }));
    const restored = await resolveProjectPaths(['src/a.ts', 'src/b.ts', 'src/missing.ts', 'link/escape.ts', '../outside'], load);
    expect([...restored.keys()]).toEqual(['src/a.ts', 'src/b.ts']);
    expect(restored.get('src/a.ts')?.id).toBe('fresh:src/a.ts');
    expect(load.mock.calls).toEqual([[null], ['fresh:src']]);
  });
});
