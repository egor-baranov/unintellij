/** Read-only production Electron check of project opening and a real comparison.
 * Usage: npx tsx scripts/smoke-repository-loading.ts /path/to/repository changed-file
 * Choose a repository-relative modified UTF-8 text file (up to 1 MiB).
 * The repository needs a second modified text file for the tab-revisit check.
 * Build desktop first. Writes are limited to a disposable profile and artifacts.
 * No repository contents, Git status/index, or user application profile is written. */
import { _electron as electron, expect as baseExpect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { FileComparison, RepositorySnapshot } from '../apps/desktop/src/bridge';
import { captureWindow } from './electron-smoke-windows';

interface ReadTiming {
  channel: string; sender: number; startedAt: number; completedAt?: number;
  path?: string; state?: string; changeCount?: number; untrackedPending?: boolean;
  candidatePaths?: string[]; error?: string;
}
interface WindowTiming { id: number; createdAt: number; shownAt?: number }
interface RendererTiming { projectShellAt?: number; workspaceAt?: number }

const input = process.argv[2];
const fileArgument = process.argv[3];
if (!input || !fileArgument) throw new Error('Usage: npx tsx scripts/smoke-repository-loading.ts /path/to/repository changed-file');
const repository = await realpath(resolve(input));
const readComparisonFile = async (path: string) => {
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('The comparison file must be repository-relative and outside Git internals.');
  }
  const target = resolve(repository, path);
  const contained = relative(repository, await realpath(target));
  if (!contained || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained) || contained.split(sep).some(part => part.toLowerCase() === '.git')) {
    throw new Error('The comparison file must stay inside the repository and outside Git internals.');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Choose a regular text comparison file no larger than 1 MiB.');
  const bytes = await readFile(target);
  if (!bytes.length || bytes.includes(0)) throw new Error('Choose a nonempty UTF-8 text comparison file.');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Choose a UTF-8 text comparison file.'); }
  return bytes;
};
if (!(await stat(repository)).isDirectory()) throw new Error('Expected a repository directory.');
const fileBytes = await readComparisonFile(fileArgument);
const filePath = relative(repository, resolve(repository, fileArgument)).split(sep).join('/');
const target = resolve(repository, filePath);
const run = promisify(execFile);
const git = async (...args: string[]) => (await run('git', ['--no-optional-locks', '--literal-pathspecs', '-C', repository, ...args], {
  shell: false, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 32 * 1024 * 1024,
})).stdout.trim();
if (await realpath(await git('rev-parse', '--show-toplevel')) !== repository) throw new Error('Use the repository root directory.');
if (!await git('diff', '--name-only', '--diff-filter=M', 'HEAD', '--', filePath)) throw new Error('The supplied comparison file must be a modified file with a real HEAD-to-working-tree change.');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const indexPath = resolve(repository, await git('rev-parse', '--git-path', 'index'));
const before = { head: await git('rev-parse', 'HEAD'), indexHash: hash(await readFile(indexPath)), fileHash: hash(fileBytes) };
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-repository-loading-'));
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/repository-loading');
await Promise.all([mkdir(profile), mkdir(artifacts, { recursive: true })]);
const bootstrap = join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
globalThis.repositoryLoadingWindows = [];
BrowserWindow.prototype.show = function () {
  const timing = globalThis.repositoryLoadingWindows.find(item => item.id === this.webContents.id);
  if (timing) timing.shownAt = Date.now();
  this.webContents.setBackgroundThrottling(false); this.hide();
};
BrowserWindow.prototype.focus = function () {};
app.on('browser-window-created', (_event, window) => {
  globalThis.repositoryLoadingWindows.push({ id: window.webContents.id, createdAt: Date.now() });
  window.setOpacity(0); window.setIgnoreMouseEvents(true); window.setFocusable(false);
  window.webContents.setBackgroundThrottling(false);
});
require(${JSON.stringify(resolve('apps/desktop/dist/index.cjs'))});
`);

const expect = baseExpect.configure({ timeout: 90000 });
const errors: string[] = [];
const timings: Record<string, number | null> = {};
const application = await electron.launch({
  args: [bootstrap, `--user-data-dir=${profile}`],
  env: { ...process.env, SMART_DIFF_DEV_URL: '', GIT_OPTIONAL_LOCKS: '0' }, timeout: 60000,
});
let page: Page | undefined;
const readTimings = () => application.evaluate(() => Reflect.get(globalThis, 'repositoryLoadingReads') as ReadTiming[]);
const capture = async (page: Page, name: string) => {
  const window = await application.browserWindow(page);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // macOS needs a compositor frame: opacity zero and nonfocusable preserve
    // the user's desktop, then the native window is hidden again immediately.
    await window.evaluate(window => window.showInactive());
    const png = await Promise.race([
      captureWindow(application, page),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Native capture timed out after 8 seconds.')), 8000); }),
    ]);
    await writeFile(join(artifacts, name), png);
  } finally {
    clearTimeout(deadline);
    await window.evaluate(window => window.hide()).catch(() => {});
    await window.dispose();
  }
};

try {
  const welcome = await application.firstWindow();
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  await welcome.evaluate(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
  // Observe each new renderer from its first DOM mutation. This catches a
  // short-lived genuine shell even when the initial Git snapshot is fast.
  // A literal script avoids tsx's function-name helper leaking into a newly
  // created renderer, where the test runner's helper is intentionally absent.
  await application.context().addInitScript(`(() => {
    const times = {};
    Reflect.set(window, 'repositoryLoadingRenderer', times);
    const observe = () => {
      const visible = selector => {
        const element = document.querySelector(selector);
        return !!element && element.getBoundingClientRect().height > 0;
      };
      if (!times.projectShellAt && visible('.project-loading-screen .project-loading-name')) times.projectShellAt = Date.now();
      if (!times.workspaceAt && visible('[aria-label="Project switcher"]')) {
        times.workspaceAt = Date.now();
        observer.disconnect();
      }
    };
    const observer = new MutationObserver(observe);
    observer.observe(document, { subtree: true, childList: true, attributes: true });
    document.addEventListener('DOMContentLoaded', observe);
  })();`);
  await application.evaluate(({ app, dialog, ipcMain }, repository) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] });
    type Handler = (event: import('electron').IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler> | undefined;
    if (!(handlers instanceof Map)) throw new Error('Electron IPC timing adapter unavailable.');
    const reads: ReadTiming[] = [];
    Reflect.set(globalThis, 'repositoryLoadingReads', reads);
    app.on('browser-window-created', (_event, window) => {
      const original = window.webContents.send;
      window.webContents.send = function (channel, ...args: unknown[]) {
        if (channel === 'repository:snapshot') {
          const snapshot = args[0] as RepositorySnapshot;
          reads.push({ channel, sender: window.webContents.id, startedAt: Date.now(), completedAt: Date.now(),
            changeCount: (snapshot.workingChanges ?? snapshot.changes).length, untrackedPending: !!snapshot.untrackedPending });
        } else if (channel === 'repository:scan-error') {
          reads.push({ channel, sender: window.webContents.id, startedAt: Date.now(), error: String(args[1]) });
        }
        original.call(this, channel, ...args);
      };
    });
    for (const channel of ['repository:choose', 'workspace:project', 'repository:last', 'repository:refresh', 'repository:read']) {
      const original = handlers.get(channel);
      if (!original) throw new Error(`Missing genuine IPC handler: ${channel}`);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        const timing: ReadTiming = { channel, sender: event.sender.id, startedAt: Date.now() };
        reads.push(timing);
        try {
          const result = await original(event, ...args);
          const value = result as (Partial<RepositorySnapshot> & Partial<FileComparison>) | null;
          timing.completedAt = Date.now();
          if (value?.path) timing.path = value.path;
          if (value?.state) timing.state = value.state;
          if (value?.changes) {
            const changes = value.workingChanges ?? value.changes;
            timing.changeCount = changes.length;
            timing.untrackedPending = !!value.untrackedPending;
            timing.candidatePaths = changes.filter(change => change.group === 'working' && change.status === 'M' && !change.unsupported).map(change => change.path);
          }
          return result;
        } catch (error) { timing.completedAt = Date.now(); timing.error = String(error); throw error; }
      });
    }
  }, repository);
  const requestedAt = Date.now();
  [page] = await Promise.all([
    application.waitForEvent('window', { timeout: 90000 }),
    welcome.getByRole('button', { name: 'Open…', exact: true }).click({ timeout: 60000 }),
  ]);
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const window = await application.browserWindow(page);
  const windowId = await window.evaluate(window => { window.setContentSize(1440, 980); return window.webContents.id; });
  await window.dispose();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.project-loading-screen, [aria-label="Project switcher"]').first()).toBeVisible();
  const windowTimes = await application.evaluate(() => Reflect.get(globalThis, 'repositoryLoadingWindows') as WindowTiming[]);
  const projectWindow = windowTimes.find(window => window.id === windowId)!;
  const request = (await readTimings()).find(read => read.channel === 'repository:choose');
  const opening = request?.startedAt ?? requestedAt;
  timings.requestToNativeWindowMs = projectWindow.createdAt - opening;
  timings.requestToNativeShowCallMs = projectWindow.shownAt ? projectWindow.shownAt - opening : null;
  await expect(page.getByRole('button', { name: 'Project switcher', exact: true })).toContainText(basename(repository));
  await expect.poll(async () => (await readTimings()).find(read => read.channel === 'repository:last' && read.sender === windowId)?.completedAt).toBeTruthy();
  const snapshot = (await readTimings()).find(read => read.channel === 'repository:last' && read.sender === windowId)!;
  expect(snapshot.untrackedPending).toBe(true);
  const renderer = await page.evaluate(() => Reflect.get(window, 'repositoryLoadingRenderer') as RendererTiming);
  timings.requestToProjectShellMs = renderer.projectShellAt ? renderer.projectShellAt - opening : null;
  timings.requestToSnapshotMs = snapshot.completedAt! - opening;
  timings.requestToWorkspaceMs = renderer.workspaceAt ? renderer.workspaceAt - opening : null;
  const shellBeforeSnapshot = !!renderer.projectShellAt && renderer.projectShellAt <= snapshot.completedAt!;
  // The native window always precedes repository initialization. A very fast
  // snapshot may finish before React needs to display its loading shell.
  expect(projectWindow.createdAt).toBeLessThanOrEqual(snapshot.completedAt!);
  const commit = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true });
  if (await commit.getAttribute('aria-pressed') !== 'true') await commit.click();
  const pendingFiles = page.locator('.commit-pending-files');
  await expect(pendingFiles).toHaveText('Loading unversioned files…');
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  const row = page.getByRole('treeitem', { name: `${filePath} (working)`, exact: true });
  await expect(row).toBeVisible();
  const selectedAt = Date.now();
  await row.click();
  const comparison = page.getByRole('main', { name: 'Selected file comparison', exact: true });
  const expectComparison = async (path: string) => {
    await expect(comparison).toHaveAttribute('data-path', path);
    await expect(comparison).toHaveAttribute('data-original-path', path);
    await expect(comparison.locator('.source-headers')).toHaveCount(0);
    await expect(comparison.locator('.smart-diff[data-status="ready"]')).toBeVisible();
    for (const side of ['original', 'modified']) {
      const pane = comparison.locator(`.smart-diff-pane[data-side="${side}"]`);
      await expect(pane.locator('.monaco-editor')).toBeVisible();
      await expect(pane.locator('.view-line').first()).toBeVisible();
      await expect.poll(async () => (await pane.locator('.view-lines').innerText()).trim().length).toBeGreaterThan(0);
    }
    await expect(comparison.getByRole('heading', { name: 'Loading comparison…', exact: true })).toHaveCount(0);
  };
  await expectComparison(filePath);
  const comparisonReadyAt = Date.now();
  timings.selectToRenderedComparisonMs = Date.now() - selectedAt;
  const read = (await readTimings()).find(read => read.channel === 'repository:read' && read.path === filePath && read.state === 'text');
  expect(read).toBeTruthy();
  timings.comparisonIpcMs = read!.completedAt! - read!.startedAt;
  const completedBeforeComparison = (await readTimings()).find(read => read.channel === 'repository:snapshot' && read.sender === windowId && !read.untrackedPending && read.completedAt! <= comparisonReadyAt);
  const comparisonBeforeFullSnapshot = !completedBeforeComparison;
  expect(comparisonBeforeFullSnapshot).toBe(true);
  await expect(pendingFiles).toHaveText('Loading unversioned files…');
  let secondPath: string | undefined;
  for (const candidate of snapshot.candidatePaths ?? []) {
    if (candidate !== filePath && await readComparisonFile(candidate).then(() => true, () => false)) { secondPath = candidate; break; }
  }
  if (!secondPath) throw new Error('Choose a repository with a second modified UTF-8 text file (up to 1 MiB) to verify revisiting a loaded tab.');
  const secondSelectedAt = Date.now();
  await page.getByRole('treeitem', { name: `${secondPath} (working)`, exact: true }).click();
  await expectComparison(secondPath);
  timings.secondSelectToRenderedComparisonMs = Date.now() - secondSelectedAt;
  const revisitedAt = Date.now();
  await page.getByRole('tab', { name: `Commit: ${filePath} — working`, exact: true }).click();
  await expectComparison(filePath);
  timings.revisitToRenderedComparisonMs = Date.now() - revisitedAt;
  const selectedInstance = await comparison.getAttribute('data-instance-id');
  await expect.poll(async () => (await readTimings()).find(read => read.channel === 'repository:snapshot' && read.sender === windowId && !read.untrackedPending)?.completedAt, { timeout: 90000 }).toBeTruthy();
  const fullSnapshot = (await readTimings()).find(read => read.channel === 'repository:snapshot' && read.sender === windowId && !read.untrackedPending)!;
  timings.requestToFullSnapshotMs = fullSnapshot.completedAt! - opening;
  await expect(pendingFiles).toHaveCount(0);
  await expect(page.getByRole('tree', { name: 'Changed files', exact: true })).toHaveAttribute('aria-busy', 'false');
  await expectComparison(filePath);
  await expect(comparison).toHaveAttribute('data-instance-id', selectedInstance!);
  await expect(page.locator('.notice[role="alert"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  const readOnlyObservations = {
    headUnchanged: await git('rev-parse', 'HEAD') === before.head,
    indexHashUnchanged: hash(await readFile(indexPath)) === before.indexHash,
    openedFileHashUnchanged: hash(await readFile(target)) === before.fileHash,
  };
  await capture(page, 'comparison.png');
  const reads = await readTimings();
  const finalWindowTiming = await application.evaluate((_, id) => (Reflect.get(globalThis, 'repositoryLoadingWindows') as WindowTiming[]).find(window => window.id === id), windowId);
  timings.requestToNativeShowCallMs = finalWindowTiming?.shownAt ? finalWindowTiming.shownAt - opening : null;
  expect(reads.filter(read => read.error)).toEqual([]);
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({
    repository, filePath, profileIsolated: true, fileBytes: fileBytes.length, timings,
    snapshotChangeCount: snapshot.changeCount, fullSnapshotChangeCount: fullSnapshot.changeCount,
    initialUntrackedPending: snapshot.untrackedPending, shellBeforeSnapshot, comparisonBeforeFullSnapshot,
    secondPath, renderer, nativeWindow: finalWindowTiming,
    rendererErrors: errors, ipcReads: reads, readOnlyObservations,
    checks: ['hidden before first native show', 'real project window and tracked snapshot', 'actual changed file selected in Commit tree', 'both Monaco panes render real text before full scan', 'diff worker ready', 'second comparison opens', 'first comparison revisited', 'background snapshot preserves selected comparison', 'unversioned loading clears', 'no loading comparison left'],
    screenshot: join(artifacts, 'comparison.png'),
    captureMode: 'Transparent, nonfocusable native window; hidden again after capture.',
  }, null, 2));
  await Promise.all(['failure.txt', 'failure.png'].map(name => rm(join(artifacts, name), { force: true })));
  console.log(JSON.stringify({ result: 'PASS', repository, filePath, timings, shellBeforeSnapshot, comparisonBeforeFullSnapshot, readOnlyObservations }, null, 2));
} catch (error) {
  await writeFile(join(artifacts, 'failure.txt'), JSON.stringify({
    message: error instanceof Error ? error.stack ?? error.message : String(error), timings,
    ipcReads: await readTimings().catch(() => undefined), rendererErrors: errors,
    body: page ? await page.locator('body').innerText().catch(() => '') : undefined,
  }, null, 2));
  if (page) await capture(page, 'failure.png').catch(() => {});
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
