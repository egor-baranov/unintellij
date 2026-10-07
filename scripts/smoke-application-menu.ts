/** Exercise the real native application menu in disposable production Electron windows.
 * Build first. All filesystem/Git mutations stay inside the temporary fixture.
 * Menu callbacks are invoked through the actual Menu, never a renderer test bridge. */
import { _electron as electron, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 15000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-menu-smoke-'));
const repository = join(directory, 'menu-project');
const secondRepository = join(directory, 'second-project');
const profile = join(directory, 'profile');
const artifacts = resolve('artifacts/application-menu');
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
await Promise.all([mkdir(repository), mkdir(secondRepository), mkdir(profile), mkdir(artifacts, { recursive: true })]);
await git('init', '-q', '-b', 'main');
await git('config', 'user.name', 'Menu Smoke');
await git('config', 'user.email', 'menu-smoke@example.invalid');
const sample = Array.from({ length: 100 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join('\n') + '\n';
await writeFile(join(repository, 'sample.ts'), sample);
await writeFile(join(repository, 'clean.ts'), 'export const clean = true;\n');
await writeFile(join(repository, 'other.ts'), 'export const other = true;\n');
await git('add', '.');
await git('commit', '-qm', 'Disposable menu fixture');
await writeFile(join(repository, 'sample.ts'), sample.replace('line5 = 5', 'line5 = 500').replace('line90 = 90', 'line90 = 900'));
await run('git', ['init', '--bare', '-q', join(directory, 'remote.git')], { shell: false });
await git('remote', 'add', 'origin', join(directory, 'remote.git'));
await run('git', ['-C', secondRepository, 'init', '-q', '-b', 'main'], { shell: false });
await writeFile(join(secondRepository, 'second.ts'), 'export const second = true;\n');
const head = (await git('rev-parse', 'HEAD')).stdout.trim();
const checks: string[] = [], errors: string[] = [], screenshots: string[] = [];
const pass = (message: string) => { checks.push(message); console.log(`PASS: ${message}`); };
const application = await electron.launch({
  args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${profile}`],
  env: { ...process.env, SMART_DIFF_DEV_URL: '' },
});
let activePage: Page | undefined;
let activeWindowId: number | undefined;

const focus = async (page: Page) => {
  activePage = page;
  const window = await application.browserWindow(page);
  try {
    activeWindowId = await window.evaluate(window => { window.webContents.setBackgroundThrottling(false); window.hide(); return window.id; });
  } finally { await window.dispose(); }
};
const state = async (id: string) => {
  for (let attempt = 0; attempt < 5; attempt++) {
  const result = await application.evaluate(async ({ Menu, BrowserWindow }, { id, windowId }) => {
  const window = BrowserWindow.fromId(windowId!);
  if (!window) throw new Error('Disposable menu window is unavailable.');
  try {
    window.show(); window.focus();
    await new Promise(resolve => setTimeout(resolve, 150));
    if (BrowserWindow.getFocusedWindow() !== window) return null;
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`Missing application menu item: ${id}`);
    return { enabled: item.enabled, checked: item.checked, label: item.label, accelerator: item.accelerator };
  } finally { window.hide(); }
  }, { id, windowId: activeWindowId });
  if (result) return result;
  }
  throw new Error('Disposable menu window could not retain focus long enough to read native menu state.');
};
const action = async (id: string) => {
  await expect.poll(() => application.evaluate(async ({ Menu, BrowserWindow }, { id, windowId }) => {
    const window = BrowserWindow.fromId(windowId!);
    if (!window) throw new Error('Disposable menu window is unavailable.');
    try {
      window.show(); window.focus();
      // Native focus rebuilds the global menu; the renderer may briefly refresh
      // the repository after focus. Limit foreground exposure to 250 ms and
      // keep all text input / renderer waits in the hidden window.
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        const item = Menu.getApplicationMenu()?.getMenuItemById(id);
        if (!item) throw new Error(`Missing application menu item: ${id}`);
        if (!item.enabled || BrowserWindow.getFocusedWindow() !== window) continue;
        item.click(undefined, window, {});
        await new Promise(resolve => setTimeout(resolve, 100));
        return true;
      }
      return false;
    } finally { window.hide(); }
  }, { id, windowId: activeWindowId }), { message: `${id} becomes enabled` }).toBe(true);
};
const capture = async (page: Page, name: string) => {
  await page.locator('.project-tree').evaluateAll(elements => { for (const element of elements) element.scrollLeft = 0; });
  await writeFile(join(artifacts, name), await captureWindow(application, page));
  screenshots.push(name);
};
const track = (page: Page) => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
};

try {
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  await welcome.evaluate(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
  await focus(welcome);
  await expect.poll(async () => (await state('file.save')).enabled).toBe(false);
  await expect.poll(async () => (await state('file.newFile')).enabled).toBe(false);
  await expect.poll(async () => (await state('edit.findInFiles')).enabled).toBe(false);
  await expect.poll(async () => (await state('view.diff.compact')).enabled).toBe(false);
  await expect.poll(async () => (await state('view.diff.aligned')).enabled).toBe(false);
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repository);
  const page = await openRepositoryWindow(application, () => action('file.open'));
  activePage = page;
  track(page); await focus(page);
  await expect(page.getByRole('button', { name: 'Project switcher', exact: true })).toContainText('menu-project');
  await expect.poll(async () => (await state('file.autoSave')).checked).toBe(false);
  await expect.poll(() => welcome.isClosed()).toBe(true);
  pass('Native Open creates a project window and closes the compact welcome screen, whose project/editor commands are disabled.');

  const menu = await application.evaluate(async ({ Menu, BrowserWindow }, windowId) => {
    const window = BrowserWindow.fromId(windowId!)!;
    window.show(); window.focus();
    await new Promise(resolve => setImmediate(resolve));
    const queue = [{ menu: Menu.getApplicationMenu()!, parent: '' }];
    const rows: unknown[] = [];
    for (let index = 0; index < queue.length; index++) {
      const { menu, parent } = queue[index];
      for (const item of menu.items) {
        rows.push({ id: item.id, parent, label: item.label, type: item.type, accelerator: item.accelerator, enabled: item.enabled });
        if (item.submenu) queue.push({ menu: item.submenu, parent: parent ? `${parent} > ${item.label}` : item.label });
      }
    }
    window.hide();
    return rows;
  }, activeWindowId);
  await writeFile(join(artifacts, 'native-menu.json'), JSON.stringify(menu, null, 2));
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const file = page.getByTestId('file-surface');
  const project = page.getByRole('tree', { name: 'Project files', exact: true });
  const openFile = async (path: string) => {
    await action('view.project');
    await project.getByRole('treeitem', { name: path, exact: true }).click();
    await expect(file).toHaveAttribute('data-path', path);
    await expect(file).toHaveAttribute('data-editable', 'true');
  };
  const edit = async (surface: Locator, text: string) => {
    await surface.locator('.view-lines').click({ position: { x: 80, y: 10 } });
    await page.keyboard.press(`${mod}+a`); await page.keyboard.insertText(text);
  };
  if (!['remaining', 'settings'].includes(process.env.SMART_DIFF_MENU_STAGE ?? '')) {
    await openFile('clean.ts');
    await edit(file, 'export const savedByMenu = true;\n');
    await action('file.save');
    await expect.poll(() => readFile(join(repository, 'clean.ts'), 'utf8')).toBe('export const savedByMenu = true;\n');
    await edit(file, 'export const savedTogether = true;\n');
    await openFile('other.ts');
    await edit(file, 'export const secondSave = true;\n');
    await action('file.saveAll');
    await expect.poll(() => readFile(join(repository, 'clean.ts'), 'utf8')).toBe('export const savedTogether = true;\n');
    await expect.poll(() => readFile(join(repository, 'other.ts'), 'utf8')).toBe('export const secondSave = true;\n');
    await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
    await edit(file, 'export const unsaved = true;\n');
    await action('file.closeTab');
    const unsaved = page.getByRole('dialog', { name: 'Save changes?', exact: true });
    await expect(unsaved).toBeVisible();
    await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(file).toHaveAttribute('data-path', 'other.ts');
    await action('file.closeTab');
    await unsaved.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'other.ts', exact: true })).toHaveCount(0);
    expect(await readFile(join(repository, 'other.ts'), 'utf8')).toBe('export const secondSave = true;\n');
    pass('Save and Save All write actual dirty files; Close Tab preserves the unsaved-change guard.');

    await openFile('clean.ts');
    await action('file.newFile');
    const newFile = page.getByRole('dialog', { name: 'New File', exact: true });
    await newFile.getByRole('textbox', { name: 'Name', exact: true }).fill('created.ts');
    await newFile.getByRole('button', { name: 'Create', exact: true }).click();
    await expect.poll(() => access(join(repository, 'created.ts')).then(() => true, () => false)).toBe(true);
    await expect(file).toHaveAttribute('data-path', 'created.ts');
    await action('file.rename');
    const rename = page.getByRole('dialog', { name: 'Rename', exact: true });
    await rename.getByRole('textbox', { name: 'Name', exact: true }).fill('renamed.ts');
    await rename.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(file).toHaveAttribute('data-path', 'renamed.ts');
    expect(await access(join(repository, 'created.ts')).then(() => true, () => false)).toBe(false);
    await action('file.newFolder');
    const newFolder = page.getByRole('dialog', { name: 'New Folder', exact: true });
    await newFolder.getByRole('textbox', { name: 'Name', exact: true }).fill('created-folder');
    await newFolder.getByRole('button', { name: 'Create', exact: true }).click();
    const directoryRow = project.getByRole('treeitem', { name: 'created-folder', exact: true });
    await expect(directoryRow).toBeVisible();
    await directoryRow.locator('.project-node-name').click();
    await action('file.newFile');
    await newFile.getByRole('textbox', { name: 'Name', exact: true }).fill('child.ts');
    await newFile.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(file).toHaveAttribute('data-path', 'created-folder/child.ts');
    expect(await access(join(repository, 'created-folder', 'child.ts')).then(() => true, () => false)).toBe(true);
    pass('New File / New Folder and Rename use real dialogs, update tabs/tree, and create inside the focused directory.');

    await openFile('clean.ts');
    await file.locator('.view-lines').click({ position: { x: 90, y: 10 } });
    await action('edit.find');
    await expect(file.locator('.find-widget')).toBeVisible();
    await page.keyboard.press('Escape');
    await action('edit.replace');
    await expect(file.getByRole('textbox', { name: 'Replace', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await file.locator('.view-lines').click({ position: { x: 90, y: 10 } });
    await action('code.commentLine');
    await expect(file.locator('.view-lines')).toContainText('//');
    await action('edit.undo');
    await expect(file.locator('.view-lines')).not.toContainText('//');
    await action('edit.redo');
    await expect(file.locator('.view-lines')).toContainText('//');
    await action('edit.undo');
    await expect(file.locator('.view-lines')).not.toContainText('//');
    await openFile('sample.ts');
    await file.locator('.view-lines').click({ position: { x: 90, y: 10 } });
    await action('navigate.line');
    const quickInput = page.locator('.quick-input-widget:visible');
    await expect(quickInput).toBeVisible();
    await quickInput.locator('input').fill(':90');
    await page.keyboard.press('Enter');
    await expect(quickInput).toHaveCount(0);
    await expect(file.locator('.view-lines')).toContainText('line90');
    await file.getByRole('textbox', { name: 'File contents: sample.ts', exact: true }).focus();
    await page.keyboard.press(`${mod}+Shift+f`);
    const search = page.getByRole('dialog', { name: 'Find in Files', exact: true });
    await expect(search).toBeVisible();
    await search.getByRole('searchbox', { name: 'Search text', exact: true }).fill('export const');
    await expect(search.getByRole('option').first()).toBeVisible();
    await capture(page, 'find-in-files.png');
    await search.getByRole('button', { name: 'Close Find in Files', exact: true }).click();
    pass('Find/Replace, line comments, Undo/Redo and Go to Line run real Monaco actions; Cmd/Ctrl+Shift+F opens project search while Monaco is focused.');
  }

  if (process.env.SMART_DIFF_MENU_STAGE !== 'settings') {
    await openFile('sample.ts');
    await action('window.splitRight');
    await expect(page.locator('.workspace-group')).toHaveCount(2);
    await expect(page.getByRole('separator', { name: 'Resize editor groups', exact: true })).toHaveAttribute('aria-orientation', 'vertical');
    await action('window.unsplit');
    await expect(page.locator('.workspace-group')).toHaveCount(1);
    await action('window.splitDown');
    await expect(page.getByRole('separator', { name: 'Resize editor groups', exact: true })).toHaveAttribute('aria-orientation', 'horizontal');
    await expect(page.getByTestId('file-surface')).toHaveCount(2);
    await expect(page.getByText('Loading file…', { exact: true })).toHaveCount(0);
    for (const surface of await page.getByTestId('file-surface').all()) await expect(surface.locator('.view-lines')).toContainText('line');
    await capture(page, 'split-editor.png');
    await action('window.unsplit');
    await action('view.commit');
    await expect(page.getByRole('tree', { name: 'Changed files', exact: true })).toBeVisible();
    await page.getByRole('treeitem', { name: 'sample.ts (working)', exact: true }).click();
    const viewer = page.locator('.smart-diff[data-status="ready"]');
    await expect(viewer).toBeVisible();
    await viewer.locator('[data-side="original"] .view-lines').click({ position: { x: 90, y: 10 } });
    await expect.poll(async () => (await state('code.commentLine')).enabled).toBe(false);
    await expect.poll(async () => (await state('edit.find')).enabled).toBe(true);
    await viewer.locator('[data-side="modified"] .view-lines').click({ position: { x: 90, y: 10 } });
    await expect.poll(async () => (await state('code.commentLine')).enabled).toBe(true);
    await action('view.diff.aligned');
    await expect(page.getByRole('button', { name: 'Layout', exact: true })).toContainText('Aligned');
    await expect.poll(async () => (await state('view.diff.aligned')).checked).toBe(true);
    await action('view.diff.compact');
    await expect(page.getByRole('button', { name: 'Layout', exact: true })).toContainText('Compact');
    const syncBefore = (await state('view.diff.sync')).checked;
    await action('view.diff.sync');
    await expect(page.getByRole('button', { name: 'Synchronize scrolling', exact: true })).toHaveAttribute('aria-pressed', String(!syncBefore));
    const wrapBefore = (await state('view.wrap')).checked;
    await action('view.wrap');
    await expect.poll(async () => (await state('view.wrap')).checked).toBe(!wrapBefore);
    const current = await page.getByTestId('change-count').textContent();
    await action('navigate.nextChange');
    await expect(page.getByTestId('change-count')).not.toHaveText(current!);
    await action('navigate.source');
    await expect(file).toHaveAttribute('data-path', 'sample.ts');
    await action('view.sidebar');
    await expect(page.locator('.project-panel:visible, .commit-panel:visible')).toHaveCount(0);
    await expect.poll(async () => (await state('view.project')).checked).toBe(false);
    await expect.poll(async () => (await state('view.commit')).checked).toBe(false);
    await action('view.project');
    await expect(project).toBeVisible();
    await expect.poll(async () => (await state('view.project')).checked).toBe(true);
    await action('view.project');
    await expect.poll(async () => (await state('view.project')).checked).toBe(true);
    pass('Split/unsplit, Project/Commit/sidebar, diff layout/sync/wrap, change navigation and Jump to Source target the active editor; mutation actions respect the focused read-only original pane.');
  }

  await action('app.settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('navigation', { name: 'Settings categories', exact: true }).getByRole('button', { name: 'Files', exact: true }).click();
  const automatic = settings.getByRole('checkbox', { name: 'Save changes automatically', exact: true });
  await expect(automatic).not.toBeChecked();
  await automatic.check();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await state('file.autoSave')).checked).toBe(true);
  await action('file.autoSave');
  await expect.poll(async () => (await state('file.autoSave')).checked).toBe(false);
  await action('app.settings');
  await settings.getByRole('navigation', { name: 'Settings categories', exact: true }).getByRole('button', { name: 'Files', exact: true }).click();
  await expect(automatic).not.toBeChecked();
  await capture(page, 'settings-files.png');
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  pass('Native Settings opens the existing preferences; Auto Save menu and Files preference stay synchronized.');

  await action('git.branches');
  const branches = page.getByRole('dialog', { name: 'Git branches and actions', exact: true });
  await expect(branches).toBeVisible();
  await page.keyboard.press('Escape');
  for (const [id, title] of [['git.newBranch', 'New Branch'], ['git.push', 'Push Branch'], ['git.update', 'Update Project']] as const) {
    await action(id);
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toBeVisible();
    if (id === 'git.push') await capture(page, 'push-review.png');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  pass('Git menu opens the real branch picker and New Branch / Push / Update review dialogs without executing operations.');

  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, secondRepository);
  const second = await openRepositoryWindow(application, () => action('file.open'));
  track(second); await focus(second);
  await expect(second.getByRole('button', { name: 'Project switcher', exact: true })).toContainText('second-project');
  await action('view.project');
  await second.getByRole('treeitem', { name: 'second.ts', exact: true }).click();
  await expect(second.getByTestId('file-surface')).toHaveAttribute('data-path', 'second.ts');
  await action('file.closeAllTabs');
  await expect(second.getByRole('tab')).toHaveCount(0);
  await expect.poll(async () => (await state('file.closeTab')).enabled).toBe(false);
  await expect(page.getByRole('tab')).not.toHaveCount(0);
  await focus(page);
  await expect.poll(async () => (await state('file.closeTab')).enabled).toBe(true);
  await action('app.settings');
  await expect(settings).toBeVisible();
  await expect(second.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  pass('Opening another repository preserves the original tabs; menu actions and enabled state follow the focused window.');

  expect((await git('rev-parse', 'HEAD')).stdout.trim()).toBe(head);
  expect((await git('diff', '--cached')).stdout).toBe('');
  expect(errors).toEqual([]);
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ stage: process.env.SMART_DIFF_MENU_STAGE ?? 'all', checks, rendererErrors: errors, screenshots,
    note: 'Native Menu callbacks and real Electron accelerators were exercised in temporary windows; captures show command effects, not the macOS global menu.' }, null, 2));
  console.log(`PASS: ${checks.length} production menu checks. Artifacts: ${artifacts}`);
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await capture(activePage, 'failure.png').catch(() => {});
    const windows = await application.evaluate(({ BrowserWindow }) => ({ focused: BrowserWindow.getFocusedWindow()?.id,
      windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, focused: window.isFocused(), visible: window.isVisible(), title: window.getTitle() })) })).catch(() => null);
    const saving = await activePage.evaluate(() => localStorage.getItem('smart-diff:file-saving:v1')).catch(() => null);
    const saved = await readFile(join(repository, 'clean.ts'), 'utf8').catch(() => null);
    await writeFile(join(artifacts, 'failure.txt'), `${String(error)}\n${JSON.stringify({ windows, saving, saved })}\n\n${await activePage.locator('body').innerText().catch(() => '')}`).catch(() => {});
  }
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
