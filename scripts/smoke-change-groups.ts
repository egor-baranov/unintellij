/** Real group context menus and scoped Git mutations in a disposable project. */
import { _electron as electron, expect as baseExpect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 20000 });
const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-change-groups-'));
const repository = join(temporary, 'group-actions-project');
const profile = join(temporary, 'profile');
const captures = join(temporary, 'screenshots');
const artifacts = resolve('artifacts/change-group-menus');
await Promise.all([mkdir(repository), mkdir(profile), mkdir(captures)]);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const text = (value: string) => `export const example = ${JSON.stringify(value)};\n`;
const write = (path: string, value: string) => writeFile(join(repository, path), text(value));
const indexed = async () => (await git('ls-files', '-z')).stdout.split('\0').filter(Boolean).sort();

await git('init', '-q', '-b', 'main');
await git('config', 'user.name', 'Group Context Smoke');
await git('config', 'user.email', 'group-context@example.invalid');
await git('config', 'core.autocrlf', 'false');
await write('changed.ts', 'committed');
await write('clean.ts', 'clean');
await git('add', '.');
await git('commit', '-qm', 'Temporary context menu fixture');
await write('changed.ts', 'working tree modification');
await write('untracked one.ts', 'first new file');
await write('untracked-two.ts', 'second new file');

const executablePath = process.env.SMART_DIFF_PACKAGED_EXECUTABLE;
const application = await electron.launch({
  ...(executablePath ? { executablePath, args: [`--user-data-dir=${profile}`] }
    : { args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${profile}`] }),
  env: { ...process.env, SMART_DIFF_DEV_URL: '' },
});
let page: Page | undefined;
let success = false;
const errors: string[] = [];
const capture = async (name: string) => {
  if (!page) throw new Error('Project window is unavailable.');
  const window = await application.browserWindow(page);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await window.evaluate(window => window.showInactive());
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const image = await Promise.race([
      captureWindow(application, page),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Screenshot timeout: ${name}`)), 15000); }),
    ]);
    await writeFile(join(captures, name), image);
  } finally {
    clearTimeout(timer);
    await window.evaluate(window => window.hide()).catch(() => {});
    await window.dispose();
  }
};

try {
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  await application.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, repository);
  page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const window = await application.browserWindow(page);
  await window.evaluate(window => window.setContentSize(1440, 980));
  await window.dispose();
  const commit = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true });
  if (await commit.getAttribute('aria-pressed') !== 'true') await commit.click();
  const tree = page.getByRole('tree', { name: 'Changed files', exact: true });
  const group = (id: 'changes' | 'untracked') => tree.locator(`[data-node-id="group:${id}"]`);
  const menu = async (id: 'changes' | 'untracked', keyboard = false) => {
    const row = group(id);
    await expect(row).toBeVisible();
    if (keyboard) { await row.focus(); await page!.keyboard.press('Shift+F10'); }
    else await row.locator('.commit-node-name').click({ button: 'right' });
    const popup = page!.getByRole('menu', { name: `${id === 'changes' ? 'Changes' : 'Unversioned Files'} actions`, exact: true });
    await expect(popup).toBeVisible();
    return popup;
  };

  await expect(tree).toBeVisible();
  await tree.getByRole('treeitem', { name: 'changed.ts (working)', exact: true }).click();
  const tab = page.getByRole('tab', { name: 'Commit: changed.ts — working', exact: true });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  const checkedBefore = await group('changes').getByRole('checkbox').getAttribute('aria-checked');
  let popup = await menu('untracked');
  await expect(popup.getByRole('menuitem', { name: 'Add to Git', exact: true })).toBeEnabled();
  await expect(popup.getByRole('menuitem', { name: 'Remove from Git…', exact: true })).toBeDisabled();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await capture('01-unversioned-files-menu.png');
  await popup.getByRole('menuitem', { name: 'Add to Git', exact: true }).click();
  await expect.poll(indexed).toEqual(['changed.ts', 'clean.ts', 'untracked one.ts', 'untracked-two.ts']);
  // Staging a synthetic Unversioned group must not stage the tracked file's edit.
  expect((await git('show', ':changed.ts')).stdout).toBe(text('committed'));
  expect((await git('diff', '--cached', '--name-only')).stdout.trim().split('\n').sort()).toEqual(['untracked one.ts', 'untracked-two.ts']);
  await expect(group('untracked')).toHaveCount(0);
  expect(await group('changes').getByRole('checkbox').getAttribute('aria-checked')).toBe(checkedBefore);
  console.log('PASS: Unversioned Files Add stages only its files and leaves the active diff and tracked modification untouched.');

  await write('later-untracked.ts', 'keep outside Changes');
  await expect(group('untracked')).toBeVisible();
  const before = await Promise.all(['changed.ts', 'clean.ts', 'untracked one.ts', 'untracked-two.ts', 'later-untracked.ts']
    .map(path => readFile(join(repository, path), 'utf8')));
  popup = await menu('changes', true);
  for (const name of ['Add to Git', 'Remove from Git…', 'Include All in Commit', 'Exclude All from Commit', 'Expand All', 'Collapse All']) {
    await expect(popup.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await expect(popup.getByRole('menuitem', { name: 'Remove from Git…', exact: true })).toBeEnabled();
  for (const name of ['Rename…', 'New', 'Copy Path', 'Open In', 'Jump to Source']) {
    await expect(popup.getByRole('menuitem', { name, exact: true })).toHaveCount(0);
  }
  await capture('02-changes-menu.png');
  // Capturing a hidden macOS window can release native keyboard focus. Browser
  // tests cover Escape/focus restoration; dismiss here with a normal outside click.
  await tab.click();
  await expect(popup).toBeHidden();
  popup = await menu('changes');
  await popup.getByRole('menuitem', { name: 'Remove from Git…', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Remove from Git', exact: true });
  await expect(confirmation).toContainText('Changes');
  await expect(confirmation).toContainText(/kept|keep|remain/i);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await indexed()).toEqual(['changed.ts', 'clean.ts', 'untracked one.ts', 'untracked-two.ts']);
  popup = await menu('changes');
  await popup.getByRole('menuitem', { name: 'Remove from Git…', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Remove from Git', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect.poll(indexed).toEqual(['clean.ts']);
  const after = await Promise.all(['changed.ts', 'clean.ts', 'untracked one.ts', 'untracked-two.ts', 'later-untracked.ts']
    .map(path => readFile(join(repository, path), 'utf8')));
  expect(after).toEqual(before);
  expect((await git('show', ':clean.ts')).stdout).toBe(text('clean'));
  await expect(page.locator('.file-action-error')).toHaveCount(0);
  expect(errors).toEqual([]);
  success = true;
  console.log('PASS: Changes removal confirms its scope, keeps every local byte, and excludes clean tracked and untracked paths.');
} catch (error) {
  await capture('failure.png').catch(() => {});
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await mkdir(artifacts, { recursive: true });
  await cp(captures, artifacts, { recursive: true });
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ success, errors, checks: [
    'Group context menus open via mouse and keyboard without selecting a different diff.',
    'Unversioned Add stages only untracked group members.',
    'Changes Remove confirms and keeps local content without untracking clean files.',
  ] }, null, 2));
  if (success) await rm(join(artifacts, 'failure.png'), { force: true });
  await rm(temporary, { recursive: true, force: true });
  console.log(`Group context menu screenshots: ${artifacts}`);
}
