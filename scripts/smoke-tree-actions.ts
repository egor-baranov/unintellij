/** Real Project/Commit context-menu mutations in a disposable Electron workspace.
 * Git/index and filesystem assertions complement the UI; no user repository,
 * existing desktop window, or production IPC result is modified by this smoke. */
import { _electron as electron, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 20000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-tree-actions-'));
const repository = join(directory, 'tree-actions-project');
const profile = join(directory, 'profile');
const captures = join(directory, 'screenshots');
const artifacts = resolve('artifacts/tree-actions');
await Promise.all([mkdir(repository), mkdir(profile), mkdir(captures)]);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const contents = (name: string) => `export const ${name} = true;\n`;
const write = async (path: string, text: string) => {
  await mkdir(dirname(join(repository, path)), { recursive: true });
  await writeFile(join(repository, path), text);
};
const exists = (path: string) => access(join(repository, path)).then(() => true, () => false);
const indexed = async (path: string) => (await git('ls-files', '-z', '--', path)).stdout.split('\0').filter(Boolean).sort();
await git('init', '-q', '-b', 'main');
await git('config', 'user.name', 'Tree Actions Smoke');
await git('config', 'user.email', 'tree-actions@example.invalid');
await git('config', 'core.autocrlf', 'false');
await Promise.all(Object.entries({
  'src/rename.ts': contents('renameOriginal'),
  'src/existing.ts': contents('collisionTarget'),
  'project-remove/file.ts': contents('projectRemove'),
  'project-remove/nested/other.ts': contents('projectRemoveNested'),
  'project-remove-file.ts': contents('projectRemoveFile'),
  'project-rename/child.ts': contents('projectFolder'),
  'commit-remove/file.ts': contents('commitRemove'),
  'commit-remove-folder/a.ts': contents('commitRemoveA'),
  'commit-remove-folder/b.ts': contents('commitRemoveB'),
  'commit-rename/file.ts': contents('commitRename'),
  'commit-rename-folder/child.ts': contents('commitFolder'),
}).map(([path, text]) => write(path, text)));
await git('add', '.');
await git('commit', '-qm', 'Temporary tree actions fixture');
await Promise.all(Object.entries({
  'project-add-file.ts': contents('projectAddFile'),
  'project-add-folder/a.ts': contents('projectAddA'),
  'project-add-folder/nested/b.ts': contents('projectAddB'),
  'commit-add/file.ts': contents('commitAddFile'),
  'commit-add-folder/a.ts': contents('commitAddA'),
  'commit-add-folder/nested/b.ts': contents('commitAddB'),
  'commit-remove/file.ts': contents('commitRemoveModified'),
  'commit-remove-folder/a.ts': contents('commitRemoveModifiedA'),
  'commit-remove-folder/b.ts': contents('commitRemoveModifiedB'),
  'commit-rename/file.ts': contents('commitRenameModified'),
  'commit-rename-folder/child.ts': contents('commitFolderModified'),
}).map(([path, text]) => write(path, text)));

const executablePath = process.env.SMART_DIFF_PACKAGED_EXECUTABLE;
const application = await electron.launch({
  ...(executablePath ? { executablePath, args: [`--user-data-dir=${profile}`] }
    : { args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${profile}`] }),
  env: { ...process.env, SMART_DIFF_DEV_URL: '' },
});
let page: Page | undefined;
let succeeded = false;
const capture = async (name: string) => {
  if (!page) throw new Error('Repository window is unavailable.');
  const window = await application.browserWindow(page);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Only this disposable test window is shown, without activation, while its
    // genuine native screenshot is captured; some macOS hidden windows suspend.
    await window.evaluate(window => { window.showInactive(); });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await Promise.race([
      captureWindow(application, page),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Capture timed out: ${name}`)), 15000); }),
    ]);
    await writeFile(join(captures, name), png);
  } finally {
    clearTimeout(timeout);
    await window.evaluate(window => { window.hide(); }).catch(() => {});
    await window.dispose();
  }
};

try {
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  // Keep deliberate unsaved drafts available for mutation guards in this suite.
  await welcome.evaluate(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repository);
  page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const windowHandle = await application.browserWindow(page);
  await windowHandle.evaluate(window => { window.setContentSize(1440, 980); });
  await windowHandle.dispose();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const mode = async (name: 'Project' | 'Commit') => {
    const button = page!.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name, exact: true });
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  };
  const projectTree = page.getByRole('tree', { name: 'Project files', exact: true });
  const projectRow = (path: string) => projectTree.getByRole('treeitem', { name: path || 'tree-actions-project', exact: true });
  const commitTree = page.getByRole('tree', { name: 'Changed files', exact: true });
  const commitFile = (path: string, group: 'working' | 'untracked' = 'working') => commitTree.getByRole('treeitem', { name: `${path} (${group})`, exact: true });
  const commitFolder = (path: string) => commitTree.locator(`.commit-folder[data-path=${JSON.stringify(path)}]`);
  const comparisonGroup = (path: string) => page!.evaluate(async path => {
    const [repository] = await window.desktop.listOpenRepositories();
    const snapshot = await window.desktop.listChanges(repository.id);
    return [...snapshot.workingChanges ?? [], ...snapshot.changes].find(change => change.path === path)?.group;
  }, path);
  const comparisonCode = page.getByRole('main', { name: 'Selected file comparison', exact: true })
    .locator('.smart-diff-pane[data-side="modified"] .view-lines, [data-testid="file-surface"] .view-lines');
  const expandProject = async (path: string) => {
    const item = projectRow(path);
    await expect(item).toBeVisible();
    if (await item.getAttribute('aria-expanded') !== 'true') await item.locator('.project-node-name').click();
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  const context = async (target: Locator, directory = false) => {
    await expect(target).toBeVisible();
    await target.scrollIntoViewIfNeeded();
    await page!.locator('.project-tree, .commit-tree').evaluateAll(elements => { for (const element of elements) element.scrollLeft = 0; });
    const label = target.locator('.project-node-name, .commit-node-name');
    if (await label.count()) await label.first().click({ button: 'right' });
    else await target.click({ button: 'right', position: { x: 100, y: 12 } });
    const menu = page!.getByRole('menu', { name: directory ? 'Directory actions' : 'File actions', exact: true });
    await expect(menu).toBeVisible();
    return menu;
  };
  const action = async (target: Locator, name: string, directory = false) => {
    const menu = await context(target, directory);
    const item = menu.getByRole('menuitem', { name, exact: true });
    await expect(item).toBeEnabled();
    await item.click();
  };
  const enterName = async (title: 'Rename' | 'New File' | 'New Folder', name: string) => {
    const dialog = page!.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await dialog.getByRole('button', { name: title === 'Rename' ? 'Rename' : 'Create', exact: true }).click();
    return dialog;
  };
  const removeFromGit = async (target: Locator, paths: string[], directory = false) => {
    const before = await Promise.all(paths.map(path => readFile(join(repository, path), 'utf8')));
    await action(target, 'Remove from Git…', directory);
    const dialog = page!.getByRole('dialog', { name: 'Remove from Git', exact: true });
    await expect(dialog).toContainText(/kept|keep|remain/i);
    await dialog.getByRole('button', { name: 'Remove from Git', exact: true }).click();
    await expect(dialog).toBeHidden();
    for (let index = 0; index < paths.length; index++) {
      await expect.poll(() => indexed(paths[index])).toEqual([]);
      expect(await readFile(join(repository, paths[index]), 'utf8')).toBe(before[index]);
    }
  };
  const create = async (target: Locator, kind: 'File' | 'Folder', name: string, directory = true) => {
    const menu = await context(target, directory);
    await menu.getByRole('menuitem', { name: 'New', exact: true }).click();
    await page!.getByRole('menu', { name: 'New', exact: true }).getByRole('menuitem', { name: `${kind}…`, exact: true }).click();
    const dialog = await enterName(`New ${kind}`, name);
    await expect(dialog).toBeHidden();
  };

  await mode('Project');
  await expandProject('src');
  await projectRow('src/rename.ts').locator('.project-node-name').click();
  const code = page.getByTestId('file-surface').locator('.view-lines');
  await expect(code).toContainText('renameOriginal');
  const directoryMenu = await context(projectRow('src'), true);
  for (const name of ['New', 'Rename…', 'Copy Path', 'Mark Directory As', 'Add to Git', 'Remove from Git…']) {
    await expect(directoryMenu.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await expect(directoryMenu.getByRole('menuitem', { name: 'New', exact: true })).toBeEnabled();
  await directoryMenu.getByRole('menuitem', { name: 'Copy Path', exact: true }).click();
  await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText())).toBe(join(await realpath(repository), 'src'));
  await expect(page.locator('.file-action-error')).toHaveCount(0);
  const captureMenu = await context(projectRow('src'), true);
  await expect(captureMenu.getByRole('menuitem', { name: 'New', exact: true })).toBeEnabled();
  await capture('01-project-directory-menu.png');
  await page.keyboard.press('Escape');

  await action(projectRow('project-add-file.ts'), 'Add to Git');
  await expect.poll(() => indexed('project-add-file.ts')).toEqual(['project-add-file.ts']);
  await action(projectRow('project-add-folder'), 'Add to Git', true);
  await expect.poll(() => indexed('project-add-folder')).toEqual(['project-add-folder/a.ts', 'project-add-folder/nested/b.ts']);
  await removeFromGit(projectRow('project-remove-file.ts'), ['project-remove-file.ts']);
  await removeFromGit(projectRow('project-remove'), ['project-remove/file.ts', 'project-remove/nested/other.ts'], true);
  console.log('PASS: Project file/folder Add to Git updates the index; Remove from Git retains every local byte.');

  // Rename cancellation and collisions must leave both source and target alone.
  await action(projectRow('src/rename.ts'), 'Rename…');
  let dialog = page.getByRole('dialog', { name: 'Rename', exact: true });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('canceled.ts');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await exists('src/canceled.ts')).toBe(false);
  expect(await readFile(join(repository, 'src/rename.ts'), 'utf8')).toBe(contents('renameOriginal'));
  await action(projectRow('src/rename.ts'), 'Rename…');
  dialog = await enterName('Rename', 'existing.ts');
  await expect(dialog.getByRole('alert')).toContainText(/exist/i);
  expect(await readFile(join(repository, 'src/existing.ts'), 'utf8')).toBe(contents('collisionTarget'));
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('tab', { name: 'src/rename.ts', exact: true }).click();
  await page.getByTestId('file-surface').locator('.monaco-editor').click({ position: { x: 160, y: 20 } });
  await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText(contents('unsavedRenameDraft'));
  await expect(page.getByRole('tab', { name: 'src/rename.ts', exact: true }).getByRole('img', { name: 'Unsaved changes', exact: true })).toBeVisible();
  await action(projectRow('src/rename.ts'), 'Rename…');
  dialog = page.getByRole('dialog', { name: 'Rename', exact: true });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('renamed.ts');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/Save .*first/i);
  await capture('02-rename-dirty-file.png');
  expect(await exists('src/renamed.ts')).toBe(false);
  expect(await readFile(join(repository, 'src/rename.ts'), 'utf8')).toBe(contents('renameOriginal'));
  await expect(code).toContainText('unsavedRenameDraft');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('file-surface').locator('.monaco-editor').click({ position: { x: 160, y: 20 } });
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => readFile(join(repository, 'src/rename.ts'), 'utf8')).toBe(contents('unsavedRenameDraft'));
  await expect(page.getByRole('tab', { name: 'src/rename.ts', exact: true }).getByRole('img', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
  const fileInstance = await page.getByRole('tab', { name: 'src/rename.ts', exact: true }).getAttribute('data-instance-id');
  await action(projectRow('src/rename.ts'), 'Rename…');
  dialog = await enterName('Rename', 'renamed.ts');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('tab', { name: 'src/renamed.ts', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'src/renamed.ts', exact: true })).toHaveAttribute('data-instance-id', fileInstance!);
  await expect(page.getByRole('tab', { name: 'src/rename.ts', exact: true })).toHaveCount(0);
  await expect(code).toContainText('unsavedRenameDraft');
  expect(await exists('src/rename.ts')).toBe(false);
  expect(await readFile(join(repository, 'src/renamed.ts'), 'utf8')).toBe(contents('unsavedRenameDraft'));
  await page.getByTestId('file-surface').locator('.monaco-editor').click({ position: { x: 160, y: 20 } });
  await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText(contents('savedAtNewPath'));
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => readFile(join(repository, 'src/renamed.ts'), 'utf8')).toBe(contents('savedAtNewPath'));
  expect(await exists('src/rename.ts')).toBe(false);
  await expect(page.getByRole('tab', { name: 'src/renamed.ts', exact: true }).getByRole('img', { name: 'Unsaved changes', exact: true })).toHaveCount(0);

  await expandProject('project-rename');
  await projectRow('project-rename/child.ts').locator('.project-node-name').click();
  await expect(code).toContainText('projectFolder');
  await action(projectRow('project-rename'), 'Rename…', true);
  await expect(await enterName('Rename', 'project-renamed')).toBeHidden();
  await expect(page.getByRole('tab', { name: 'project-renamed/child.ts', exact: true })).toBeVisible();
  await expect(code).toContainText('projectFolder');
  expect(await exists('project-rename')).toBe(false);
  await create(projectRow('src'), 'Folder', 'created-folder');
  expect((await stat(join(repository, 'src/created-folder'))).isDirectory()).toBe(true);
  await create(projectRow(''), 'Folder', 'root-created');
  expect((await stat(join(repository, 'root-created'))).isDirectory()).toBe(true);
  await create(projectRow('src/renamed.ts'), 'File', 'created.ts', false);
  await expect(page.getByRole('tab', { name: 'src/created.ts', exact: true })).toBeVisible();
  expect(await readFile(join(repository, 'src/created.ts'), 'utf8')).toBe('');
  console.log('PASS: unsaved rename is rejected without losing the draft; saved renames retain tabs and save destination, creation works, and cancel/collision are nondestructive.');

  await mode('Commit');
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await commitFile('commit-rename/file.ts').click();
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  const menu = await context(commitFile('commit-rename/file.ts'));
  for (const name of ['Jump to Source', 'New', 'Rename…', 'Copy Path', 'Open In', 'Add to Git', 'Remove from Git…']) {
    await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await expect(menu.getByRole('menuitem', { name: 'Rename…', exact: true })).toBeEnabled();
  await expect(menu.getByRole('menuitem', { name: 'Jump to Source', exact: true })).toBeEnabled();
  await capture('03-commit-file-menu.png');
  await page.keyboard.press('Escape');
  await action(commitFile('commit-add/file.ts', 'untracked'), 'Add to Git');
  await expect.poll(() => indexed('commit-add/file.ts')).toEqual(['commit-add/file.ts']);
  // Staging moves this folder from Unversioned Files into Changes. The new
  // grouping has its own expansion identity; expand it before checking its row.
  await expect(commitFile('commit-add/file.ts', 'untracked')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await expect(commitFile('commit-add/file.ts')).toBeVisible();
  await action(commitFolder('commit-add-folder'), 'Add to Git', true);
  await expect.poll(() => indexed('commit-add-folder')).toEqual(['commit-add-folder/a.ts', 'commit-add-folder/nested/b.ts']);
  await removeFromGit(commitFile('commit-remove/file.ts'), ['commit-remove/file.ts']);
  await removeFromGit(commitFolder('commit-remove-folder'), ['commit-remove-folder/a.ts', 'commit-remove-folder/b.ts'], true);

  const comparisonInstance = await page.getByRole('tab', { name: 'Commit: commit-rename/file.ts — working', exact: true }).getAttribute('data-instance-id');
  await action(commitFile('commit-rename/file.ts'), 'Rename…');
  await expect(await enterName('Rename', 'renamed.ts')).toBeHidden();
  await expect.poll(() => comparisonGroup('commit-rename/renamed.ts')).toBeTruthy();
  const renamedComparison = page.getByRole('tab', { name: `Commit: commit-rename/renamed.ts — ${await comparisonGroup('commit-rename/renamed.ts')}`, exact: true });
  await expect(renamedComparison).toBeVisible();
  await expect(renamedComparison).toHaveAttribute('data-instance-id', comparisonInstance!);
  await expect(page.getByRole('tab', { name: 'Commit: commit-rename/file.ts — working', exact: true })).toHaveCount(0);
  await expect(comparisonCode).toContainText('commitRenameModified');
  await commitFile('commit-rename-folder/child.ts').click();
  await action(commitFolder('commit-rename-folder'), 'Rename…', true);
  await expect(await enterName('Rename', 'commit-renamed-folder')).toBeHidden();
  await expect.poll(() => comparisonGroup('commit-renamed-folder/child.ts')).toBeTruthy();
  await expect(page.getByRole('tab', { name: `Commit: commit-renamed-folder/child.ts — ${await comparisonGroup('commit-renamed-folder/child.ts')}`, exact: true })).toBeVisible();
  await expect(comparisonCode).toContainText('commitFolderModified');
  await create(commitFolder('commit-add'), 'Folder', 'new-folder');
  expect((await stat(join(repository, 'commit-add/new-folder'))).isDirectory()).toBe(true);
  // Empty directories are revealed in Project because Git does not list them.
  await mode('Commit');
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await create(commitFile('commit-add/file.ts'), 'File', 'created-from-commit.ts', false);
  await expect(page.getByRole('tab', { name: 'commit-add/created-from-commit.ts', exact: true })).toBeVisible();
  expect(await readFile(join(repository, 'commit-add/created-from-commit.ts'), 'utf8')).toBe('');
  await mode('Commit');
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await expect(commitFile('commit-add/created-from-commit.ts', 'untracked')).toBeVisible();
  expect(errors).toEqual([]);
  await expect(page.locator('.file-action-error')).toHaveCount(0);
  succeeded = true;
  console.log('PASS: Commit file/folder staging, removal, rename, and creation refresh the tree and preserve open diff tabs.');
} catch (error) {
  await capture('failure.png').catch(() => {});
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await mkdir(artifacts, { recursive: true });
  await cp(captures, artifacts, { recursive: true });
  if (succeeded) await rm(join(artifacts, 'failure.png'), { force: true });
  await rm(directory, { recursive: true, force: true });
  console.log(`Tree action screenshots: ${artifacts}`);
}
