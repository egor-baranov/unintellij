/** Exercise repository notifications and tab reloads in the production Electron app.
 * All writes go to a temporary Git fixture. The window stays hidden throughout;
 * no refresh button, focus event, or direct refresh bridge call drives the
 * automatic-update checks. One explicit no-op refresh checks hunk navigation. */
import { _electron as electron, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pngBefore, pngAfter } from '../apps/playground/src/media-fixtures';

const expect = baseExpect.configure({ timeout: 30000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-auto-refresh-smoke-'));
const repository = join(directory, 'repository');
const cleanPath = 'src/nested/clean.ts';
const longContents = (version: string) => Array.from({ length: 180 }, (_, index) => `export const row${index + 1} = '${version}';`).join('\n') + '\n';
const sampleContents = (value: number) => `export const value = ${value};\n`;
const artifactDirectory = resolve('artifacts/auto-refresh');
const captureDirectory = join(directory, 'screenshots');
await mkdir(join(repository, 'src/nested'), { recursive: true });
await mkdir(captureDirectory);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
await git('init', '-q', '-b', 'main');
await writeFile(join(repository, 'sample.ts'), sampleContents(1));
await writeFile(join(repository, cleanPath), longContents('initial'));
await writeFile(join(repository, 'src/nested/sample.png'), Buffer.from(pngBefore.base64, 'base64'));
await git('add', '.');
await git('-c', 'user.name=Smoke Test', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'Temporary refresh fixture');
await writeFile(join(repository, 'sample.ts'), sampleContents(2));
await git('add', '--', 'sample.ts');
await writeFile(join(repository, 'sample.ts'), sampleContents(3));

const executablePath = process.env.SMART_DIFF_PACKAGED_EXECUTABLE;
await mkdir(join(directory, 'profile'), { recursive: true });
const application = await electron.launch({
  ...(executablePath ? { executablePath, args: [`--user-data-dir=${join(directory, 'profile')}`] }
    : { args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${join(directory, 'profile')}`] }),
  env: { ...process.env, SMART_DIFF_DEV_URL: '' },
});
let repositoryPage: Page | undefined;
const capture = async (name: string) => {
  const page = repositoryPage ?? await application.firstWindow();
  const png = await captureWindow(application, page);
  // Delay writes to the developer's workspace until the smoke finishes. A
  // separate running desktop app may itself be watching that repository.
  await writeFile(join(captureDirectory, name), png);
};

try {
  // electron.launch can resolve before the asynchronous asset protocol/bridge
  // registration completes. Wait for the window before wrapping its handlers.
  await application.firstWindow();
  await application.evaluate(({ dialog, ipcMain }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    // Test-only fault injection, never a production IPC hook. Electron's private
    // handler registry is guarded at runtime; the original handlers still run
    // their sender/capability checks before any result is altered.
    type Handler = (event: import('electron').IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler> | undefined;
    if (!(handlers instanceof Map)) throw new Error('Electron smoke adapter: IPC handler registry is unavailable.');
    const read = handlers.get('repository:read'), refresh = handlers.get('repository:refresh');
    if (!read || !refresh) throw new Error('Expected repository IPC handlers are unavailable.');
    const stats = { staleResponses: 0, reads: 0, refreshes: 0, delayNextRefresh: false, delayingRefresh: false, releasedRefreshes: 0, results: [] as string[], events: [] as { action: string; time: number }[] };
    Reflect.set(globalThis, 'smokeRefreshStats', stats);
    ipcMain.removeHandler('repository:read');
    ipcMain.handle('repository:read', async (event, ...args: unknown[]) => {
      const request = ++stats.reads;
      stats.events.push({ action: 'read:start', time: Date.now() });
      const result = await read(event, ...args) as import('../apps/desktop/src/bridge').FileComparison;
      stats.results.push(result.state);
      stats.events.push({ action: `read:${result.state}`, time: Date.now() });
      // Initial repository activation can overlap a follow-up snapshot read.
      // Inject into the newest request so a discarded old response cannot make
      // the test pass without exercising the renderer's actual stale recovery.
      if (!stats.staleResponses && request === stats.reads && result.state === 'text') {
        stats.staleResponses++;
        return { ...result, state: 'stale', original: undefined, modified: undefined, message: 'Injected snapshot race: the repository changed while loading.' };
      }
      return result;
    });
    ipcMain.removeHandler('repository:refresh');
    ipcMain.handle('repository:refresh', async (event, ...args: unknown[]) => {
      stats.refreshes++;
      stats.events.push({ action: 'refresh:start', time: Date.now() });
      const result = await refresh(event, ...args);
      stats.events.push({ action: 'refresh:ready', time: Date.now() });
      if (stats.delayNextRefresh) {
        stats.delayNextRefresh = false; stats.delayingRefresh = true;
        await new Promise<void>(resolve => {
          const timers = process.getBuiltinModule('node:timers') as typeof import('node:timers');
          Reflect.set(ipcMain, 'smokeReleaseRefresh', () => {
            stats.delayingRefresh = false; stats.releasedRefreshes++; timers.clearTimeout(deadline);
            Reflect.deleteProperty(ipcMain, 'smokeReleaseRefresh'); resolve();
          });
          const deadline = timers.setTimeout(() => { (Reflect.get(ipcMain, 'smokeReleaseRefresh') as (() => void) | undefined)?.(); }, 10000);
        });
      }
      return result;
    });
  }, repository);
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  // The conflict checks deliberately retain manual-save drafts during refresh.
  await welcome.evaluate(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  repositoryPage = page;
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.stack ?? error.message); console.error('Renderer page error:', Date.now(), error.stack ?? error.message); });
  page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
  expect(page.url()).toBe('app://smart-diff/index.html');
  const mode = (name: 'Project' | 'Commit') => page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name, exact: true });
  const modified = page.locator('.smart-diff-pane[data-side="modified"] .view-lines');
  const original = page.locator('.smart-diff-pane[data-side="original"] .view-lines');
  const file = page.getByTestId('file-surface');
  const visibleLine = (surface: Locator) => surface.locator('.line-numbers').evaluateAll(nodes => Math.min(...nodes.map(node => Number(node.textContent)).filter(line => line > 0)));
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

  // The initial selected comparison encounters the injected stale read. It must
  // recover by itself; selecting another file would hide this regression.
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  expect(await application.evaluate(() => Reflect.get(globalThis, 'smokeRefreshStats').staleResponses)).toBe(1);
  await expect(page.getByRole('heading', { name: 'Comparison changed', exact: true })).toHaveCount(0);
  console.log('PASS: an initial stale comparison reloads automatically.');

  await page.getByRole('treeitem', { name: 'sample.ts (working)', exact: true }).click();
  await expect(modified).toContainText(/value\s*=\s*3/);
  await writeFile(join(repository, 'sample.ts'), sampleContents(4));
  await expect(modified).toContainText(/value\s*=\s*4/);
  await expect(original).toContainText(/value\s*=\s*1/);
  await writeFile(join(repository, 'sample.ts'), sampleContents(1));
  // The index still differs, so this whole-file comparison stays available;
  // its HEAD and working endpoints now match and the diff reports no changes.
  await expect(page.locator('.smart-diff [role="status"]')).toHaveText('No differences');
  await writeFile(join(repository, 'sample.ts'), sampleContents(4));
  await expect(modified).toContainText(/value\s*=\s*4/);
  await expect(page.locator('.smart-diff [role="status"]')).not.toHaveText('No differences');
  // Updating the index must keep the same full HEAD→working comparison open.
  await git('add', '--', 'sample.ts');
  await expect(modified).toContainText(/value\s*=\s*4/);
  await expect(original).toContainText(/value\s*=\s*1/);
  await expect(page.getByRole('treeitem', { name: 'sample.ts (working)', exact: true })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Commit: sample.ts — working', exact: true })).toHaveCount(1);
  await expect(page.getByTestId('change-count')).toHaveText(/\/ 1$/);
  // The manual refresh shortcut keeps the rendered hunk's navigation enabled.
  const beforeNoopRefresh = await application.evaluate(() => Reflect.get(globalThis, 'smokeRefreshStats').refreshes as number);
  await page.keyboard.press(`${mod}+r`);
  await expect.poll(() => application.evaluate(() => Reflect.get(globalThis, 'smokeRefreshStats').refreshes as number)).toBeGreaterThan(beforeNoopRefresh);
  await expect(page.getByRole('button', { name: 'Refresh changes', exact: true })).toBeEnabled();
  await expect(page.getByTestId('change-count')).toHaveText(/\/ 1$/);
  await writeFile(join(repository, 'sample.ts'), sampleContents(5));
  await git('add', '--', 'sample.ts');
  await expect(modified).toContainText(/value\s*=\s*5/);
  await capture('electron-updated-diff.png');
  console.log('PASS: one HEAD→working diff follows file/index changes without duplicate rows or tabs.');

  await mode('Project').click();
  for (const path of ['src', 'src/nested']) {
    const row = page.getByRole('treeitem', { name: path, exact: true });
    await expect(row).toBeVisible();
    if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
  }
  await page.getByRole('treeitem', { name: cleanPath, exact: true }).click();
  await expect(file.locator('.view-lines')).toContainText('initial');
  await file.click({ position: { x: 120, y: 40 } });
  await page.keyboard.press('PageDown'); await page.keyboard.press('PageDown');
  await expect.poll(() => visibleLine(file)).toBeGreaterThan(20);
  const beforeLine = await visibleLine(file);
  await writeFile(join(repository, cleanPath), longContents('external-update'));
  await expect(file.locator('.view-lines')).toContainText('external-update');
  expect(Math.abs(await visibleLine(file) - beforeLine)).toBeLessThanOrEqual(1);
  const replacement = join(directory, 'atomic-replacement.ts');
  await writeFile(replacement, longContents('atomic-replacement'));
  await rename(replacement, join(repository, cleanPath));
  await expect(file.locator('.view-lines')).toContainText('atomic-replacement');
  expect(Math.abs(await visibleLine(file) - beforeLine)).toBeLessThanOrEqual(1);
  console.log('PASS: a nested clean file follows external writes and atomic replacement without moving the reading position.');

  await application.evaluate(() => { Reflect.get(globalThis, 'smokeRefreshStats').delayNextRefresh = true; });
  await writeFile(join(repository, cleanPath), longContents('busy-first-update'));
  await expect.poll(async () => {
    try { return await application.evaluate(() => Reflect.get(globalThis, 'smokeRefreshStats').delayingRefresh as boolean); }
    catch (error) {
      // CDP can lose this short-lived evaluate promise during an Electron GC.
      // Retry only that transport failure; all application failures still fail.
      if (error instanceof Error && error.message.includes('promise was garbage collected')) return false;
      throw error;
    }
  }, { intervals: [50, 100, 100] }).toBe(true);
  await writeFile(join(repository, cleanPath), longContents('busy-latest-update'));
  await page.waitForTimeout(500);
  await application.evaluate(({ ipcMain }) => {
    const release = Reflect.get(ipcMain, 'smokeReleaseRefresh') as (() => void) | undefined;
    if (!release) throw new Error('The injected refresh gate expired before the second write.');
    release();
  });
  expect(await application.evaluate(() => Reflect.get(globalThis, 'smokeRefreshStats').releasedRefreshes as number)).toBe(1);
  await expect(file.locator('.view-lines')).toContainText('busy-latest-update');
  expect(Math.abs(await visibleLine(file) - beforeLine)).toBeLessThanOrEqual(1);
  console.log('PASS: an update arriving while a repository refresh is in flight is not lost.');

  await file.click({ position: { x: 120, y: 40 } });
  await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText('export const unsavedDraft = true;\n');
  await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).toBeVisible();
  await writeFile(join(repository, cleanPath), longContents('disk-conflict'));
  await expect(page.locator('.editing-notice')).toContainText('changed on disk');
  await expect(file.locator('.view-lines')).toContainText('unsavedDraft');
  await capture('electron-preserved-draft.png');
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click();
  await expect(file.locator('.view-lines')).toContainText('disk-conflict');
  await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
  console.log('PASS: external changes preserve an unsaved draft and display the existing conflict action.');

  await rm(join(repository, cleanPath));
  await expect(page.getByRole('heading', { name: 'File unavailable', exact: true })).toBeVisible();
  await writeFile(join(repository, cleanPath), longContents('recreated-file'));
  await expect(file.locator('.view-lines')).toContainText('recreated-file');
  await expect(page.getByRole('heading', { name: 'File unavailable', exact: true })).toHaveCount(0);
  await writeFile(join(repository, 'src/nested/new-file.ts'), 'export const newFile = true;\n');
  await expect(page.getByRole('treeitem', { name: 'src/nested/new-file.ts', exact: true })).toBeVisible();
  console.log('PASS: deleted/recreated open files recover and expanded folders discover new files.');

  await page.getByRole('treeitem', { name: 'src/nested/sample.png', exact: true }).click();
  const preview = page.locator('.media-surface img');
  const renderedImage = () => preview.evaluate(node => {
    const image = node as HTMLImageElement;
    if (!image.complete || !image.naturalWidth) return '';
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable.');
    context.drawImage(image, 0, 0); return canvas.toDataURL();
  });
  await expect.poll(() => preview.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const originalImageUrl = await preview.getAttribute('src');
  const originalPixels = await renderedImage();
  await writeFile(join(repository, 'src/nested/sample.png'), Buffer.from(pngAfter.base64, 'base64'));
  await expect(preview).not.toHaveAttribute('src', originalImageUrl!);
  await expect.poll(renderedImage).not.toBe('');
  expect(await renderedImage()).not.toBe(originalPixels);
  console.log('PASS: an open image preview automatically replaces its displayed bytes.');

  const codeTab = page.getByRole('tab', { name: cleanPath, exact: true });
  await codeTab.click();
  await codeTab.click({ button: 'right' });
  await page.getByRole('menu', { name: 'File actions', exact: true }).getByRole('menuitem', { name: 'Split Right', exact: true }).click();
  await expect(file).toHaveCount(2);
  await writeFile(join(repository, cleanPath), longContents('split-update'));
  for (const surface of await file.all()) await expect(surface.locator('.view-lines')).toContainText('split-update');
  await capture('electron-updated-splits.png');
  // The sample comparison was inactive during these file updates. Opening its
  // existing tab must use the current snapshot instead of cached old contents.
  await writeFile(join(repository, 'sample.ts'), sampleContents(6));
  await git('add', '--', 'sample.ts');
  await page.getByRole('tab', { name: 'Commit: sample.ts — working', exact: true }).click();
  await expect(modified).toContainText(/value\s*=\s*6/);
  await mode('Commit').click();
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'src/nested/new-file.ts (untracked)', exact: true })).toBeVisible();
  console.log('PASS: both split editors and inactive comparison tabs receive current contents.');

  // A refresh itself must not produce an endless index-lock/watch feedback loop.
  await page.waitForTimeout(1800);
  const refreshes = await application.evaluate(() => Reflect.get(globalThis, 'smokeRefreshStats').refreshes as number);
  await page.waitForTimeout(2200);
  const idleRefreshes = await application.evaluate(() => Reflect.get(globalThis, 'smokeRefreshStats').refreshes as number);
  expect(idleRefreshes - refreshes).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
  console.log(`PASS: idle refreshes settle (${idleRefreshes - refreshes} refreshes over 2.2 seconds); no renderer errors.`);
  console.log(`Screenshots: ${artifactDirectory}`);
} catch (error) {
  console.error('Refresh diagnostics:', await application.evaluate(() => Reflect.get(globalThis, 'smokeRefreshStats')).catch(() => 'unavailable'));
  const diagnosticPage = repositoryPage ?? await application.firstWindow();
  console.error('Visible states:', await diagnosticPage.locator('.state-panel, .editing-notice, .notice').allTextContents().catch(() => []));
  // Keep a late completion distinguishable from a reload that never fired when
  // real Git subprocesses are contending with other desktop/test processes.
  await diagnosticPage.waitForTimeout(15000).catch(() => {});
  console.error('Late refresh diagnostics:', await application.evaluate(() => Reflect.get(globalThis, 'smokeRefreshStats')).catch(() => 'unavailable'));
  console.error('Late visible states:', await diagnosticPage.locator('.state-panel, .editing-notice, .notice').allTextContents().catch(() => []));
  await capture('electron-auto-refresh-failure.png').catch(() => {});
  throw error;
} finally {
  await application.evaluate(({ ipcMain }) => { (Reflect.get(ipcMain, 'smokeReleaseRefresh') as (() => void) | undefined)?.(); }).catch(() => {});
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close();
  try { await mkdir(artifactDirectory, { recursive: true }); await cp(captureDirectory, artifactDirectory, { recursive: true }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
