/** Staged additions deleted from disk must still show their real index contents.
 * Build the desktop app first, then: npx tsx scripts/smoke-staged-missing.ts
 * Uses only a disposable repository/profile and a transparent, nonfocusable window.
 */
import { _electron as electron, expect as baseExpect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FileComparison } from '../apps/desktop/src/bridge';
import { captureWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 30000 });
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-staged-missing-'));
const repository = join(temporary, 'staged-missing');
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/staged-missing');
const run = promisify(execFile);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const files = {
  'migration_test.go': 'package connectorcatalog\n\nimport "testing"\n\n// Staged content survives removal from the working tree.\nfunc TestMigration(t *testing.T) {\n\tif got := "staged migration"; got == "" {\n\t\tt.Fatal("missing migration")\n\t}\n}\n',
  'main.tf': '# Staged Terraform configuration\nterraform {\n  required_version = ">= 1.11.0"\n}\n\nlocals {\n  migration_enabled = true\n  source = "staged index"\n}\n',
};
const missingReason = 'This file is missing from the working tree. Showing the staged version from the index (read-only).';
const checks: string[] = [];
const screenshots: string[] = [];
const errors: string[] = [];
await Promise.all([mkdir(repository), mkdir(profile), mkdir(artifacts, { recursive: true })]);
await git('init', '-q', '-b', 'main');
await writeFile(join(repository, 'service.go'), 'package service\n\nfunc CurrentVersion() int { return 1 }\n');
await git('add', '--', 'service.go');
await git('-c', 'user.name=Staged missing smoke', '-c', 'user.email=staged-missing@example.invalid', 'commit', '-qm', 'Fixture');
await writeFile(join(repository, 'service.go'), 'package service\n\nfunc CurrentVersion() int { return 2 }\n');
await Promise.all(Object.entries(files).map(([path, text]) => writeFile(join(repository, path), text)));
await git('add', '--', ...Object.keys(files));
await Promise.all(Object.keys(files).map(path => rm(join(repository, path))));
const initialStatus = (await git('status', '--porcelain=v1')).stdout;
for (const path of Object.keys(files)) expect(initialStatus).toContain(`AD ${path}`);
const indexBefore = Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, (await git('rev-parse', `:${path}`)).stdout.trim()])));
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
let page: Page | undefined;
const responses = () => application.evaluate(() => Reflect.get(globalThis, 'stagedMissingReads') as FileComparison[]);
try {
  const welcome = await application.firstWindow();
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  await application.evaluate(({ dialog, ipcMain }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    type Handler = (event: import('electron').IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const original = (Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler>).get('repository:read');
    if (!original) throw new Error('Missing repository:read handler');
    const results: FileComparison[] = [];
    Reflect.set(globalThis, 'stagedMissingReads', results);
    ipcMain.removeHandler('repository:read');
    ipcMain.handle('repository:read', async (event, ...args: unknown[]) => {
      const result = await original(event, ...args) as FileComparison;
      results.push(result);
      return result;
    });
  }, repository);
  page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(window => window.setContentSize(1440, 900));
  await expect(page.getByRole('button', { name: 'Project switcher', exact: true })).toContainText('staged-missing');
  const commit = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true });
  if (await commit.getAttribute('aria-pressed') !== 'true') await commit.click();
  const main = page.locator('.workspace-group.is-active main[aria-label="Selected file comparison"]');
  const expectStaged = async (path: keyof typeof files) => {
    await expect(main.getByTestId('file-surface')).toHaveAttribute('data-path', path);
    await expect(main.getByTestId('file-surface')).toHaveAttribute('data-added', 'true');
    await expect(main).toHaveAttribute('data-editable', 'false');
    await expect(main.getByTestId('file-surface')).toHaveAttribute('data-editable', 'false');
    await expect(main).toHaveAttribute('data-modified-label', 'Index');
    await expect(main).toHaveAttribute('data-path', path);
    await expect(main.locator('.source-headers')).toHaveCount(0);
    await expect(main.getByText(missingReason, { exact: true })).toBeVisible();
    await expect(main.locator('.view-lines')).toContainText(path.endsWith('.go') ? 'TestMigration' : 'migration_enabled');
    await expect(main.getByText('No differences', { exact: true })).toHaveCount(0);
    await expect(main.getByRole('heading', { name: 'Loading comparison…', exact: true })).toHaveCount(0);
    await expect.poll(async () => (await responses()).filter(result => result.path === path).at(-1)?.modified?.label).toBe('Index');
    const response = (await responses()).filter(result => result.path === path).at(-1)!;
    expect(response.state).toBe('text');
    expect(response.changeType).toBe('added');
    expect(response.original?.text).toBe('');
    expect(response.modified?.text).toBe(files[path]);
    expect(response.modified?.editable).toBeUndefined();
    expect(response.modified?.readOnlyReason).toBe(missingReason);
  };
  const capture = async (name: string) => {
    await nativeWindow.evaluate(window => window.showInactive());
    await page!.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    const screenshot = join(artifacts, name);
    await writeFile(screenshot, await captureWindow(application, page!));
    screenshots.push(screenshot);
    await nativeWindow.evaluate(window => window.hide());
  };
  for (const path of Object.keys(files) as (keyof typeof files)[]) {
    await page.getByRole('treeitem', { name: `${path} (staged)`, exact: true }).click();
    await expectStaged(path);
    await capture(path.endsWith('.go') ? 'staged-missing-go.png' : 'staged-missing-terraform.png');
  }
  checks.push('Deleted staged Go and Terraform additions display exact index content as read-only added-file views');
  await page.getByRole('treeitem', { name: 'service.go (working)', exact: true }).click();
  await expect(main.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await expect(main.locator('[data-side="original"] .view-lines')).toContainText('return 1');
  await expect(main.locator('[data-side="modified"] .view-lines')).toContainText('return 2');
  await expect(main.locator('.source-headers')).toHaveCount(0);
  await capture('normal-comparison.png');
  await page.getByRole('tab', { name: 'Commit: migration_test.go — staged', exact: true }).click();
  await expectStaged('migration_test.go');
  await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Changed files', exact: true })).toHaveAttribute('aria-busy', 'false');
  await expectStaged('migration_test.go');
  checks.push('Switching from a normal comparison and refreshing preserves staged content');

  const recreated = files['migration_test.go'].replace('staged migration', 'recreated working version');
  await writeFile(join(repository, 'migration_test.go'), recreated);
  await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'migration_test.go (working)', exact: true })).toBeVisible();
  await expect(main.getByTestId('file-surface')).toHaveAttribute('data-path', 'migration_test.go');
  await expect(main).toHaveAttribute('data-editable', 'true');
  await expect(main.locator('.view-lines')).toContainText('recreated working version');
  await expect(main.getByText(missingReason, { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await responses()).filter(result => result.path === 'migration_test.go').at(-1)?.modified?.label).toBe('Working tree');
  expect((await responses()).filter(result => result.path === 'migration_test.go').at(-1)?.modified?.editable).toBeDefined();
  expect(await readFile(join(repository, 'migration_test.go'), 'utf8')).toBe(recreated);
  checks.push('Recreating the file switches the active tab to current editable working content');

  await rm(join(repository, 'migration_test.go'));
  await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'migration_test.go (staged)', exact: true })).toBeVisible();
  await expectStaged('migration_test.go');
  checks.push('Deleting the recreated file restores the original read-only staged addition');
  for (const path of Object.keys(files)) expect((await git('rev-parse', `:${path}`)).stdout.trim()).toBe(indexBefore[path]);
  expect((await git('status', '--porcelain=v1')).stdout).toBe(initialStatus);
  expect(errors).toEqual([]);
  checks.push('Git index and final working-tree status stay unchanged; no renderer errors');
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ checks, screenshots, errors, initialStatus,
    reads: (await responses()).map(result => ({ path: result.path, state: result.state, changeType: result.changeType, originalLabel: result.original?.label,
      modifiedLabel: result.modified?.label, originalCharacters: result.original?.text.length, modifiedCharacters: result.modified?.text.length, editable: !!result.modified?.editable })),
    captureMode: 'Transparent nonfocusable production Electron compositor capture.' }, null, 2));
  await rm(join(artifacts, 'failure.json'), { force: true });
  console.log(JSON.stringify({ checks, screenshots, errors }, null, 2));
  await nativeWindow.dispose();
} catch (error) {
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ error: String(error), checks, errors,
    body: page ? await page.locator('body').innerText().catch(() => '') : undefined }, null, 2));
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
