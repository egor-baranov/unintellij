/** Production Electron commit controls, operating only on an isolated temporary
 * repository and local bare remote. Never commits or pushes the developer repo. */
import { _electron as electron, expect as baseExpect, type Page } from '@playwright/test';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const expect = baseExpect.configure({ timeout: 15000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-commit-actions-'));
const repository = join(directory, 'repository');
const remote = join(directory, 'remote.git');
const captures = join(directory, 'screenshots');
await mkdir(repository);
await mkdir(captures);
const git = async (...args: string[]) => (await run('git', ['-C', repository, ...args], { shell: false })).stdout;
await git('init', '-q', '-b', 'main');
await git('config', 'user.name', 'Commit Smoke');
await git('config', 'user.email', 'smoke@example.invalid');
await git('config', 'core.autocrlf', 'false');
await writeFile(join(repository, 'unchecked.ts'), 'export const value = 1;\n');
await git('add', '--', 'unchecked.ts');
await git('commit', '-qm', 'Isolated commit controls fixture');
await run('git', ['init', '--bare', '-q', remote], { shell: false });
await git('remote', 'add', 'origin', remote);
await git('push', '-qu', 'origin', 'main');
const originalHead = (await git('rev-parse', 'HEAD')).trim();
await writeFile(join(repository, 'unchecked.ts'), 'export const value = 2;\n');
await git('add', '--', 'unchecked.ts');
await writeFile(join(repository, 'unchecked.ts'), 'export const value = 3;\n');
const selectedText = 'export const selectedAddition = true;\n';
await writeFile(join(repository, 'selected.ts'), selectedText);

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
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await writeFile(join(captures, name), await captureWindow(application, page));
};

try {
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, repository);
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  repositoryPage = page;
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.stack ?? error.message); });
  expect(page.url()).toBe('app://smart-diff/index.html');
  const panel = page.getByRole('region', { name: 'Commit changes', exact: true });
  await expect(panel.getByRole('treeitem', { name: 'selected.ts (untracked)', exact: true })).toBeVisible();
  await expect(panel.getByRole('treeitem', { name: 'unchecked.ts (working)', exact: true })).toHaveCount(1);
  await expect(panel.getByRole('treeitem', { name: /^(?:Staged|Unstaged)$/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Refresh changes', exact: true })).toBeEnabled();
  const commit = panel.getByRole('button', { name: 'Commit', exact: true });
  const commitPush = panel.getByRole('button', { name: 'Commit and Push…', exact: true });
  await expect(commit).toBeDisabled();
  await panel.getByRole('textbox', { name: 'Commit message (local draft)', exact: true }).fill('Commit only the checked new source file');
  await expect(commit).toBeDisabled();
  await panel.getByRole('checkbox', { name: 'Include selected.ts in review', exact: true }).check();
  await expect(commit).toBeEnabled();
  await expect(commitPush).toBeEnabled();
  await expect(commit).toHaveCSS('background-color', 'rgb(53, 116, 240)');
  await panel.getByRole('treeitem', { name: 'selected.ts (untracked)', exact: true }).click();
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toContainText('selectedAddition');
  await panel.getByRole('button', { name: 'Commit settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Commit settings', exact: true });
  await settings.getByRole('textbox', { name: /Author/ }).fill('Review Author <author@example.invalid>');
  for (const name of ['Sign-off commit', 'Check whitespace', 'Check TODO']) {
    await settings.getByRole('checkbox', { name, exact: true }).check();
  }
  await capture('electron-commit-settings.png');
  await page.keyboard.press('Escape');
  await commitPush.click();
  const review = page.getByRole('dialog', { name: 'Commit Selected Changes', exact: true });
  await expect(review).toContainText('1 selected file');
  await expect(review).toContainText('Review Author <author@example.invalid>');
  await expect(review).toContainText('Whitespace, New TODOs');
  expect((await git('rev-parse', 'HEAD')).trim()).toBe(originalHead);
  await capture('electron-commit-review.png');
  await review.getByRole('button', { name: 'Commit and Continue to Push', exact: true }).click();
  const push = page.getByRole('dialog', { name: 'Push Branch', exact: true });
  await expect(push).toBeVisible();
  await expect(push).toContainText('Commit created');
  const committedHead = (await git('rev-parse', 'HEAD')).trim();
  expect(committedHead).not.toBe(originalHead);
  expect((await git('log', '-1', '--format=%an <%ae>')).trim()).toBe('Review Author <author@example.invalid>');
  expect(await git('log', '-1', '--format=%B')).toContain('Signed-off-by: Commit Smoke <smoke@example.invalid>');
  expect((await git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).trim()).toBe('selected.ts');
  expect(await git('show', 'HEAD:selected.ts')).toBe(selectedText);
  expect(await git('show', 'HEAD:unchecked.ts')).toBe('export const value = 1;\n');
  expect(await git('show', ':unchecked.ts')).toBe('export const value = 2;\n');
  expect(await readFile(join(repository, 'unchecked.ts'), 'utf8')).toBe('export const value = 3;\n');
  const remoteHead = async () => (await run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { shell: false })).stdout.trim();
  expect(await remoteHead()).toBe(originalHead);
  console.log('PASS: production IPC committed only the selected file with author, sign-off and checks; unchecked index and working content preserved.');
  await capture('electron-commit-push-review.png');
  await push.getByRole('button', { name: 'Push', exact: true }).click();
  await expect(push).toHaveCount(0);
  await expect.poll(remoteHead).toBe(committedHead);
  expect((await git('rev-parse', 'HEAD')).trim()).toBe(committedHead);
  await expect(panel.getByRole('treeitem', { name: 'selected.ts (untracked)', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('treeitem', { name: 'unchecked.ts (working)', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('PASS: explicit push review published that one commit to the isolated local bare remote; no renderer errors.');
} catch (error) {
  await capture('electron-commit-failure.png').catch(() => {});
  throw error;
} finally {
  await application.close();
  // Publish captures only after shutting down the isolated app, avoiding
  // unrelated refresh traffic if another desktop instance watches this repo.
  await mkdir(resolve('artifacts/commit-actions'), { recursive: true });
  await cp(captures, resolve('artifacts/commit-actions'), { recursive: true });
  await rm(directory, { recursive: true, force: true });
}
