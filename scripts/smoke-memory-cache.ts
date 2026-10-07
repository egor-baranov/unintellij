/** Exercises clean-cache pressure without losing shared or background drafts. */
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 20000 });
const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-memory-cache-'));
const repository = join(temporary, 'cache-fixture');
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/memory');
await Promise.all([mkdir(repository), mkdir(profile), mkdir(artifacts, { recursive: true })]);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const original = 'export const marker = "on disk";\n';
const draft = 'export const marker = "preserved across cache pressure";\n';
const files = Array.from({ length: 32 }, (_, index) => `large-${String(index).padStart(2, '0')}.txt`);
const payload = `${'large clean file memory fixture '.repeat(3)}\n`.repeat(6000);
await git('init', '-q', '-b', 'main');
await Promise.all([
  writeFile(join(repository, 'draft.ts'), original),
  ...files.map(path => writeFile(join(repository, path), `${path}\n${payload}`)),
]);
await git('add', '.');
await git('-c', 'user.name=Memory smoke', '-c', 'user.email=memory@example.invalid', 'commit', '-qm', 'Temporary cache fixture');
const bootstrap = join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
BrowserWindow.prototype.show = function () { this.webContents.setBackgroundThrottling(false); this.hide(); };
BrowserWindow.prototype.focus = function () {};
app.on('browser-window-created', (_event, window) => {
  window.setOpacity(0); window.setIgnoreMouseEvents(true); window.setFocusable(false);
  window.webContents.setBackgroundThrottling(false);
});
require(${JSON.stringify(resolve('apps/desktop/dist/index.cjs'))});
`);
const application = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], env: { ...process.env, SMART_DIFF_DEV_URL: '' } });
const errors: string[] = [];
let phase = 'opening';
try {
  const welcome = await application.firstWindow();
  await welcome.evaluate(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repository);
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const project = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true });
  if (await project.getAttribute('aria-pressed') !== 'true') await project.click();
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  const file = page.getByTestId('file-surface');
  await tree.getByRole('treeitem', { name: 'draft.ts', exact: true }).click();
  await expect(file).toHaveAttribute('data-path', 'draft.ts');
  await file.locator('.view-lines').click({ position: { x: 80, y: 10 } });
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(draft);
  await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).toBeVisible();

  phase = 'split draft';
  await page.getByRole('button', { name: 'Editor group 1 options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Split right', exact: true }).click();
  await expect(file).toHaveCount(2);
  for (const surface of await file.all()) await expect(surface.locator('.view-lines')).toContainText('preserved across cache pressure');
  await page.locator('section[data-group="primary"]').getByRole('button', { name: 'Close draft.ts', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save changes?', exact: true })).toHaveCount(0);
  await expect(file).toHaveCount(1);
  await expect(file.locator('.view-lines')).toContainText('preserved across cache pressure');

  phase = 'large clean cache pressure';
  for (const path of files) {
    await tree.getByRole('treeitem', { name: path, exact: true }).click();
    await expect(file).toHaveAttribute('data-path', path);
    await expect(file.locator('.view-lines')).toContainText(path);
    await expect(page.locator('.monaco-editor')).toHaveCount(1);
  }
  expect(await readFile(join(repository, 'draft.ts'), 'utf8')).toBe(original);
  await tree.getByRole('treeitem', { name: 'draft.ts', exact: true }).click();
  await expect(file.locator('.view-lines')).toContainText('preserved across cache pressure');
  await tree.getByRole('treeitem', { name: files.at(-1)!, exact: true }).click();
  const cdp = await page.context().newCDPSession(page);
  const heapAfterPressure = await cdp.send('Runtime.getHeapUsage');

  phase = 'background save';
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('navigation', { name: 'Settings categories', exact: true }).getByRole('button', { name: 'Files', exact: true }).click();
  await settings.getByRole('checkbox', { name: 'Save changes automatically', exact: true }).check();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => readFile(join(repository, 'draft.ts'), 'utf8')).toBe(draft);
  await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
  await tree.getByRole('treeitem', { name: 'draft.ts', exact: true }).click();
  await expect(file.locator('.view-lines')).toContainText('preserved across cache pressure');
  await page.getByRole('button', { name: 'Close draft.ts', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'draft.ts', exact: true }).click();
  await expect(file.locator('.view-lines')).toContainText('preserved across cache pressure');

  phase = 'close clean tabs';
  while (await page.locator('.workspace-tab-close').count()) await page.locator('.workspace-tab-close').first().click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.locator('.monaco-editor')).toHaveCount(0);
  expect((await git('show', 'HEAD:draft.ts')).stdout).toBe(original);
  expect((await git('diff', '--cached', '--name-only')).stdout).toBe('');
  expect((await git('diff', '--name-only')).stdout.trim()).toBe('draft.ts');
  expect(errors).toEqual([]);
  const heapAfterClose = await cdp.send('Runtime.getHeapUsage');
  await cdp.detach();
  await writeFile(join(artifacts, 'cache-smoke.json'), JSON.stringify({ checks: ['Shared split draft survives closing one alias', 'Dirty draft survives 32 large clean files exceeding clean-cache budget', 'Only active file keeps an editor mounted', 'Background save and immediate reopen show saved text', 'Closing all clean tabs disposes all editor DOMs', 'Only temporary draft changed, index unchanged'], cleanFiles: files.length, totalCleanTextBytes: files.length * payload.length * 2, heapAfterPressure, heapAfterClose, errors }, null, 2));
  console.log(`Memory cache and draft smoke passed: ${artifacts}`);
} catch (error) {
  await writeFile(join(artifacts, 'cache-smoke-failure.json'), JSON.stringify({ phase, error: String(error), errors }, null, 2));
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
