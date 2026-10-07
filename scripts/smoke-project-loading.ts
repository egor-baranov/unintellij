/** Regression smoke for expanding directories while repository watches grow.
 * Only a disposable Git repository/profile is used. A single delayed, genuine
 * IPC response reproduces a first directory read invalidated by auto-refresh. */
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 15000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-project-loading-'));
const repository = join(directory, 'loading-project');
const profile = join(directory, 'profile');
const groups = Array.from({ length: 8 }, (_, index) => `group-${index + 1}`);
const racePath = 'race/first-read';
const filePath = 'group-1/nested/deeper/sample.ts';
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
await mkdir(profile);
await mkdir(join(repository, racePath), { recursive: true });
await writeFile(join(repository, racePath, 'original.ts'), 'export const original = true;\n');
for (const group of groups) {
  await mkdir(join(repository, group, 'nested/deeper'), { recursive: true });
  await writeFile(join(repository, group, 'nested/deeper/sample.ts'), 'export const sample = "initial";\n');
}
await git('init', '-q', '-b', 'main');
await git('add', '.');
await git('-c', 'user.name=Smoke Test', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'Temporary loading fixture');

interface LoadingStats {
  refreshes: number;
  reads: { path: string; generation: number | undefined }[];
  gatePath: string | null;
  waiting: boolean;
  released: boolean;
  expired: boolean;
}

const executablePath = process.env.SMART_DIFF_PACKAGED_EXECUTABLE;
const application = await electron.launch({
  ...(executablePath ? { executablePath, args: [`--user-data-dir=${profile}`] }
    : { args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${profile}`] }),
  env: { ...process.env, SMART_DIFF_DEV_URL: '' },
});
const stats = () => application.evaluate(() => Reflect.get(globalThis, 'smokeProjectLoading') as LoadingStats);

try {
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  await application.evaluate(({ dialog, ipcMain }, fixture) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.repository] });
    // Test-only adapter: original sender/capability-validated handlers and their
    // results are retained. No fake directory entries or notifications are used.
    type Handler = (event: import('electron').IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler> | undefined;
    if (!(handlers instanceof Map)) throw new Error('Electron smoke adapter: IPC handler registry is unavailable.');
    const list = handlers.get('project:list'), refresh = handlers.get('repository:refresh');
    if (!list || !refresh) throw new Error('Expected project/repository IPC handlers are unavailable.');
    // Arm before rendering the tree: its bounded prefetch is allowed to reach
    // this first child read before the user clicks the disclosure arrow.
    const state: LoadingStats = { refreshes: 0, reads: [], gatePath: fixture.gatePath, waiting: false, released: false, expired: false };
    Reflect.set(globalThis, 'smokeProjectLoading', state);
    ipcMain.removeHandler('repository:refresh');
    ipcMain.handle('repository:refresh', async (event, ...args: unknown[]) => {
      state.refreshes++;
      return refresh(event, ...args);
    });
    ipcMain.removeHandler('project:list');
    ipcMain.handle('project:list', async (event, ...args: unknown[]) => {
      const result = await list(event, ...args) as import('../apps/desktop/src/bridge').ProjectDirectory;
      state.reads.push({ path: result.path, generation: result.generation });
      if (state.gatePath === result.path) {
        state.gatePath = null;
        state.waiting = true;
        await new Promise<void>(resolve => {
          const timers = process.getBuiltinModule('node:timers') as typeof import('node:timers');
          Reflect.set(ipcMain, 'smokeReleaseProjectRead', () => {
            state.waiting = false; state.released = true;
            timers.clearTimeout(deadline);
            Reflect.deleteProperty(ipcMain, 'smokeReleaseProjectRead');
            resolve();
          });
          const deadline = timers.setTimeout(() => {
            state.expired = true;
            (Reflect.get(ipcMain, 'smokeReleaseProjectRead') as (() => void) | undefined)?.();
          }, 25000);
        });
      }
      return result;
    });
  }, { repository, gatePath: racePath });
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const project = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true });
  await expect(project).toBeVisible();
  if (await project.getAttribute('aria-pressed') !== 'true') await project.click();
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  const row = (path: string) => tree.getByRole('treeitem', { name: path, exact: true });
  const expand = async (path: string) => {
    const item = row(path);
    await expect(item).toBeVisible();
    if (await item.getAttribute('aria-expanded') !== 'true') await item.locator('.project-node-name').click();
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  const idle = async () => {
    await expect(tree).toHaveAttribute('aria-busy', 'false');
    await expect(tree.locator('.project-directory-message').filter({ hasText: 'Loading' })).toHaveCount(0);
    await expect(tree.locator('.project-directory-error')).toHaveCount(0);
  };
  await expect(row(groups[0])).toBeVisible();
  await idle();
  // Let startup focus notification and the first real polling pass settle.
  await page.waitForTimeout(3300);
  await idle();
  const repositoryId = await page.evaluate(async () => {
    const repositories = await window.desktop.listOpenRepositories();
    if (repositories.length !== 1) throw new Error('Expected exactly one disposable repository.');
    Reflect.set(globalThis, 'smokeRepositoryNotifications', 0);
    window.desktop.subscribeToRepositoryChanges(() => {
      Reflect.set(globalThis, 'smokeRepositoryNotifications', Number(Reflect.get(globalThis, 'smokeRepositoryNotifications')) + 1);
    });
    return repositories[0].id;
  });
  const generation = () => page.evaluate(async id => (await window.desktop.listChanges(id)).generation, repositoryId);
  const notifications = () => page.evaluate(() => Number(Reflect.get(globalThis, 'smokeRepositoryNotifications')));
  const baseline = { generation: await generation(), stats: await stats() };

  // A visible ordinary folder is warmed while collapsed. Its contents must be
  // present in the same React click update, without another directory IPC read.
  await expect.poll(async () => (await stats()).reads.filter(read => read.path === groups[0]).length).toBeGreaterThan(0);
  const warmReadCount = (await stats()).reads.filter(read => read.path === groups[0]).length;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const warmExpansion = await page.evaluate(async path => {
    const item = document.querySelector<HTMLElement>(`.project-tree-row[data-path="${path}"]`);
    if (!item) throw new Error('The warmed directory row is missing.');
    item.querySelector<HTMLElement>('.project-node-name')!.click();
    // React flushes discrete event updates before the next microtask; do not
    // wait for another frame or an IPC reply to make this assertion pass.
    await Promise.resolve();
    return { expanded: item.getAttribute('aria-expanded'), child: Boolean(document.querySelector(`.project-tree-row[data-path="${path}/nested"]`)) };
  }, groups[0]);
  expect(warmExpansion).toEqual({ expanded: 'true', child: true });
  expect((await stats()).reads.filter(read => read.path === groups[0])).toHaveLength(warmReadCount);
  console.log('PASS: a prefetched folder displays its children in the expansion click without another IPC request.');

  // Prefetch and expansion grow the native watch/fingerprint sets. That
  // membership change must not invalidate in-flight directory responses.
  for (const group of groups) {
    for (const path of [group, `${group}/nested`, `${group}/nested/deeper`]) await expand(path);
    await expect(row(`${group}/nested/deeper/sample.ts`)).toBeVisible();
    await idle();
  }
  await expand('race');
  await expect(row(racePath)).toBeVisible();
  await idle();
  await page.waitForTimeout(3300);
  await idle();
  expect(await generation()).toBe(baseline.generation);
  expect(await notifications()).toBe(0);
  const afterNavigation = await stats();
  expect(afterNavigation.refreshes).toBe(baseline.stats.refreshes);
  const navigatedPaths = [...groups.flatMap(group => [group, `${group}/nested`, `${group}/nested/deeper`]), 'race'];
  for (const path of navigatedPaths) {
    const startupReads = baseline.stats.reads.filter(read => read.path === path).length;
    expect(afterNavigation.reads.filter(read => read.path === path)).toHaveLength(Math.max(1, startupReads));
  }
  expect(afterNavigation.reads.slice(baseline.stats.reads.length).every(read => read.generation === baseline.generation)).toBe(true);
  console.log('PASS: 25 directory expansions reuse prefetch without notifications, refreshes, duplicate reads, or generation churn.');

  await expect(row(`${racePath}/original.ts`)).toHaveCount(0);
  await expand(racePath);
  await expect.poll(async () => (await stats()).waiting).toBe(true);
  await expect(tree).toHaveAttribute('aria-busy', 'true');
  await expect(tree.locator('.project-directory-message').filter({ hasText: 'Loading' })).toHaveCount(0);
  await expect(row(`${racePath}/original.ts`)).toHaveCount(0);
  // A real mutation refreshes the tree while its first child read is delayed.
  // The refreshed parent must restart that child without waiting for the stale
  // response, even though its former cache entry contained no directory ID.
  await writeFile(join(repository, racePath, 'arrived-during-read.ts'), 'export const arrivedDuringRead = true;\n');
  await expect.poll(notifications).toBeGreaterThan(0);
  await expect(row(`${racePath}/arrived-during-read.ts`)).toBeVisible({ timeout: 12000 });
  await expect(row(`${racePath}/original.ts`)).toBeVisible();
  await idle();
  expect((await stats()).waiting).toBe(true);
  expect(await generation()).toBeGreaterThan(baseline.generation);
  await application.evaluate(({ ipcMain }) => {
    const release = Reflect.get(ipcMain, 'smokeReleaseProjectRead') as (() => void) | undefined;
    if (!release) throw new Error('The directory read gate expired before recovery.');
    release();
  });
  await page.waitForTimeout(250);
  await idle();
  await expect(row(`${racePath}/arrived-during-read.ts`)).toBeVisible();
  expect((await stats()).expired).toBe(false);
  console.log('PASS: a genuine refresh restarts an invalidated first child read; a late old response cannot erase the recovered listing.');

  await row(filePath).locator('.project-node-name').click();
  const code = page.getByTestId('file-surface').locator('.view-lines');
  await expect(code).toContainText('initial');
  await writeFile(join(repository, filePath), 'export const sample = "external-update";\n');
  await expect(code).toContainText('external-update');
  await expect(row(filePath)).toHaveAttribute('data-git-state', 'modified');
  // The next content write leaves porcelain status unchanged, so it must be
  // caught by the existing watched-file fingerprint rather than status alone.
  await writeFile(join(repository, filePath), 'export const sample = "second-update";\n');
  await expect(code).toContainText('second-update');
  const newFile = 'group-2/nested/deeper/new-file.ts';
  await writeFile(join(repository, newFile), 'export const discovered = true;\n');
  await expect(row(newFile)).toBeVisible();
  await rm(join(repository, newFile));
  await expect(row(newFile)).toHaveCount(0);
  await idle();
  // An unchanged polling pass must settle again after the real writes.
  await page.waitForTimeout(800);
  await idle();
  const settled = { generation: await generation(), notifications: await notifications() };
  await page.waitForTimeout(3300);
  await idle();
  expect(await generation()).toBe(settled.generation);
  expect(await notifications()).toBe(settled.notifications);
  expect(errors).toEqual([]);
  await row(filePath).scrollIntoViewIfNeeded();
  const output = resolve('artifacts/directory-expansion');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'desktop-expanded.png'), await captureWindow(application, page));
  console.log('PASS: repeated external edits, new files, and deleted files update automatically and return to a stable tree.');
} finally {
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
  }).catch(() => {});
  await application.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
