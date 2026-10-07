/** Build first, then exercise automatic/manual saves in an isolated production Electron app. */
import { _electron as electron, expect as baseExpect, type Locator } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 10000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-autosave-smoke-'));
const repository = join(directory, 'repository');
const profile = join(directory, 'profile');
const artifactDirectory = resolve('artifacts/autosave');
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const checks: string[] = [];
const pass = (check: string) => { checks.push(check); console.log(`PASS: ${check}`); };
const initialClean = 'export const clean = true;\n';
const initialHead = 'export const value = 1;\n';
const initialIndex = 'export const value = 2;\n';
await mkdir(repository);
await mkdir(profile);
await mkdir(artifactDirectory, { recursive: true });
await git('init', '-q', '-b', 'main');
await writeFile(join(repository, 'clean.ts'), initialClean);
await writeFile(join(repository, 'sample.ts'), initialHead);
await git('add', '--', 'clean.ts', 'sample.ts');
await git('-c', 'user.name=Autosave Smoke', '-c', 'user.email=autosave-smoke@example.invalid', 'commit', '-qm', 'Temporary fixture');
await writeFile(join(repository, 'sample.ts'), initialIndex);
await git('add', '--', 'sample.ts');
await writeFile(join(repository, 'sample.ts'), 'export const value = 3;\n');
const head = (await git('rev-parse', 'HEAD')).stdout.trim();
const application = await electron.launch({
  args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${profile}`],
  env: { ...process.env, SMART_DIFF_DEV_URL: '' },
});

try {
  const welcome = await application.firstWindow();
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repository);
  await hideWindow(application, welcome);
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const automatic = settings.getByRole('checkbox', { name: 'Save changes automatically', exact: true });
  const file = page.getByTestId('file-surface');
  const disk = () => readFile(join(repository, 'clean.ts'), 'utf8');
  const openSettings = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('navigation', { name: 'Settings categories', exact: true }).getByRole('button', { name: 'Files', exact: true }).click();
  };
  const setAutomatic = async (enabled: boolean, action: 'Save' | 'Apply' = 'Save') => {
    await openSettings();
    await automatic.setChecked(enabled);
    await settings.getByRole('button', { name: action, exact: true }).click();
    if (action === 'Apply') await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(settings).toHaveCount(0);
  };
  const edit = async (surface: Locator, text: string) => {
    await expect(surface).toBeVisible();
    await surface.locator('.view-lines').click({ position: { x: 80, y: 10 } });
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.insertText(text);
  };
  const expectUnsaved = async () => { await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).not.toHaveCount(0); };
  const expectSaved = async () => { await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).toHaveCount(0); };
  const expectDiskUnchanged = async (expected: string) => {
    // Observe beyond the one-second idle interval, not merely immediately after editing.
    const until = Date.now() + 1600;
    do { expect(await disk()).toBe(expected); await delay(100); } while (Date.now() < until);
    expect(await disk()).toBe(expected);
  };

  await openSettings();
  await expect(automatic).toBeChecked();
  await writeFile(join(artifactDirectory, 'electron-files-settings.png'), await captureWindow(application, page));
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  pass('Automatic saving is enabled by default in Settings > Files.');

  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('treeitem', { name: 'clean.ts', exact: true }).click();
  await expect(file).toHaveAttribute('data-editable', 'true');
  const automaticText = 'export const clean = false;\n';
  await edit(file, automaticText);
  await expectUnsaved();
  await expect.poll(disk).toBe(automaticText);
  await expectSaved();
  pass('An unchanged project file saves automatically to disk after editing.');

  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true }).click();
  await page.getByRole('treeitem', { name: 'sample.ts (working)', exact: true }).click();
  const modified = page.locator('.smart-diff-pane[data-side="modified"]');
  await expect(page.getByRole('main', { name: 'Selected file comparison', exact: true })).toHaveAttribute('data-editable', 'true');
  await expect(modified.locator('.view-lines')).toContainText(/value\s*=\s*3/);
  await edit(modified, 'export const value = 42;\n');
  await expect.poll(() => readFile(join(repository, 'sample.ts'), 'utf8')).toBe('export const value = 42;\n');
  await expectSaved();
  expect((await git('show', ':sample.ts')).stdout).toBe(initialIndex);
  expect((await git('show', 'HEAD:sample.ts')).stdout).toBe(initialHead);
  expect((await git('rev-parse', 'HEAD')).stdout.trim()).toBe(head);
  await writeFile(join(artifactDirectory, 'electron-autosaved-diff.png'), await captureWindow(application, page));
  pass('Working-tree diff edits save automatically without changing the staged file or HEAD.');

  await setAutomatic(false, 'Apply');
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('treeitem', { name: 'clean.ts', exact: true }).click();
  const manualText = 'export const manual = true;\n';
  await edit(file, manualText);
  await expectUnsaved();
  await expectDiskUnchanged(automaticText);
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(disk).toBe(manualText);
  await expectSaved();
  pass('Apply disables automatic saving; the standard save shortcut still writes the file.');

  await page.reload();
  await expect(file).toHaveAttribute('data-path', 'clean.ts');
  await openSettings();
  await expect(automatic).not.toBeChecked();
  await automatic.check();
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openSettings();
  await expect(automatic).not.toBeChecked();
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  const resumedText = 'export const resumed = true;\n';
  await edit(file, resumedText);
  await expectDiskUnchanged(manualText);
  await setAutomatic(true);
  await expect.poll(disk).toBe(resumedText);
  await expectSaved();
  pass('Disabled preference survives reload; Cancel discards its draft; enabling saves existing dirty text.');

  await page.reload();
  await expect(file).toHaveAttribute('data-path', 'clean.ts');
  await openSettings();
  await expect(automatic).toBeChecked();
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  const reloadedText = 'export const reloaded = true;\n';
  await edit(file, reloadedText);
  await expect.poll(disk).toBe(reloadedText);
  await expectSaved();
  pass('Enabled preference survives reload and automatic saving resumes.');

  // Establish an external conflict with saving disabled, then enable it. Neither
  // the existing conflict nor further typing may overwrite the external bytes.
  await setAutomatic(false);
  await edit(file, 'export const mine = true;\n');
  const externalText = 'export const external = true;\n';
  await writeFile(join(repository, 'clean.ts'), externalText);
  await expect(page.locator('.editing-notice')).toContainText('changed on disk');
  await setAutomatic(true);
  await expectDiskUnchanged(externalText);
  await expect(file.locator('.view-lines')).toContainText('mine');
  await edit(file, 'export const mineAgain = true;\n');
  await expectDiskUnchanged(externalText);
  await expectUnsaved();
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click();
  await expect(file.locator('.view-lines')).toContainText('external');
  await expectSaved();
  pass('An external conflict preserves editor drafts and never overwrites disk, including after further typing.');

  expect((await git('show', ':clean.ts')).stdout).toBe(initialClean);
  expect((await git('show', ':sample.ts')).stdout).toBe(initialIndex);
  expect((await git('rev-parse', 'HEAD')).stdout.trim()).toBe(head);
  expect(errors).toEqual([]);
  await writeFile(join(artifactDirectory, 'summary.json'), JSON.stringify({ checks, rendererErrors: errors, screenshots: ['electron-files-settings.png', 'electron-autosaved-diff.png'] }, null, 2));
  console.log(`PASS: ${checks.length} production Electron autosave checks; screenshots and summary in ${artifactDirectory}.`);
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
