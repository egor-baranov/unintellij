import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentProject, RepositorySnapshot } from '../src/bridge';
import type { FileSearchBatch, SearchDirectory } from '../../shared/search/types';

type WindowDouble = EventEmitter & {
  webContents: EventEmitter & { id: number; mainFrame: { url: string }; send: ReturnType<typeof vi.fn> };
  destroyed: boolean;
  focused: boolean;
  shown: boolean;
  options: Record<string, unknown>;
  focus(): void;
  close(): void;
  destroy(): void;
};
const state = vi.hoisted(() => ({
  userData: '', selection: '', failNextLoad: false, windows: [] as WindowDouble[],
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  start: undefined as undefined | (() => Promise<void>),
  app: undefined as undefined | EventEmitter,
  watchers: [] as Array<{ onChange(): void; disposed: boolean }>,
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class BrowserWindow extends EventEmitter {
    destroyed = false;
    focused = false;
    shown = false;
    webContents = Object.assign(new EventEmitter(), {
      id: state.windows.length + 1,
      mainFrame: { url: '' },
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
    });
    constructor(public options: Record<string, unknown>) { super(); state.windows.push(this); }
    static getFocusedWindow() { return state.windows.find(window => window.focused && !window.destroyed) ?? null; }
    async loadURL(url: string) {
      if (state.failNextLoad) { state.failNextLoad = false; throw new Error('Renderer failed to load'); }
      this.webContents.mainFrame.url = url;
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    focus() { for (const window of state.windows) window.focused = false; this.focused = true; this.emit('focus'); }
    show() { this.shown = true; this.focus(); }
    close() { this.destroy(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
    restore() {}
  }
  const app = Object.assign(new EventEmitter(), {
    commandLine: { getSwitchValue: () => state.userData },
    setPath: (_name: string, value: string) => { state.userData = value; },
    getPath: () => state.userData,
    getName: () => 'unintellij', setName: vi.fn(), setAboutPanelOptions: vi.fn(),
    whenReady: () => ({ then: (callback: () => Promise<void>) => { state.start = callback; } }),
    quit: vi.fn(),
  });
  state.app = app;
  return {
    app, BrowserWindow,
    ipcMain: { handle: (name: string, callback: (event: unknown, ...args: unknown[]) => unknown) => state.handlers.set(name, callback) },
    dialog: { showOpenDialog: async () => ({ canceled: !state.selection, filePaths: [state.selection] }), showSaveDialog: vi.fn(async () => ({ canceled: !state.selection, filePath: state.selection })), showMessageBox: vi.fn() },
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(template => template), getApplicationMenu: () => null },
    clipboard: { writeText: vi.fn() },
    shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn() }, net: {},
  };
});
vi.mock('./repository-watcher', () => ({
  RepositoryWatcher: class {
    disposed = false;
    constructor(_read: unknown, public onChange: () => void) { state.watchers.push(this); }
    async check() {}
    dispose() { this.disposed = true; }
  },
}));

const exec = promisify(execFile);
const roots: string[] = [];
async function repository(parent: string, name: string) {
  const root = join(parent, name);
  await mkdir(root);
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await writeFile(join(root, 'file.txt'), 'first\n');
  await exec('git', ['add', 'file.txt'], { cwd: root });
  return realpath(root);
}
async function invoke<T = unknown>(window: WindowDouble, name: string, ...args: unknown[]): Promise<T> {
  const handler = state.handlers.get(name);
  if (!handler) throw new Error(`Missing handler ${name}`);
  return await handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args) as T;
}
async function launch() {
  state.app?.removeAllListeners();
  await import('./index');
  await state.start!();
}
async function choose(window: WindowDouble, path: string) {
  state.selection = path;
  expect(await invoke(window, 'repository:choose')).toBeNull();
  return state.windows.at(-1)!;
}
async function persisted() {
  return JSON.parse(await readFile(join(state.userData, 'workspace.json'), 'utf8')) as { version: number; windows: Array<{ id: string; path: string }> };
}
async function flushQuit() {
  const { app } = await import('electron');
  vi.mocked(app.quit).mockClear();
  state.app!.emit('before-quit');
  let prevented = false;
  state.app!.emit('will-quit', { preventDefault() { prevented = true; } });
  // app.quit is called again only after the final queued write completes.
  if (prevented) await vi.waitFor(() => expect(app.quit).toHaveBeenCalled());
}
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('SMART_DIFF_DEV_URL', 'http://127.0.0.1:5173/');
  state.handlers.clear(); state.windows.length = 0; state.watchers.length = 0; state.selection = ''; state.failNextLoad = false; state.start = undefined;
  const root = await mkdtemp(join(tmpdir(), 'smart-diff-windows-'));
  roots.push(root); state.userData = join(root, 'profile');
});
afterEach(async () => {
  if (state.start) {
    await flushQuit();
    for (const window of state.windows) window.destroy();
    state.app!.emit('will-quit', { preventDefault() {} });
  }
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('repository window lifecycle', () => {
  it('creates a new plain project through the native location dialog and preserves existing destinations', async () => {
    await launch();
    const welcome = state.windows[0];
    await invoke(welcome, 'repository:create');
    expect(state.windows).toHaveLength(1);
    state.selection = join(roots[0], 'new project');
    await invoke(welcome, 'repository:create');
    const project = state.windows.at(-1)!;
    expect(await invoke(project, 'workspace:project')).toMatchObject({ name: 'new project', path: await realpath(state.selection) });
    expect((await invoke<RepositorySnapshot>(project, 'repository:last')).repository.gitAvailable).toBe(false);
    expect(welcome.destroyed).toBe(true);
    await expect(invoke(project, 'repository:create')).rejects.toThrow('already exists');
    expect(state.windows).toHaveLength(2);
  });

  it('validates clone URLs before the destination picker and opens only a successfully cloned project', async () => {
    await launch();
    const welcome = state.windows[0];
    const { dialog } = await import('electron');
    vi.mocked(dialog.showSaveDialog).mockClear();
    await expect(invoke(welcome, 'repository:clone', 'ext::command')).rejects.toThrow();
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
    const opening = await import('./project-opening');
    const clone = vi.spyOn(opening, 'cloneProjectDirectory').mockImplementation(async (_url, destination) => opening.createProjectDirectory(destination));
    await invoke(welcome, 'repository:clone', 'git@example.com:team/demo.git');
    expect(clone).not.toHaveBeenCalled();
    state.selection = join(roots[0], 'clone');
    await invoke(welcome, 'repository:clone', 'git@example.com:team/demo.git');
    expect(clone).toHaveBeenCalledWith('git@example.com:team/demo.git', state.selection, expect.any(AbortSignal));
    expect(await invoke(state.windows.at(-1)!, 'workspace:project')).toMatchObject({ path: await realpath(state.selection) });
    clone.mockRestore();
  });

  it('cancels an in-progress clone when its renderer reloads and rejects duplicate clone operations', async () => {
    await launch();
    const welcome = state.windows[0];
    const opening = await import('./project-opening');
    const clone = vi.spyOn(opening, 'cloneProjectDirectory').mockImplementation((_url, _destination, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('Cloning canceled.')), { once: true });
    }));
    state.selection = join(roots[0], 'clone');
    const pending = invoke(welcome, 'repository:clone', 'git@example.com:team/demo.git');
    const rejection = expect(pending).rejects.toThrow('Cloning canceled');
    await vi.waitFor(() => expect(clone).toHaveBeenCalledOnce());
    await expect(invoke(welcome, 'repository:clone', 'git@example.com:team/demo.git')).rejects.toThrow('already in progress');
    welcome.webContents.emit('did-start-navigation', {}, '', false, true);
    await rejection;
    expect(state.windows).toHaveLength(1);
    state.selection = '';
    await invoke(welcome, 'repository:clone', 'git@example.com:team/demo.git');
    clone.mockRestore();
  });

  it('shows the project shell before registration and grants repository access only after it finishes', async () => {
    const path = await repository(roots[0], 'slow-startup');
    await launch();
    const welcome = state.windows[0];
    const { GitService } = await import('./git');
    const original = GitService.prototype.registerRepository;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const register = vi.spyOn(GitService.prototype, 'registerRepository').mockImplementationOnce(async function (this: InstanceType<typeof GitService>, selected, options) {
      await blocked;
      return original.call(this, selected, options);
    });
    state.selection = path;
    const opening = invoke(welcome, 'repository:choose');
    try {
      await vi.waitFor(() => expect(state.windows.at(-1)?.shown).toBe(true));
      await vi.waitFor(() => expect(register).toHaveBeenCalledWith(path, { deferUntracked: true }));
      const project = state.windows.at(-1)!;
      expect(project).not.toBe(welcome);
      expect(project.options).toMatchObject({ width: 1380, height: 900 });
      expect(await invoke(project, 'workspace:project')).toEqual({ name: 'slow-startup', path });
      expect(await invoke(welcome, 'workspace:project')).toBeNull();
      expect(await invoke(project, 'repository:open')).toEqual([]);
      await expect(invoke(project, 'project:list', 'unissued-repository', null)).rejects.toThrow('does not belong');
      let loaded = false;
      const loading = invoke<RepositorySnapshot>(project, 'repository:last').then(snapshot => { loaded = true; return snapshot; });
      await new Promise(resolve => setImmediate(resolve));
      expect(loaded).toBe(false);
      expect(state.watchers).toHaveLength(0);
      expect(welcome.destroyed).toBe(false);
      release();
      const snapshot = await loading;
      expect(snapshot.repository.path).toBe(path);
      expect(await opening).toBeNull();
      expect(welcome.destroyed).toBe(true);
    } finally { release(); await opening; register.mockRestore(); }
  });

  it('does not publish or remember a project closed during its first scan', async () => {
    const path = await repository(roots[0], 'closed-startup');
    await launch();
    const welcome = state.windows[0];
    const { GitService } = await import('./git');
    const original = GitService.prototype.registerRepository;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const register = vi.spyOn(GitService.prototype, 'registerRepository').mockImplementationOnce(async function (this: InstanceType<typeof GitService>, selected, options) {
      await blocked;
      return original.call(this, selected, options);
    });
    state.selection = path;
    const opening = invoke(welcome, 'repository:choose');
    try {
      await vi.waitFor(() => expect(register).toHaveBeenCalled());
      const project = state.windows.at(-1)!;
      const loading = invoke(project, 'repository:last');
      const rejected = expect(loading).rejects.toThrow('Untrusted');
      project.close();
      release();
      await opening;
      await rejected;
      expect(welcome.destroyed).toBe(false);
      expect(state.windows.filter(window => !window.destroyed)).toEqual([welcome]);
      expect(state.watchers).toHaveLength(0);
      expect(await invoke(welcome, 'repository:recent')).toEqual([]);
      expect(await invoke(welcome, 'repository:open')).toEqual([]);
      await flushQuit();
      expect((await persisted()).windows).toEqual([]);
    } finally { release(); await opening; register.mockRestore(); }
  });

  it('shows every restored project before the first repository scan completes', async () => {
    const firstPath = await repository(roots[0], 'restore-first');
    const secondPath = await repository(roots[0], 'restore-second');
    const sessions = [
      { id: 'd0860be2-cb39-42ab-8936-5639eea734f5', path: firstPath },
      { id: '5407fac5-1218-4a0c-9723-d236608792df', path: secondPath },
    ];
    await mkdir(state.userData);
    await writeFile(join(state.userData, 'workspace.json'), JSON.stringify({ version: 1, windows: sessions }));
    const { GitService } = await import('./git');
    const original = GitService.prototype.registerRepository;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const register = vi.spyOn(GitService.prototype, 'registerRepository').mockImplementationOnce(async function (this: InstanceType<typeof GitService>, selected, options) {
      await blocked;
      return original.call(this, selected, options);
    });
    const starting = launch();
    try {
      await vi.waitFor(() => expect(state.windows.filter(window => window.shown)).toHaveLength(2));
      expect(register).toHaveBeenCalledTimes(1);
      for (const [index, session] of sessions.entries()) {
        expect(await invoke(state.windows[index], 'workspace:session')).toBe(session.id);
        expect(await invoke(state.windows[index], 'workspace:project')).toMatchObject({ path: session.path });
      }
      release();
      await starting;
      expect(register).toHaveBeenCalledTimes(2);
      await flushQuit();
      expect((await persisted()).windows).toEqual(sessions);
    } finally { release(); await starting; register.mockRestore(); }
  });

  it('shares one background scan across project windows and publishes its snapshot without another refresh', async () => {
    const path = await repository(roots[0], 'background');
    const otherPath = await repository(roots[0], 'other-background');
    await writeFile(join(path, 'untracked.txt'), 'later discovery\n');
    await launch();
    const first = await choose(state.windows[0], path);
    const duplicate = await choose(first, path);
    const other = await choose(first, otherPath);
    const { GitService } = await import('./git');
    const original = GitService.prototype.refreshRepository;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const refresh = vi.spyOn(GitService.prototype, 'refreshRepository').mockImplementationOnce(async function (this: InstanceType<typeof GitService>, id) {
      await blocked;
      return original.call(this, id);
    });
    try {
      const initial = await invoke<RepositorySnapshot>(first, 'repository:last');
      const same = await invoke<RepositorySnapshot>(duplicate, 'repository:last');
      expect(initial.untrackedPending).toBe(true);
      expect(initial.changes.map(change => change.path)).toEqual(['file.txt']);
      expect(same).toEqual(initial);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      const explicit = invoke<RepositorySnapshot>(first, 'repository:refresh', initial.repository.id);
      expect(refresh).toHaveBeenCalledTimes(1);
      release();
      const complete = await explicit;
      expect(complete.untrackedPending).not.toBe(true);
      expect(complete.changes.map(change => change.path)).toEqual(expect.arrayContaining(['file.txt', 'untracked.txt']));
      await vi.waitFor(() => expect(first.webContents.send).toHaveBeenCalledWith('repository:snapshot', complete));
      expect(duplicate.webContents.send).toHaveBeenCalledWith('repository:snapshot', complete);
      expect(other.webContents.send).not.toHaveBeenCalledWith('repository:snapshot', complete);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(first.webContents.send).not.toHaveBeenCalledWith('repository:changed', initial.repository.id);
    } finally { release(); refresh.mockRestore(); }
  });

  it('reports a failed background scan and preserves tracked changes for a later retry', async () => {
    const path = await repository(roots[0], 'background-failure');
    await launch();
    const first = await choose(state.windows[0], path);
    const { GitService } = await import('./git');
    const refresh = vi.spyOn(GitService.prototype, 'refreshRepository').mockRejectedValueOnce(new Error('Unable to discover untracked files'));
    try {
      const initial = await invoke<RepositorySnapshot>(first, 'repository:last');
      await vi.waitFor(() => expect(first.webContents.send).toHaveBeenCalledWith('repository:scan-error', initial.repository.id, 'Unable to discover untracked files'));
      const duplicate = await choose(first, path);
      const failed = await invoke<RepositorySnapshot>(duplicate, 'repository:last');
      expect(failed).toMatchObject({ changes: initial.changes, untrackedPending: false, untrackedError: 'Unable to discover untracked files' });
      const retried = await invoke<RepositorySnapshot>(first, 'repository:refresh', initial.repository.id);
      expect(retried.untrackedPending).not.toBe(true);
      expect(retried.untrackedError).toBeUndefined();
      expect(duplicate.webContents.send).toHaveBeenCalledWith('repository:snapshot', retried);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally { refresh.mockRestore(); }
  });

  it('refreshes tracked changes when reopening a project whose last window was closed', async () => {
    const path = await repository(roots[0], 'reopened');
    await launch();
    const first = await choose(state.windows[0], path);
    const initial = await invoke<RepositorySnapshot>(first, 'repository:last');
    await invoke<RepositorySnapshot>(first, 'repository:refresh', initial.repository.id);
    const { GitService } = await import('./git');
    const release = vi.spyOn(GitService.prototype, 'releaseRepository');
    first.close();
    const welcome = state.windows.at(-1)!;
    await vi.waitFor(() => expect(welcome.shown).toBe(true));
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(initial.repository.id, expect.any(Function)));
    await expect(release.mock.results[0].value).resolves.toBe(true);
    await writeFile(join(path, 'file.txt'), 'changed while closed\n');
    const reopened = await choose(welcome, path);
    const latest = await invoke<RepositorySnapshot>(reopened, 'repository:last');
    // Reopening reconstructs the snapshot with fresh capabilities, rather than
    // retaining every closed project's full index for the lifetime of the app.
    expect(latest.repository.id).not.toBe(initial.repository.id);
    expect(latest.untrackedPending).toBe(true);
    expect(latest.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'file.txt', group: 'unstaged', status: 'M' })]));
    release.mockRestore();
  });

  it('keeps shared repository data until its last window closes', async () => {
    const path = await repository(roots[0], 'shared-lifetime');
    await launch();
    const first = await choose(state.windows[0], path);
    const duplicate = await choose(first, path);
    const snapshot = await invoke<RepositorySnapshot>(first, 'repository:last');
    await invoke(first, 'repository:refresh', snapshot.repository.id);
    const { GitService } = await import('./git');
    const release = vi.spyOn(GitService.prototype, 'releaseRepository');
    try {
      first.close();
      await new Promise(resolve => setImmediate(resolve));
      expect(release).not.toHaveBeenCalled();
      expect((await invoke<RepositorySnapshot>(duplicate, 'repository:last')).repository.id).toBe(snapshot.repository.id);
      duplicate.close();
      await vi.waitFor(() => expect(release).toHaveBeenCalledWith(snapshot.repository.id, expect.any(Function)));
      await expect(release.mock.results[0].value).resolves.toBe(true);
    } finally { release.mockRestore(); }
  });

  it('returns the first snapshot without waiting for the initial watcher baseline', async () => {
    const path = await repository(roots[0], 'slow-watcher');
    await launch();
    const { RepositoryWatcher } = await import('./repository-watcher');
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const check = vi.spyOn(RepositoryWatcher.prototype, 'check').mockReturnValueOnce(blocked);
    try {
      const project = await choose(state.windows[0], path);
      expect(project.shown).toBe(true);
      expect(check).toHaveBeenCalledTimes(1);
      const initial = await invoke<RepositorySnapshot>(project, 'repository:last');
      expect(initial.repository.path).toBe(path);
      expect(initial.changes).toHaveLength(1);
    } finally { release(); check.mockRestore(); }
  });

  it('reuses the registration scan on first renderer load and refreshes on subsequent loads', async () => {
    const path = await repository(roots[0], 'startup');
    await launch();
    const { GitService } = await import('./git');
    const refresh = vi.spyOn(GitService.prototype, 'refreshRepository');
    try {
      const project = await choose(state.windows[0], path);
      expect(refresh).not.toHaveBeenCalled();
      const initial = await invoke<RepositorySnapshot>(project, 'repository:last');
      expect(initial.generation).toBe(1);
      expect(initial.untrackedPending).toBe(true);
      expect(refresh).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(project.webContents.send).toHaveBeenCalledWith('repository:snapshot', expect.objectContaining({ repository: initial.repository })));
      expect(refresh).toHaveBeenCalledTimes(1);
      await writeFile(join(path, 'after-load.txt'), 'new contents\n');
      project.webContents.emit('did-start-navigation', {}, project.webContents.mainFrame.url, false, true);
      const reloaded = await invoke<RepositorySnapshot>(project, 'repository:last');
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(reloaded.generation).toBeGreaterThan(initial.generation);
      expect(reloaded.changes.some(change => change.path === 'after-load.txt')).toBe(true);
    } finally { refresh.mockRestore(); }
  });

  it('skips the first-show focus notification but refreshes after later focus events', async () => {
    const path = await repository(roots[0], 'startup-focus');
    await launch();
    const project = await choose(state.windows[0], path);
    const snapshot = await invoke<RepositorySnapshot>(project, 'repository:last');
    await new Promise(resolve => setTimeout(resolve, 220));
    expect(project.webContents.send).not.toHaveBeenCalledWith('repository:changed', snapshot.repository.id);
    project.focus();
    await vi.waitFor(() => expect(project.webContents.send).toHaveBeenCalledWith('repository:changed', snapshot.repository.id));
  });

  it('returns the latest backend snapshot if another refresh finishes before first renderer load', async () => {
    const path = await repository(roots[0], 'startup-newer');
    await launch();
    const { GitService } = await import('./git');
    const refresh = vi.spyOn(GitService.prototype, 'refreshRepository');
    try {
      const project = await choose(state.windows[0], path);
      const [repository] = await invoke<Array<RepositorySnapshot['repository']>>(project, 'repository:open');
      await writeFile(join(path, 'newer.txt'), 'newer snapshot\n');
      const latest = await invoke<RepositorySnapshot>(project, 'repository:refresh', repository.id);
      const initial = await invoke<RepositorySnapshot>(project, 'repository:last');
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(initial).toEqual(latest);
      expect(initial.changes.some(change => change.path === 'newer.txt')).toBe(true);
    } finally { refresh.mockRestore(); }
  });

  it('invalidates the initial snapshot when the repository watcher observes a change', async () => {
    const path = await repository(roots[0], 'startup-changed');
    await launch();
    const { GitService } = await import('./git');
    const refresh = vi.spyOn(GitService.prototype, 'refreshRepository');
    try {
      const project = await choose(state.windows[0], path);
      await writeFile(join(path, 'changed-before-load.txt'), 'changed before renderer startup\n');
      state.watchers[0].onChange();
      const snapshot = await invoke<RepositorySnapshot>(project, 'repository:last');
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(snapshot.changes.some(change => change.path === 'changed-before-load.txt')).toBe(true);
    } finally { refresh.mockRestore(); }
  });

  it('keeps a compact welcome on cancel or failure and closes it only after a project loads', async () => {
    const path = await repository(roots[0], 'first');
    await launch();
    const welcome = state.windows[0];
    expect(welcome.options).toMatchObject({ width: 760, height: 520, minWidth: 560, minHeight: 400, show: false });
    expect(welcome.shown).toBe(true);
    expect(await invoke(welcome, 'repository:last')).toBeNull();
    expect(await invoke(welcome, 'repository:choose')).toBeNull();
    expect(state.windows).toHaveLength(1);
    state.selection = join(roots[0], 'missing');
    await expect(invoke(welcome, 'repository:choose')).rejects.toThrow();
    expect(welcome.destroyed).toBe(false);
    expect(state.windows.at(-1)?.destroyed).toBe(true);
    state.selection = path; state.failNextLoad = true;
    await expect(invoke(welcome, 'repository:choose')).rejects.toThrow('Renderer failed to load');
    expect(welcome.destroyed).toBe(false);
    expect(state.windows.at(-1)?.destroyed).toBe(true);
    expect(state.windows.at(-1)?.shown).toBe(false);
    expect(await invoke(welcome, 'repository:recent')).toEqual([]);
    const project = await choose(welcome, path);
    expect(project.options).toMatchObject({ width: 1380, height: 900, show: false });
    expect(project.shown).toBe(true);
    expect(welcome.destroyed).toBe(true);
  });

  it('opens recent projects using stored identities, focuses existing projects and retains unavailable history', async () => {
    const path = await repository(roots[0], 'first');
    const secondPath = await repository(roots[0], 'second');
    await launch();
    const project = await choose(state.windows[0], path);
    const [recent] = await invoke<RecentProject[]>(project, 'repository:recent');
    expect(recent).toMatchObject({ id: expect.any(String), name: 'first', path, lastOpenedAt: expect.any(Number) });
    await expect(invoke(project, 'repository:open-recent', path)).rejects.toThrow('Unknown recent project');
    const second = await choose(project, secondPath);
    await invoke(second, 'repository:open-recent', recent.id);
    expect(project.focused).toBe(true);
    expect(state.windows).toHaveLength(3);
    second.destroy(); project.destroy();
    const welcome = state.windows.at(-1)!;
    await vi.waitFor(() => expect(welcome.shown).toBe(true));
    await invoke(welcome, 'repository:open-recent', recent.id);
    expect(welcome.destroyed).toBe(true);
    const reopened = state.windows.at(-1)!;
    expect((await invoke<RepositorySnapshot>(reopened, 'repository:last')).repository.path).toBe(path);
    reopened.destroy();
    const nextWelcome = state.windows.at(-1)!;
    await vi.waitFor(() => expect(nextWelcome.shown).toBe(true));
    await rm(path, { recursive: true });
    await expect(invoke(nextWelcome, 'repository:open-recent', recent.id)).rejects.toThrow();
    expect(nextWelcome.destroyed).toBe(false);
    expect(await invoke<RecentProject[]>(nextWelcome, 'repository:recent')).toContainEqual(expect.objectContaining({ id: recent.id, path }));
  });

  it('keeps missing restored locations in recent projects and falls back to one welcome', async () => {
    const path = join(roots[0], 'removed-project');
    await mkdir(state.userData);
    await writeFile(join(state.userData, 'repository.json'), JSON.stringify({ path }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await launch();
      const [welcome] = state.windows.filter(window => !window.destroyed);
      expect(state.windows.filter(window => !window.destroyed)).toHaveLength(1);
      expect(await invoke(welcome, 'repository:last')).toBeNull();
      expect(await invoke(welcome, 'repository:recent')).toEqual([expect.objectContaining({ path })]);
      await flushQuit();
      expect((await persisted()).windows).toEqual([]);
      expect(JSON.parse(await readFile(join(state.userData, 'recent-projects.json'), 'utf8')).projects).toEqual([expect.objectContaining({ path })]);
    } finally { error.mockRestore(); }
  });

  it('scopes search and directory grants to their window and revokes them on reload', async () => {
    const path = await repository(roots[0], 'search');
    const otherPath = await repository(roots[0], 'other');
    await launch();
    const welcome = state.windows[0];
    const first = await choose(welcome, path);
    const duplicate = await choose(first, path);
    const other = await choose(first, otherPath);
    const { repository: repo } = await invoke<RepositorySnapshot>(first, 'repository:last');
    const request = { requestId: 'first-search', query: 'first' };
    await expect(invoke(welcome, 'search:start', repo.id, request)).rejects.toThrow('Untrusted');
    await expect(invoke(other, 'search:start', repo.id, request)).rejects.toThrow('does not belong');
    await expect(invoke(first, 'search:start', repo.id, { ...request, directoryId: '/tmp' })).rejects.toThrow();
    await expect(invoke(first, 'search:start', repo.id, { ...request, query: 'x'.repeat(513) })).rejects.toThrow();
    state.selection = path;
    const directory = await invoke<SearchDirectory>(first, 'search:choose-directory', repo.id);
    await expect(invoke(duplicate, 'search:start', repo.id, { ...request, directoryId: directory.id })).rejects.toThrow();
    first.webContents.send.mockClear(); duplicate.webContents.send.mockClear();
    await invoke(first, 'search:start', repo.id, { ...request, directoryId: directory.id });
    await vi.waitFor(() => expect(first.webContents.send).toHaveBeenCalledWith('search:batch', expect.objectContaining({ done: true, occurrences: 1 })));
    const batches = first.webContents.send.mock.calls.filter(([name]) => name === 'search:batch').map(([, batch]) => batch as FileSearchBatch);
    const match = batches.flatMap(batch => batch.results)[0];
    expect(match.entry.path).toBe('file.txt');
    expect(await invoke(first, 'project:read', repo.id, match.entry.id)).toMatchObject({ state: 'text', content: { text: 'first\n' } });
    expect(duplicate.webContents.send).not.toHaveBeenCalledWith('search:batch', expect.anything());
    first.webContents.emit('did-start-navigation', {}, first.webContents.mainFrame.url, false, true);
    await expect(invoke(first, 'search:start', repo.id, { ...request, directoryId: directory.id })).rejects.toThrow();
  });

  it('always opens new windows and keeps reloads and filesystem capabilities isolated', async () => {
    const firstPath = await repository(roots[0], 'first');
    const secondPath = await repository(roots[0], 'second');
    await launch();
    const welcome = state.windows[0];
    expect(await invoke(welcome, 'repository:last')).toBeNull();
    const first = await choose(welcome, firstPath);
    const firstSnapshot = await invoke<RepositorySnapshot>(first, 'repository:last');
    const second = await choose(first, secondPath);
    const secondSnapshot = await invoke<RepositorySnapshot>(second, 'repository:last');
    const duplicate = await choose(first, firstPath);
    expect(state.windows).toHaveLength(4);
    expect(welcome.destroyed).toBe(true);
    expect((await invoke<RepositorySnapshot>(first, 'repository:last')).repository).toEqual(firstSnapshot.repository);
    expect((await invoke<RepositorySnapshot>(duplicate, 'repository:last')).repository.id).toBe(firstSnapshot.repository.id);
    expect(await invoke(first, 'workspace:session')).not.toBe(await invoke(duplicate, 'workspace:session'));
    await expect(invoke(first, 'project:list', secondSnapshot.repository.id, null)).rejects.toThrow('does not belong');
    await expect(invoke(welcome, 'repository:refresh', firstSnapshot.repository.id)).rejects.toThrow('Untrusted');
    expect(await invoke(first, 'repository:activate', secondSnapshot.repository.id)).toBeNull();
    expect(second.focused).toBe(true);
    expect((await invoke<RepositorySnapshot>(first, 'repository:last')).repository.id).toBe(firstSnapshot.repository.id);
    await expect(state.handlers.get('repository:last')!({ sender: first.webContents, senderFrame: { url: first.webContents.mainFrame.url } })).rejects.toThrow('Untrusted');
    first.destroy();
    expect(state.watchers[0].disposed).toBe(true);
    expect(state.watchers[1].disposed).toBe(false);
    expect((await invoke<RepositorySnapshot>(second, 'repository:last')).repository.id).toBe(secondSnapshot.repository.id);
  });

  it('notifies every window showing a changed repository and never other repositories', async () => {
    const firstPath = await repository(roots[0], 'first');
    const secondPath = await repository(roots[0], 'second');
    await launch();
    const welcome = state.windows[0];
    const first = await choose(welcome, firstPath);
    const duplicate = await choose(first, firstPath);
    const other = await choose(first, secondPath);
    const snapshot = await invoke<RepositorySnapshot>(first, 'repository:last');
    for (const window of state.windows) window.webContents.send.mockClear();
    state.watchers[0].onChange();
    await vi.waitFor(() => expect(first.webContents.send).toHaveBeenCalledWith('repository:changed', snapshot.repository.id));
    expect(duplicate.webContents.send).toHaveBeenCalledWith('repository:changed', snapshot.repository.id);
    expect(other.webContents.send).not.toHaveBeenCalledWith('repository:changed', snapshot.repository.id);
    expect(welcome.webContents.send).not.toHaveBeenCalled();
  });

  it('restores canonical paths and stable window sessions, with fresh Git capabilities', async () => {
    const path = await repository(roots[0], 'first');
    await mkdir(state.userData);
    await writeFile(join(state.userData, 'repository.json'), JSON.stringify({ path }));
    await launch();
    const first = state.windows[0];
    const snapshot = await invoke<RepositorySnapshot>(first, 'repository:last');
    const sessionId = await invoke<string>(first, 'workspace:session');
    const duplicate = await choose(first, path);
    const duplicateId = await invoke<string>(duplicate, 'workspace:session');
    await flushQuit();
    first.destroy(); duplicate.destroy();
    expect((await persisted()).windows).toEqual([{ id: sessionId, path }, { id: duplicateId, path }]);
    state.app!.emit('will-quit', { preventDefault() {} });
    vi.resetModules(); state.windows.length = 0; state.watchers.length = 0; state.handlers.clear();
    await launch();
    expect(state.windows).toHaveLength(2);
    expect(await invoke(state.windows[0], 'workspace:session')).toBe(sessionId);
    expect(await invoke(state.windows[1], 'workspace:session')).toBe(duplicateId);
    const restored = await invoke<RepositorySnapshot>(state.windows[0], 'repository:last');
    expect(restored.repository.path).toBe(path);
    expect(restored.repository.id).not.toBe(snapshot.repository.id);
    await expect(invoke(state.windows[0], 'repository:read', restored.repository.id, snapshot.changes[0].id)).resolves.toMatchObject({ state: 'stale' });
  });

  it('resumes normal close persistence after an unsaved editor cancels quit', async () => {
    const path = await repository(roots[0], 'first');
    await launch();
    const first = await choose(state.windows[0], path);
    const duplicate = await choose(first, path);
    const duplicateId = await invoke<string>(duplicate, 'workspace:session');
    state.app!.emit('before-quit');
    first.webContents.emit('will-prevent-unload');
    first.destroy();
    await flushQuit();
    expect((await persisted()).windows).toEqual([{ id: duplicateId, path }]);
  });

  it('removes normally closed windows and returns to welcome after an empty session', async () => {
    const path = await repository(roots[0], 'first');
    await launch();
    const first = await choose(state.windows[0], path);
    first.destroy();
    await flushQuit();
    expect((await persisted()).windows).toEqual([]);
    state.app!.emit('will-quit', { preventDefault() {} });
    vi.resetModules(); state.windows.length = 0; state.watchers.length = 0; state.handlers.clear();
    await launch();
    expect(state.windows).toHaveLength(1);
    expect(await invoke(state.windows[0], 'repository:last')).toBeNull();
  });
});
