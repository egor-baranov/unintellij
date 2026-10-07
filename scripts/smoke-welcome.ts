/** Production Electron welcome/history/session check. Build first. All projects and
 * application data are disposable; native windows stay hidden during assertions. */
import { _electron as electron, expect as baseExpect, type ElectronApplication, type Page } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 15000 });
const run = promisify(execFile);
// A disposable home-relative location exercises the backend's real ~/ display path.
const directory = await mkdtemp(join(homedir(), '.smart-diff-welcome-'));
const profile = join(directory, 'profile');
const firstRepository = join(directory, 'first-project');
const secondRepository = join(directory, 'second-project');
const createdProject = join(directory, 'created-project');
const clonedProject = join(directory, 'cloned-project');
const bootstrap = join(directory, 'bootstrap.cjs');
const artifacts = resolve('artifacts/welcome');
const checks: string[] = [], screenshots: string[] = [], errors: string[] = [];
let application: ElectronApplication | undefined;
let active: Page | undefined;
let daemon: ChildProcess | undefined;
const pass = (message: string) => { checks.push(message); console.log(`PASS: ${message}`); };

async function fixture(path: string) {
  await mkdir(path);
  const git = (...args: string[]) => run('git', ['-C', path, ...args], { shell: false });
  await git('init', '-q', '-b', 'main');
  await writeFile(join(path, 'sample.ts'), Array.from({ length: 150 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join('\n') + '\n');
  await writeFile(join(path, 'notes.ts'), 'export const notes = "Welcome fixture";\n');
  await git('add', '.');
  await git('-c', 'user.name=Welcome Smoke', '-c', 'user.email=welcome@example.invalid', 'commit', '-qm', 'Disposable welcome fixture');
}
async function launch() {
  application = await electron.launch({
    args: [bootstrap, `--user-data-dir=${profile}`],
    env: { ...process.env, SMART_DIFF_DEV_URL: '' },
  });
  const track = (page: Page) => {
    page.on('pageerror', error => errors.push(error.message));
    void hideWindow(application!, page).catch(() => {});
  };
  application.windows().forEach(track);
  application.on('window', track);
  active = await application.firstWindow();
  await hideWindow(application, active);
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
}
async function localCloneUrl() {
  // Only upload-pack on loopback is used. No external service, credentials,
  // project configuration or shell interpolation participates in the clone.
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve the fixture Git daemon port');
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  daemon = spawn('git', ['daemon', '--reuseaddr', '--export-all', `--base-path=${directory}`, '--listen=127.0.0.1', `--port=${address.port}`, directory], { shell: false, stdio: 'ignore' });
  const url = `git://127.0.0.1:${address.port}/first-project`;
  await expect.poll(async () => {
    if (daemon!.exitCode !== null) throw new Error('Fixture Git daemon exited before cloning');
    return run('git', ['ls-remote', url], { shell: false, timeout: 2000 }).then(result => result.stdout.includes('HEAD'), () => false);
  }).toBe(true);
  return url;
}
async function stopDaemon() {
  const process = daemon;
  daemon = undefined;
  if (!process || process.exitCode !== null) return;
  const closed = new Promise<void>(resolve => process.once('exit', () => resolve()));
  process.kill();
  await closed;
}
async function capture(page: Page, name: string) {
  await writeFile(join(artifacts, name), await captureWindow(application!, page));
  screenshots.push(name);
}
async function welcomeReady(page: Page) {
  active = page;
  await hideWindow(application!, page);
  await expect(page.getByRole('main', { name: 'Welcome', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByText('Loading recent projects…', { exact: true })).toHaveCount(0);
  await expect(page.locator('.editor-workspace, .commit-panel, [aria-label="Workspace view"]')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
}
async function choose(origin: Page, path: string, welcome: boolean) {
  await application!.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
  const page = await openRepositoryWindow(application!, async () => {
    if (welcome) await origin.getByRole('button', { name: 'Open…', exact: true }).click();
    else {
      await origin.getByRole('button', { name: 'Project switcher', exact: true }).click();
      await origin.getByRole('menuitem', { name: 'Open…', exact: true }).click();
    }
  });
  active = page;
  await expect(page.getByRole('button', { name: 'Project switcher', exact: true })).toContainText(basename(path));
  return page;
}
async function closeToWelcome(page: Page) {
  const opened = application!.waitForEvent('window');
  const window = await application!.browserWindow(page);
  try { await window.evaluate(window => window.close()); } finally { await window.dispose(); }
  const welcome = await opened;
  await welcomeReady(welcome);
  await expect.poll(() => page.isClosed()).toBe(true);
  return welcome;
}
async function normalFile(page: Page, name: string) {
  const project = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true });
  if (await project.getAttribute('aria-pressed') !== 'true') await project.click();
  await page.getByRole('tree', { name: 'Project files', exact: true }).getByRole('treeitem', { name, exact: true }).click();
  await expect(page.getByTestId('file-surface')).toHaveAttribute('data-path', name);
  await expect(page.getByTestId('file-surface')).toHaveAttribute('data-editable', 'true');
}
async function tabs(page: Page) {
  return page.getByRole('region', { name: 'Editor group 1', exact: true }).getByRole('tab').evaluateAll(tabs => tabs.map(tab => ({
    name: tab.getAttribute('aria-label'), active: tab.getAttribute('aria-selected'), id: tab.getAttribute('data-instance-id'),
  })));
}
async function editorViewport(page: Page) {
  return page.getByTestId('file-surface').locator('.monaco-editor').evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('.view-line')]
      .filter(line => { const rect = line.getBoundingClientRect(); return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 8; })
      .slice(0, 3).map(line => ({ text: line.textContent, top: Math.round(line.getBoundingClientRect().top - bounds.top) }));
  });
}
async function restored(path: string) {
  let result: Page | undefined;
  await expect.poll(async () => {
    for (const page of application!.windows()) {
      try {
        if ((await page.evaluate(async () => (await window.desktop.getLastRepository())?.repository.path)) === path) {
          result = page; return true;
        }
      } catch { /* Await the restored renderer's preload. */ }
    }
    return false;
  }).toBe(true);
  await hideWindow(application!, result!);
  return result!;
}

try {
  await Promise.all([mkdir(profile), mkdir(artifacts, { recursive: true }), fixture(firstRepository), fixture(secondRepository)]);
  // This harness changes only native visibility, so real renderer/IPC/backend
  // actions can run without interrupting the user's current foreground app.
  await writeFile(bootstrap, `const { BrowserWindow } = require('electron');
BrowserWindow.prototype.show = function () { this.webContents.setBackgroundThrottling(false); this.hide(); };
require(${JSON.stringify(resolve('apps/desktop/dist/index.cjs'))});
`);
  await launch();
  const initial = active!;
  await welcomeReady(initial);
  const dimensions = await application!.browserWindow(initial);
  try {
    expect(await dimensions.evaluate(window => window.getSize())).toEqual([760, 520]);
    expect(await dimensions.evaluate(window => window.getMinimumSize())).toEqual([560, 400]);
  } finally { await dimensions.dispose(); }
  await expect(initial.getByText('Your recent projects will appear here.', { exact: true })).toBeVisible();
  await expect(initial.getByRole('button', { name: 'New Project…', exact: true })).toBeEnabled();
  await expect(initial.getByRole('button', { name: 'Get from VCS…', exact: true })).toBeEnabled();
  await expect(initial.locator('.welcome-logo')).toHaveCount(0);
  await capture(initial, 'empty-welcome.png');
  pass('First launch shows a 760×520 compact welcome window with no workspace/editor/commit chrome.');

  const customize = initial.getByRole('button', { name: 'Settings', exact: true });
  await expect(customize).toContainText('Customize…');
  await customize.click();
  const settings = initial.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await expect(customize).toBeFocused();
  pass('Customize… opens the existing Settings dialog, and cancel closes it and restores the welcome trigger focus.');

  await application!.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await initial.getByRole('button', { name: 'Open…', exact: true }).click();
  await expect(initial.getByRole('button', { name: 'Open…', exact: true })).toBeEnabled();
  await welcomeReady(initial);
  expect(application!.windows()).toHaveLength(1);
  pass('Canceling the native folder picker retains the welcome screen without an error or extra window.');

  await application!.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
  await initial.getByRole('button', { name: 'New Project…', exact: true }).click();
  await expect(initial.getByRole('button', { name: 'New Project…', exact: true })).toBeEnabled();
  await welcomeReady(initial);
  expect(application!.windows()).toHaveLength(1);
  pass('Canceling New Project retains the welcome screen and creates no project.');

  await initial.getByRole('button', { name: 'Get from VCS…', exact: true }).click();
  const vcs = initial.getByRole('dialog', { name: 'Clone Repository', exact: true });
  await expect(vcs.getByRole('textbox', { name: 'Repository URL', exact: true })).toBeFocused();
  await expect(vcs.getByRole('button', { name: 'Choose destination…', exact: true })).toBeDisabled();
  await capture(initial, 'vcs-dialog.png');
  await vcs.getByRole('textbox', { name: 'Repository URL', exact: true }).fill(`file://${firstRepository}`);
  await vcs.getByRole('button', { name: 'Choose destination…', exact: true }).click();
  await expect(vcs.getByRole('alert')).toContainText('Local paths and custom Git transports are not supported');
  await capture(initial, 'vcs-validation.png');
  await vcs.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(vcs).toHaveCount(0);
  await expect(initial.getByRole('button', { name: 'Get from VCS…', exact: true })).toBeFocused();
  expect(application!.windows()).toHaveLength(1);
  await initial.getByRole('button', { name: 'Get from VCS…', exact: true }).click();
  await vcs.getByRole('textbox', { name: 'Repository URL', exact: true }).fill('https://example.invalid/project.git');
  await vcs.getByRole('button', { name: 'Choose destination…', exact: true }).click();
  await expect(vcs).toHaveCount(0);
  await welcomeReady(initial);
  pass('Get from VCS focuses the URL input, rejects unsupported file URLs, restores focus on cancellation, and safely cancels destination selection.');

  await application!.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, createdProject);
  const created = await openRepositoryWindow(application!, () => initial.getByRole('button', { name: 'New Project…', exact: true }).click());
  active = created;
  await expect(created.getByRole('button', { name: 'Project switcher', exact: true })).toContainText('created-project');
  await expect.poll(() => initial.isClosed()).toBe(true);
  expect((await created.evaluate(() => window.desktop.getWindowProject()))?.path).toBe(await realpath(createdProject));
  expect(await access(join(createdProject, '.git')).then(() => true, () => false)).toBe(false);
  let welcome = await closeToWelcome(created);
  await expect(welcome.getByRole('button', { name: 'Open created-project', exact: true })).toBeVisible();
  pass('New Project creates a real plain project directory, opens it in a project window, closes welcome, and records it in recent projects.');

  const cloneUrl = await localCloneUrl();
  await welcome.getByRole('button', { name: 'Get from VCS…', exact: true }).click();
  const clone = welcome.getByRole('dialog', { name: 'Clone Repository', exact: true });
  await clone.getByRole('textbox', { name: 'Repository URL', exact: true }).fill(cloneUrl);
  await application!.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, clonedProject);
  const cloned = await openRepositoryWindow(application!, () => clone.getByRole('button', { name: 'Choose destination…', exact: true }).click());
  active = cloned;
  await expect(cloned.getByRole('button', { name: 'Project switcher', exact: true })).toContainText('cloned-project');
  await expect.poll(() => welcome.isClosed()).toBe(true);
  expect(await readFile(join(clonedProject, 'notes.ts'), 'utf8')).toBe(await readFile(join(firstRepository, 'notes.ts'), 'utf8'));
  expect((await run('git', ['-C', clonedProject, 'rev-parse', 'HEAD'], { shell: false })).stdout)
    .toBe((await run('git', ['-C', firstRepository, 'rev-parse', 'HEAD'], { shell: false })).stdout);
  await stopDaemon();
  welcome = await closeToWelcome(cloned);
  pass('Get from VCS clones real commits/files from an isolated loopback Git server and opens the resulting project; no external network or user repositories are used.');

  const previousWelcome = welcome;
  const first = await choose(previousWelcome, firstRepository, true);
  await expect.poll(() => previousWelcome.isClosed()).toBe(true);
  expect(application!.windows()).toHaveLength(1);
  welcome = await closeToWelcome(first);
  await expect(welcome.getByRole('button', { name: 'Open first-project', exact: true })).toBeVisible();
  const savedRecent = await welcome.evaluate(() => window.desktop.listRecentProjects());
  expect(savedRecent.map(project => project.path)).toEqual(await Promise.all([firstRepository, clonedProject, createdProject].map(path => realpath(path))));
  const firstRecent = welcome.getByRole('button', { name: 'Open first-project', exact: true });
  await expect(firstRecent.locator('.project-badge')).toHaveText('FP');
  await expect(firstRecent).toContainText(savedRecent[0].displayPath!);
  expect(savedRecent[0].displayPath).toMatch(/^~\//);
  const search = welcome.getByRole('searchbox', { name: 'Search projects', exact: true });
  await search.fill('cloned');
  await expect(welcome.getByRole('button', { name: 'Open cloned-project', exact: true })).toBeVisible();
  await expect(firstRecent).toHaveCount(0);
  await search.press('ArrowDown');
  await expect(welcome.getByRole('button', { name: 'Open cloned-project', exact: true })).toBeFocused();
  await search.focus();
  await search.fill('missing-project-name');
  await expect(welcome.getByRole('list', { name: 'Recent projects', exact: true }).getByRole('button')).toHaveCount(0);
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(firstRecent).toBeVisible();
  await search.press('ArrowDown');
  await expect(firstRecent).toBeFocused();
  await welcome.keyboard.press('End');
  await expect(welcome.getByRole('button', { name: 'Open created-project', exact: true })).toBeFocused();
  await welcome.keyboard.press('Home');
  await expect(firstRecent).toBeFocused();
  await expect.poll(async () => JSON.parse(await readFile(join(profile, 'workspace.json'), 'utf8')).windows).toEqual([]);
  await capture(welcome, 'recent-welcome.png');
  const small = await application!.browserWindow(welcome);
  try { await small.evaluate(window => window.setSize(560, 400)); } finally { await small.dispose(); }
  await expect(welcome.getByRole('button', { name: 'Open first-project', exact: true })).toBeVisible();
  await capture(welcome, 'recent-welcome-minimum.png');
  const normal = await application!.browserWindow(welcome);
  try { await normal.evaluate(window => window.setSize(760, 520)); } finally { await normal.dispose(); }
  pass('Opening a project closes welcome; closing the last project returns to welcome with persisted recent history. Minimum 560×400 layout remains usable.');
  pass('Recent rows reuse project-initial badges and home-relative paths; search filters real history, Escape clears, Arrow Down moves into results, and Home/End navigate the list.');

  // A stale path remains a visible, recoverable recent item. Only a main-process
  // authorized ID is sent when clicking it; the renderer never supplies a path.
  const moved = `${firstRepository}-moved`;
  await rename(firstRepository, moved);
  try {
    await welcome.getByRole('button', { name: 'Open first-project', exact: true }).click();
    await expect(welcome.getByRole('alert')).toBeVisible();
    await expect(welcome.getByRole('button', { name: 'Open first-project', exact: true })).toBeEnabled();
    expect(application!.windows()).toHaveLength(1);
  } finally { await rename(moved, firstRepository); }
  await welcome.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  pass('A moved/missing recent project reports an inline error and leaves the compact launcher and recent item available.');

  // Closing with no projects is intentionally different from quitting with
  // open projects: restart retains history but must not reopen a closed project.
  await application!.close(); application = undefined;
  await launch();
  welcome = active!;
  await welcomeReady(welcome);
  await expect(welcome.getByRole('button', { name: 'Open first-project', exact: true })).toBeVisible();
  expect(application!.windows()).toHaveLength(1);
  const firstAgain = await openRepositoryWindow(application!, () => welcome.getByRole('button', { name: 'Open first-project', exact: true }).click());
  active = firstAgain;
  await expect.poll(() => welcome.isClosed()).toBe(true);
  await expect(firstAgain.getByRole('button', { name: 'Project switcher', exact: true })).toContainText('first-project');
  await normalFile(firstAgain, 'notes.ts');
  await normalFile(firstAgain, 'sample.ts');
  const editor = firstAgain.getByRole('textbox', { name: 'File contents: sample.ts', exact: true });
  await editor.focus();
  await firstAgain.keyboard.press('Control+g');
  const goTo = firstAgain.locator('.quick-input-widget:visible input');
  await expect(goTo).toBeVisible();
  await goTo.fill(':90:10');
  await firstAgain.keyboard.press('Enter');
  await expect(goTo).toBeHidden();
  await expect.poll(async () => (await editorViewport(firstAgain)).some(line => /line[5-9]\d\s/.test(line.text ?? ''))).toBe(true);
  const firstSession = await firstAgain.evaluate(() => window.desktop.getWindowSessionId());
  const firstTabs = await tabs(firstAgain);
  const firstViewport = await editorViewport(firstAgain);
  const second = await choose(firstAgain, secondRepository, false);
  await normalFile(second, 'notes.ts');
  const secondSession = await second.evaluate(() => window.desktop.getWindowSessionId());
  const secondTabs = await tabs(second);
  await expect.poll(() => second.evaluate(async () => {
    const repository = (await window.desktop.getLastRepository())!.repository;
    const session = await window.desktop.getWindowSessionId();
    const saved = localStorage.getItem(`smart-diff:editor-session:v1:${JSON.stringify([repository.path, session])}`);
    return saved ? JSON.parse(saved).groups[0].tabs.map((tab: { path: string }) => tab.path) : [];
  }), { message: 'Second window persists its opened normal file before restart' }).toEqual(['notes.ts']);
  await expect.poll(async () => JSON.parse(await readFile(join(profile, 'workspace.json'), 'utf8')).windows.length).toBe(2);
  pass('Recent projects survive an intentionally empty restart, open by list click, and coexist in independent project windows.');

  await application!.close(); application = undefined;
  await launch();
  const restoredFirst = await restored(await realpath(firstRepository));
  const restoredSecond = await restored(await realpath(secondRepository));
  active = restoredFirst;
  expect(application!.windows()).toHaveLength(2);
  for (const page of application!.windows()) await expect(page.getByRole('main', { name: 'Welcome', exact: true })).toHaveCount(0);
  expect(await restoredFirst.evaluate(() => window.desktop.getWindowSessionId())).toBe(firstSession);
  expect(await restoredSecond.evaluate(() => window.desktop.getWindowSessionId())).toBe(secondSession);
  await expect.poll(() => tabs(restoredFirst)).toEqual(firstTabs);
  await expect.poll(() => tabs(restoredSecond)).toEqual(secondTabs);
  await expect(restoredFirst.getByTestId('file-surface')).toHaveAttribute('data-path', 'sample.ts');
  await expect(restoredSecond.getByTestId('file-surface')).toHaveAttribute('data-path', 'notes.ts');
  await expect.poll(() => editorViewport(restoredFirst)).toEqual(firstViewport);
  await restoredFirst.locator('.project-tree').evaluateAll(nodes => { for (const node of nodes) node.scrollLeft = 0; });
  await capture(restoredFirst, 'restored-project.png');
  expect(errors).toEqual([]);
  pass('Quitting with two project windows restores both with stable session IDs, ordered file tabs, active tabs and the sample editor scroll position; no welcome window or renderer errors.');
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ checks, errors, screenshots, completedAt: new Date().toISOString() }, null, 2));
  await Promise.all(['failure.txt', 'failure.png'].map(name => rm(join(artifacts, name), { force: true })));
} catch (error) {
  await writeFile(join(artifacts, 'failure.txt'), String(error));
  if (application && active && !active.isClosed()) await writeFile(join(artifacts, 'failure.png'), await captureWindow(application, active)).catch(() => {});
  throw error;
} finally {
  await stopDaemon();
  if (application) {
    await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await application.close().catch(() => {});
  }
  await rm(directory, { recursive: true, force: true });
}
