/** Exercise actual keyboard edits and safe saves in the production Electron app. */
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const expect = baseExpect.configure({ timeout: 10000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-editing-smoke-'));
const repository = join(directory, 'repository');
await mkdir(repository);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
await git('init', '-q', '-b', 'main');
await writeFile(join(repository, 'sample.ts'), 'export const value = 1;\n');
await writeFile(join(repository, 'clean.ts'), 'export const clean = true;\n');
await git('add', '.');
await git('-c', 'user.name=Smoke Test', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'Temporary fixture');
await writeFile(join(repository, 'sample.ts'), 'export const value = 2;\n');
await git('add', 'sample.ts');
await writeFile(join(repository, 'sample.ts'), 'export const value = 3;\n');
await mkdir(join(directory, 'profile'), { recursive: true });
const application = await electron.launch({ args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${join(directory, 'profile')}`], env: { ...process.env, SMART_DIFF_DEV_URL: '' } });
try {
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, repository);
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  // This suite exercises explicit save/discard; automatic saving has its own smoke suite.
  await welcome.evaluate(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  // Electron cancels beforeunload itself; CDP can report that already-closed
  // dialog. Handle it explicitly instead of Playwright's automatic acceptance.
  page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.getByRole('treeitem', { name: 'sample.ts (working)', exact: true }).click();
  const modified = page.locator('.smart-diff-pane[data-side="modified"]');
  const original = page.locator('.smart-diff-pane[data-side="original"]');
  await expect(modified.locator('.view-lines')).toContainText('3');
  await expect(page.getByRole('main', { name: 'Selected file comparison' })).toHaveAttribute('data-editable', 'true');
  await modified.locator('.view-lines').click({ position: { x: 80, y: 10 } }); await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText('export const value = 42;\n');
  await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).toBeVisible();
  await expect(original.locator('.view-lines')).toContainText(/value\s*=\s*1/);
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => readFile(join(repository, 'sample.ts'), 'utf8')).toBe('export const value = 42;\n');
  await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
  expect((await git('show', ':sample.ts')).stdout).toBe('export const value = 2;\n');
  console.log('PASS: right-pane keyboard edit saved to working tree; index unchanged.');
  // An unchanged project file becomes a real unstaged change on save.
  await page.getByRole('group', { name: 'Workspace view' }).getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('treeitem', { name: 'clean.ts', exact: true }).click();
  const file = page.getByTestId('file-surface');
  await expect(file).toHaveAttribute('data-editable', 'true');
  await file.locator('.view-lines').click({ position: { x: 80, y: 10 } }); await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText('export const clean = false;\n');
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => readFile(join(repository, 'clean.ts'), 'utf8')).toBe('export const clean = false;\n');
  console.log('PASS: project editor saves unchanged files.');
  // Watcher refresh must not replace an unsaved draft with external bytes.
  await file.locator('.view-lines').click({ position: { x: 80, y: 10 } }); await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText('export const mine = true;\n');
  await writeFile(join(repository, 'clean.ts'), 'export const external = true;\n');
  await page.keyboard.press(`${mod}+r`);
  await expect(page.locator('.editing-notice')).toContainText('changed on disk');
  await expect(file.locator('.view-lines')).toContainText('mine');
  await file.locator('.view-lines').click({ position: { x: 80, y: 10 } }); await page.keyboard.press(`${mod}+s`);
  await expect(page.locator('.editing-notice')).toContainText(/Reload|reload/);
  expect(await readFile(join(repository, 'clean.ts'), 'utf8')).toBe('export const external = true;\n');
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click();
  await expect(file.locator('.view-lines')).toContainText('external');
  console.log('PASS: external conflict keeps unsaved text and rejects stale save; reload succeeds.');
  // Canceling app quit keeps Git services alive; Save in the close dialog works.
  await file.locator('.view-lines').click({ position: { x: 80, y: 10 } }); await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText('export const retained = true;\n');
  await application.evaluate(({ app }) => app.quit());
  const dialog = page.getByRole('dialog', { name: 'Save changes?', exact: true });
  await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await file.locator('.view-lines').click({ position: { x: 80, y: 10 } }); await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => readFile(join(repository, 'clean.ts'), 'utf8')).toBe('export const retained = true;\n');
  await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
  await mkdir('artifacts/editing', { recursive: true });
  await writeFile('artifacts/editing/electron-editable-file.png', await captureWindow(application, page));
  const secondRepository = join(directory, 'second-project');
  await mkdir(secondRepository);
  await run('git', ['-C', secondRepository, 'init', '-q'], { shell: false });
  await writeFile(join(secondRepository, 'second.ts'), 'export const second = true;\n');
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, secondRepository);
  await page.getByRole('group', { name: 'Workspace view' }).getByRole('button', { name: 'Commit', exact: true }).click();
  const projects = page.getByRole('button', { name: 'Project switcher', exact: true });
  await projects.click();
  const secondPage = await openRepositoryWindow(application, () => page.getByRole('menuitem', { name: 'Open…', exact: true }).click());
  secondPage.on('pageerror', error => errors.push(error.message));
  const secondProjects = secondPage.getByRole('button', { name: 'Project switcher', exact: true });
  await expect(secondProjects).toContainText('second-project');
  await expect(projects).toContainText('repository');
  await secondProjects.click(); await secondPage.getByRole('menuitem', { name: 'repository', exact: true }).click();
  await hideWindow(application, page);
  await expect(secondProjects).toContainText('second-project');
  await expect(projects).toContainText('repository');
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await page.getByRole('treeitem', { name: 'sample.ts (working)', exact: true }).click();
  await expect(page.locator('[data-side="modified"] .view-lines')).toContainText(/value\s*=\s*42/);
  await expect(page.locator('[data-side="original"] .view-lines')).toContainText(/value\s*=\s*1/);
  await expect(page.getByRole('treeitem', { name: 'sample.ts (working)', exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
  console.log('PASS: production Electron working-tree diff/project edits and saves, unchanged index, external-change protection, reload, canceled quit and subsequent save.');
} finally {
  // Test fixtures can still be dirty when an assertion fails. Tear down the
  // isolated process without waiting on its unsaved-changes dialog.
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close(); await rm(directory, { recursive: true, force: true });
}
