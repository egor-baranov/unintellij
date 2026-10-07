/** End-to-end production Electron check. Uses an isolated temporary Git repository. */
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pngBefore, pngAfter, passiveSvg, sampleAudio, sampleVideo } from '../apps/playground/src/media-fixtures';
const run = promisify(execFile);
// Each comparison checks Git status before and after reading its endpoints.
// Allow real subprocess/filesystem work the same bound as our browser suite.
const expect = baseExpect.configure({ timeout: 10000 });
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-desktop-smoke-'));
const repository = join(directory, 'repository');
await mkdir(repository);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
await git('init', '-q', '-b', 'main');
await writeFile(join(repository, 'example.ts'), 'export const value = 1;\n');
await writeFile(join(repository, 'preview.png'), Buffer.from(pngBefore.base64, 'base64'));
await mkdir(join(repository, 'src'));
await writeFile(join(repository, 'src', 'unchanged.ts'), 'export const unchanged = "project file";\n');
await git('add', '--', 'example.ts', 'src/unchanged.ts', 'preview.png');
await git('-c', 'user.name=Smoke Test', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'Temporary test fixture');
await git('branch', 'feature/smoke');
await writeFile(join(repository, 'example.ts'), 'export const value = 2;\n');
await git('add', '--', 'example.ts');
await writeFile(join(repository, 'example.ts'), 'export const value = 3;\n');
await writeFile(join(repository, 'untracked café.ts'), 'export const greeting = "hello";\n');
await writeFile(join(repository, 'staged-new.ts'), 'export const stagedAddition = true;\n');
await git('add', '--', 'staged-new.ts');
const executablePath = process.env.SMART_DIFF_PACKAGED_EXECUTABLE;
await mkdir(join(directory, 'profile'), { recursive: true });
const application = await electron.launch({
  ...(executablePath ? { executablePath, args: [`--user-data-dir=${join(directory, 'profile')}`] } : { args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${join(directory, 'profile')}`] }),
  env: { ...process.env, SMART_DIFF_DEV_URL: process.env.SMART_DIFF_SMOKE_DEV_URL ?? '' },
});
try {
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repository);
  let page = await application.firstWindow();
  const welcome = page;
  // Keep automation isolated from physical desktop input and avoid stealing
  // focus. Chromium continues painting so screenshots/workers remain exercised.
  await hideWindow(application, page);
  const capture = async (path: string) => { await writeFile(path, await captureWindow(application, page)); };
  const errors: string[] = []; page.on('pageerror', error => { errors.push(error.message); console.error('Renderer error:', error.stack ?? error.message); });
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByRole('main', { name: 'Welcome', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Workspace view', exact: true })).toHaveCount(0);
  await expect(page.locator('.commit-panel, .editor-workspace')).toHaveCount(0);
  page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.on('pageerror', error => { errors.push(error.message); console.error('Renderer error:', error.stack ?? error.message); });
  await expect.poll(() => welcome.isClosed()).toBe(true);
  const workspaceButtons = page.getByRole('group', { name: 'Workspace view', exact: true });
  await expect(workspaceButtons.getByRole('button', { name: 'Project', exact: true })).toHaveText('');
  await expect(workspaceButtons.getByRole('button', { name: 'Commit', exact: true })).toHaveText('');
  if (process.platform === 'darwin') {
    await expect(page.locator('html')).toHaveAttribute('data-window-chrome', 'macos');
    const windowHandle = await application.browserWindow(page);
    const chrome = await windowHandle.evaluate(window => {
      return { controls: window.getWindowButtonPosition(), frame: window.getBounds(), content: window.getContentBounds() };
    });
    await windowHandle.dispose();
    expect(chrome.controls).toEqual({ x: 12, y: 14 });
    expect(Math.abs(chrome.frame.height - chrome.content.height)).toBeLessThanOrEqual(1);
    const toolbar = await page.locator('.desktop-topbar').evaluate(node => ({
      top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height,
      drag: getComputedStyle(node).getPropertyValue('-webkit-app-region'),
      buttons: [...node.querySelectorAll('button')].map(button => ({ x: button.getBoundingClientRect().left, region: getComputedStyle(button).getPropertyValue('-webkit-app-region') })),
    }));
    expect(toolbar.top).toBe(0); expect(toolbar.height).toBe(42);
    expect(toolbar.drag).toBe('drag');
    expect(toolbar.buttons.every(button => button.x >= 86 && button.region === 'no-drag')).toBe(true);
  }
  await expect(page.getByRole('treeitem', { name: 'Changes', exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Staged', exact: true })).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: 'Unstaged', exact: true })).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: 'example.ts (working)', exact: true })).toHaveCount(1);
  await expect(page.getByRole('treeitem', { name: 'Untracked', exact: true })).toBeVisible();
  await page.getByRole('treeitem', { name: 'example.ts (working)', exact: true }).click();
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await expect(page.locator('.workspace-tab-content')).toHaveAttribute('data-original-label', 'HEAD');
  await expect(page.locator('.workspace-tab-content')).toHaveAttribute('data-modified-label', 'Working tree');
  await expect(page.locator('.source-headers')).toHaveCount(0);
  await expect(page.locator('[data-side="original"] .view-lines')).toContainText(/value\s*=\s*1/);
  await expect(page.locator('[data-side="modified"] .view-lines')).toContainText(/value\s*=\s*3/);
  const divider = page.getByRole('separator', { name: 'Resize diff panes', exact: true });
  await divider.focus(); await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '52');
  expect(await page.locator('[data-side="original"]').evaluate(node => node.clientWidth)).toBeGreaterThan(await page.locator('[data-side="modified"]').evaluate(node => node.clientWidth));
  await page.getByRole('treeitem', { name: 'example.ts (working)', exact: true }).click();
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await expect(page.locator('.workspace-tab-content')).toHaveAttribute('data-original-label', 'HEAD');
  await expect(page.locator('.workspace-tab-content')).toHaveAttribute('data-modified-label', 'Working tree');
  await expect(page.locator('.source-headers')).toHaveCount(0);
  await expect(page.locator('[data-side="original"] .view-lines')).toContainText(/value\s*=\s*1/);
  await expect(page.locator('[data-side="modified"] .view-lines')).toContainText(/value\s*=\s*3/);
  await page.getByRole('treeitem', { name: 'staged-new.ts (working)', exact: true }).click();
  await expect(page.locator('[data-added="true"] .view-lines')).toContainText('stagedAddition');
  await expect(page.locator('.source-headers')).toHaveCount(0);
  await expect(page.getByTestId('file-surface')).toHaveAttribute('data-path', 'staged-new.ts');
  await expect(page.getByTestId('file-surface')).toHaveAttribute('data-editable', 'true');
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await expect(page.locator('.smart-diff')).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'untracked café.ts (untracked)', exact: true }).click();
  await expect(page.locator('[data-added="true"] .view-lines')).toContainText('greeting');
  await expect(page.locator('.source-headers')).toHaveCount(0);
  await expect(page.getByTestId('file-surface')).toHaveAttribute('data-path', 'untracked café.ts');
  await expect(page.locator('.smart-diff-gutter')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Include untracked café.ts in review', exact: true }).check();
  await page.getByLabel('Commit message (local draft)', { exact: true }).fill('Review the greeting change');
  await page.locator('.commit-panel').getByRole('button', { name: 'Commit', exact: true }).click();
  const commitDialog = page.getByRole('dialog', { name: 'Commit Selected Changes' });
  await expect(commitDialog.getByRole('textbox', { name: 'Commit message', exact: true })).toHaveValue('Review the greeting change');
  await expect(commitDialog).toContainText('1 selected');
  await commitDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  // A no-op refresh preserves opaque change IDs and local checked state.
  const beforeRefreshId = await page.getByRole('treeitem', { name: 'untracked café.ts (untracked)', exact: true }).getAttribute('data-file-id');
  await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await expect.poll(() => page.getByRole('treeitem', { name: 'untracked café.ts (untracked)', exact: true }).getAttribute('data-file-id')).toBe(beforeRefreshId);
  await expect(page.locator('[data-added="true"] .view-lines')).toContainText('greeting');
  await expect(page.getByRole('checkbox', { name: 'Include untracked café.ts in review', exact: true })).toBeChecked();
  await expect(page.getByLabel('Commit message (local draft)', { exact: true })).toHaveValue('Review the greeting change');
  expect(await page.evaluate(() => typeof Reflect.get(window, 'require'))).toBe('undefined');
  const bridgeKeys = await page.evaluate(() => Object.keys(window.desktop).sort());
  expect(bridgeKeys).toEqual(['activateRepository', 'cancelFileSearch', 'chooseRepository', 'chooseSearchDirectory', 'compareBranches', 'copyFilePath', 'getFileActions', 'getLastRepository', 'getProjectTreePreferences', 'getTreeActions', 'getWindowSessionId', 'listBranches', 'listChanges', 'listOpenRepositories', 'listProjectDirectory', 'listRecentProjects', 'markProjectDirectory', 'openFileIn', 'openRecentProject', 'performNativeEdit', 'performTreeAction', 'readBranchComparison', 'readComparison', 'readProjectFile', 'refreshRepository', 'runBranchOperation', 'saveText', 'setProjectTreePreferences', 'startFileSearch', 'subscribeToApplicationActions', 'subscribeToFileSearch', 'subscribeToOpenRepositories', 'subscribeToRepositoryChanges', 'updateApplicationMenuState']);
  await expect(page.evaluate(() => window.desktop.listBranches('../outside'))).rejects.toThrow();
  await expect(page.evaluate(() => window.desktop.activateRepository('../outside'))).rejects.toThrow();
  await expect(page.evaluate(() => window.desktop.readComparison('../outside', '../../etc/passwd'))).rejects.toThrow();
  await expect(page.evaluate(() => window.desktop.listProjectDirectory('../outside', null))).rejects.toThrow();
  // Exercise real branch capabilities without changing the staged/working contents.
  const branchTrigger = page.getByRole('button', { name: 'Git branches', exact: true });
  await expect(branchTrigger).toContainText('main');
  await branchTrigger.click();
  const branchSearch = page.getByPlaceholder('Search for branches and actions');
  await branchSearch.fill('feature/smoke');
  await page.getByRole('menuitem', { name: 'feature/smoke', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Checkout', exact: true }).click();
  await page.getByRole('dialog', { name: 'Checkout Branch' }).getByRole('button', { name: 'Checkout', exact: true }).click();
  await expect(branchTrigger).toContainText('feature/smoke');
  expect((await git('branch', '--show-current')).stdout.trim()).toBe('feature/smoke');
  await branchSearch.fill('main');
  await page.getByRole('menuitem', { name: 'main', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Show Diff with Working Tree', exact: true }).click();
  const branchComparison = page.getByRole('region', { name: 'Branch comparison', exact: true });
  await branchComparison.getByRole('button', { name: 'example.ts', exact: true }).click();
  await expect(branchComparison.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await expect(branchComparison.locator('[data-side="original"] .view-lines')).toContainText(/value\s*=\s*1/);
  await expect(branchComparison.locator('[data-side="modified"] .view-lines')).toContainText(/value\s*=\s*3/);
  await branchComparison.getByRole('button', { name: 'Close branch comparison', exact: true }).click();
  await branchTrigger.click(); await branchSearch.fill('main');
  await page.getByRole('menuitem', { name: 'main', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Checkout', exact: true }).click();
  await page.getByRole('dialog', { name: 'Checkout Branch' }).getByRole('button', { name: 'Checkout', exact: true }).click();
  await expect(branchTrigger).toContainText('main');
  await page.keyboard.press('Escape');
  expect((await git('diff', '--cached', '--name-only')).stdout.trim().split('\n').sort()).toEqual(['example.ts', 'staged-new.ts']);
  // Project browsing includes unchanged files, and switching back restores the
  // selected comparison and local review state rather than replacing either.
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Project files' })).toBeVisible();
  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  await page.getByRole('treeitem', { name: 'src/unchanged.ts', exact: true }).click();
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toContainText('project file');
  await expect(page.locator('.source-headers')).toHaveCount(0);
  await expect(page.getByTestId('file-surface')).toHaveAttribute('data-path', 'src/unchanged.ts');
  await expect(page.getByRole('treeitem', { name: 'src/unchanged.ts', exact: true }).locator('[data-icon="file-ts"]')).toBeVisible();
  await expect.poll(() => page.locator('img.jb-icon').evaluateAll(nodes => nodes.filter(node => {
    const image = node as HTMLImageElement;
    return !image.complete || image.naturalWidth === 0 || new URL(image.currentSrc).protocol !== location.protocol;
  }).length)).toBe(0);
  const projectSurface = page.getByTestId('file-surface');
  const projectLines = projectSurface.locator('.view-lines');
  const initialProjectText = await projectLines.textContent();
  const projectDirty = page.getByRole('tab', { name: 'src/unchanged.ts', exact: true }).getByRole('img', { name: 'Unsaved changes', exact: true });
  await expect(projectSurface).toHaveAttribute('data-editable', 'true');
  // Clicking the visible code targets Monaco's EditContext in Electron; focusing
  // its fallback textarea alone does not deliver ordinary editor keyboard input.
  await projectLines.click({ position: { x: 80, y: 10 } });
  await page.keyboard.type('draft');
  await expect(projectLines).toContainText('draft');
  await expect(projectDirty).toBeVisible();
  for (let step = 0; step < 8 && await projectDirty.count(); step++) {
    const previous = await projectLines.textContent();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => projectLines.textContent()).not.toBe(previous);
  }
  await expect(projectDirty).toHaveCount(0);
  expect(await projectLines.textContent()).toBe(initialProjectText);
  expect(await readFile(join(repository, 'src', 'unchanged.ts'), 'utf8')).toBe('export const unchanged = "project file";\n');
  await writeFile(join(repository, 'src', 'unchanged.ts'), 'export const unchanged = "refreshed project file";\n');
  await page.getByRole('button', { name: 'Refresh project', exact: true }).click();
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toContainText('refreshed project file');
  await mkdir('artifacts', { recursive: true });
  await capture('artifacts/desktop-project-production.png');
  // Appearance is shared by ordinary editors and diffs, persisted on the local
  // app origin, and its scheme downloads must work without a dev server.
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true });
  await settingsButton.click();
  const settingsDialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  // The options must be renderer DOM inside the modal, not a native macOS menu.
  const themeSelect = settingsDialog.getByRole('combobox', { name: 'Theme preset', exact: true });
  await expect(settingsDialog.locator('select, datalist')).toHaveCount(0);
  await themeSelect.click();
  await expect(settingsDialog.getByRole('listbox', { name: 'Theme preset', exact: true })).toBeVisible();
  await expect(settingsDialog.getByRole('option', { name: 'Reference', exact: true })).toHaveAttribute('aria-selected', 'true');
  await mkdir('artifacts/settings', { recursive: true });
  await capture('artifacts/settings/dropdown-electron-production.png');
  await page.keyboard.press('Escape');
  await expect(settingsDialog).toBeVisible();
  await expect(themeSelect).toBeFocused();
  const settingsCategory = (name: string) => settingsDialog.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name, exact: true }).click();
  await settingsCategory('Editor Font');
  await settingsDialog.getByRole('spinbutton', { name: 'Editor font size', exact: true }).fill('20');
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toHaveCSS('font-size', '20px');
  await settingsDialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await settingsDialog.getByRole('spinbutton', { name: 'Editor font size', exact: true }).fill('12');
  await settingsDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toHaveCSS('font-size', '20px');
  await settingsButton.click();
  await settingsCategory('Schemes');
  const schemePath = join(directory, 'appearance-export.json');
  const downloadWindow = await application.browserWindow(page);
  await downloadWindow.evaluate((window, path) => {
    window.webContents.session.once('will-download', (_event: unknown, item: import('electron').DownloadItem) => item.setSavePath(path));
  }, schemePath);
  await downloadWindow.dispose();
  await settingsDialog.getByRole('button', { name: 'unintellij JSON', exact: true }).click();
  await expect.poll(async () => {
    try { return JSON.parse(await readFile(schemePath, 'utf8')).editor.fontSize; } catch { return null; }
  }).toBe(20);
  await settingsDialog.getByRole('button', { name: 'Restore defaults', exact: true }).click();
  const importedScheme = JSON.parse(await readFile(schemePath, 'utf8'));
  await settingsDialog.getByLabel('Import scheme file').setInputFiles({ name: 'appearance.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedScheme)) });
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toHaveCSS('font-size', '20px');
  await capture('artifacts/desktop-settings-production.png');
  await settingsDialog.getByRole('button', { name: 'Restore defaults', exact: true }).click();
  await settingsDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toHaveCSS('font-size', '16px');
  await page.getByRole('group', { name: 'Workspace view' }).getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.locator('[data-added="true"] .view-lines')).toContainText('greeting');
  await expect(page.getByRole('checkbox', { name: 'Include untracked café.ts in review', exact: true })).toBeChecked();
  await expect(page.getByLabel('Commit message (local draft)', { exact: true })).toHaveValue('Review the greeting change');
  // Files and comparisons remain open independently. Split instances load their
  // own contents; opening a file affects only the group most recently focused.
  const firstGroup = page.getByRole('region', { name: 'Editor group 1', exact: true });
  const secondGroup = page.getByRole('region', { name: 'Editor group 2', exact: true });
  await expect(firstGroup.getByRole('tab', { name: 'src/unchanged.ts', exact: true })).toBeVisible();
  await expect(firstGroup.getByRole('tab', { name: 'Commit: example.ts — working', exact: true })).toHaveCount(1);
  await firstGroup.getByRole('button', { name: 'Editor group 1 options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Split right', exact: true }).click();
  await expect(secondGroup.locator('[data-added="true"] .view-lines')).toContainText('greeting');
  const firstInstance = await firstGroup.getByRole('tab', { selected: true }).getAttribute('data-instance-id');
  expect(await secondGroup.getByRole('tab', { selected: true }).getAttribute('data-instance-id')).not.toBe(firstInstance);
  await page.getByRole('group', { name: 'Workspace view' }).getByRole('button', { name: 'Project', exact: true }).click();
  await expect(secondGroup.getByTestId('file-surface').locator('.view-lines')).toContainText('refreshed project file');
  await page.getByRole('treeitem', { name: 'example.ts', exact: true }).click();
  await expect(secondGroup.getByTestId('file-surface').locator('.view-lines')).toContainText(/value\s*=\s*3/);
  await expect(secondGroup.getByRole('tab')).toHaveCount(3);
  await expect(firstGroup.locator('[data-added="true"] .view-lines')).toContainText('greeting');
  const groupDivider = page.getByRole('separator', { name: 'Resize editor groups', exact: true });
  const beforeWidth = await firstGroup.evaluate(node => node.getBoundingClientRect().width);
  await groupDivider.focus(); await page.keyboard.press('ArrowRight');
  await expect(groupDivider).toHaveAttribute('aria-valuenow', '52');
  expect(await firstGroup.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(beforeWidth);
  await secondGroup.getByTestId('file-surface').locator('.view-lines').click({ position: { x: 80, y: 10 } });
  await page.keyboard.press('ControlOrMeta+b');
  for (const name of ['Project', 'Commit']) {
    await expect(workspaceButtons.getByRole('button', { name, exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(workspaceButtons.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'false');
  }
  await expect(page.getByRole('tree', { name: 'Project files' })).toBeHidden();
  await expect(page.getByRole('separator', { name: 'Resize file sidebar', exact: true })).toBeHidden();
  await workspaceButtons.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(workspaceButtons.getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(workspaceButtons.getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Workspace view' }).getByRole('button', { name: 'Commit', exact: true }).click();
  await page.getByRole('treeitem', { name: 'example.ts (working)', exact: true }).click();
  await expect(secondGroup.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await expect(secondGroup.locator('.workspace-tab-content')).toHaveAttribute('data-original-label', 'HEAD');
  await expect(secondGroup.locator('.workspace-tab-content')).toHaveAttribute('data-modified-label', 'Working tree');
  await expect(secondGroup.locator('.source-headers')).toHaveCount(0);
  await expect(secondGroup.locator('[data-side="original"] .view-lines')).toContainText(/value\s*=\s*1/);
  await expect(firstGroup.locator('[data-added="true"] .view-lines')).toContainText('greeting');
  await capture('artifacts/desktop-workspace-production.png');
  await page.getByRole('treeitem', { name: 'untracked café.ts (untracked)', exact: true }).click();
  await secondGroup.getByRole('button', { name: 'Editor group 2 options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Unsplit', exact: true }).click();
  await expect(secondGroup).toHaveCount(0);
  await expect(firstGroup.locator('[data-added="true"] .view-lines')).toContainText('greeting');
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  // The project menu creates another window. Activating an open repository
  // focuses its original workspace and preserves both repositories and watchers.
  const secondRepository = join(directory, 'second-project');
  await mkdir(secondRepository);
  await run('git', ['-C', secondRepository, 'init', '-q'], { shell: false });
  await writeFile(join(secondRepository, 'second.ts'), 'export const secondProject = true;\n');
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, secondRepository);
  const projectPicker = page.getByRole('button', { name: 'Project switcher', exact: true });
  await projectPicker.click();
  const secondPage = await openRepositoryWindow(application, () => page.getByRole('menuitem', { name: 'Open…', exact: true }).click());
  secondPage.on('pageerror', error => { errors.push(error.message); console.error('Renderer error:', error.stack ?? error.message); });
  const secondPicker = secondPage.getByRole('button', { name: 'Project switcher', exact: true });
  await expect(secondPicker).toContainText('second-project');
  await expect(secondPage.locator('[data-added="true"] .view-lines')).toContainText('secondProject');
  await expect(projectPicker).toContainText('repository');
  await secondPicker.click();
  await expect(secondPage.getByRole('menu', { name: 'Project switcher' }).getByText('Open Projects', { exact: true })).toBeVisible();
  await secondPage.getByRole('menuitem', { name: 'repository', exact: true }).click();
  await hideWindow(application, page);
  await expect(secondPicker).toContainText('second-project');
  await expect(projectPicker).toContainText('repository');
  expect(application.windows()).toHaveLength(2);
  await expect(page.getByRole('dialog', { name: 'Commit Staged Changes' })).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'example.ts (working)', exact: true }).click();
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await expect(page.locator('[data-side="modified"] .view-lines')).toContainText(/value\s*=\s*3/);
  await expect(page.getByLabel('Commit message (local draft)', { exact: true })).toHaveValue('Review the greeting change');
  const expectedRepositories = (await Promise.all([realpath(repository), realpath(secondRepository)])).sort();
  await expect.poll(async () => (JSON.parse(await readFile(join(directory, 'profile', 'workspace.json'), 'utf8')).windows as Array<{ path: string }>).map(window => window.path).sort()).toEqual(expectedRepositories);
  await writeFile(join(repository, 'switched-watcher.ts'), 'export const watching = true;\n');
  await expect(page.getByRole('treeitem', { name: 'switched-watcher.ts (untracked)', exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByRole('treeitem', { name: 'example.ts (working)', exact: true }).click();
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await expect(divider).toHaveAttribute('aria-valuenow', '52');
  expect(await page.evaluate(() => location.protocol)).toBe(process.env.SMART_DIFF_SMOKE_DEV_URL ? 'http:' : 'app:');
  await expect.poll(() => page.workers().filter(worker => /worker.*\.js/.test(worker.url())).length).toBeGreaterThan(0);
  const localAccess = await page.evaluate(async () => { try { await fetch('file:///etc/hosts'); return true; } catch { return false; } });
  expect(localAccess).toBe(false);
  const externalAccess = await page.evaluate(async () => { try { await fetch('https://example.com/'); return true; } catch { return false; } });
  expect(externalAccess).toBe(false);
  expect(await page.evaluate(() => window.open('https://example.com/') === null)).toBe(true);
  if (!process.env.SMART_DIFF_SMOKE_DEV_URL) {
    expect(await page.evaluate(async () => {
      const response = await fetch(new URL('licenses/jetbrains-icons-APACHE-2.0.txt', location.href));
      return response.ok && (await response.text()).includes('Apache License');
    })).toBe(true);
    for (const path of ['app://smart-diff/../../etc/hosts', 'app://smart-diff/%2e%2e%2f%2e%2e%2fetc/hosts', 'app://smart-diff/assets/../../index.cjs']) {
      expect(await page.evaluate(async url => (await fetch(url)).status, path)).toBe(404);
    }
  }
  await mkdir('artifacts', { recursive: true });
  await capture('artifacts/desktop-production.png');
  // Media travels through the same bounded Git/Project bridge in the packaged
  // app. These are real HEAD/working-tree bytes, never renderer file URLs.
  await writeFile(join(repository, 'preview.png'), Buffer.from(pngAfter.base64, 'base64'));
  await git('add', '--', 'preview.png');
  await writeFile(join(repository, 'new-preview.png'), Buffer.from(pngBefore.base64, 'base64'));
  await git('add', '--', 'new-preview.png');
  await writeFile(join(repository, 'new-preview.png'), Buffer.from(pngAfter.base64, 'base64'));
  await writeFile(join(repository, 'preview.svg'), Buffer.from(passiveSvg.base64, 'base64'));
  await writeFile(join(repository, 'preview.wav'), Buffer.from(sampleAudio.base64, 'base64'));
  await writeFile(join(repository, 'preview.webm'), Buffer.from(sampleVideo.base64, 'base64'));
  await expect(page.getByRole('treeitem', { name: 'preview.png (working)', exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByRole('treeitem', { name: 'preview.png (working)', exact: true }).click();
  const media = page.getByTestId('media-surface');
  await expect(media).toHaveAttribute('data-comparison', 'true');
  await expect(media.getByRole('img')).toHaveCount(2);
  await expect.poll(() => media.getByRole('img').evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).naturalWidth))).toEqual([480, 480]);
  await expect(media.locator('.media-source-label')).toHaveText(['HEAD', 'Working tree']);
  const pixels = await media.getByRole('img').evaluateAll(nodes => nodes.map(node => {
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 280;
    const context = canvas.getContext('2d')!; context.drawImage(node as HTMLImageElement, 0, 0);
    return [...context.getImageData(100, 160, 1, 1).data];
  }));
  expect(pixels).toEqual([[185, 136, 79, 255], [87, 171, 132, 255]]);
  await capture('artifacts/desktop-media-production.png');
  await page.getByRole('treeitem', { name: 'new-preview.png (working)', exact: true }).click();
  await expect(media).toHaveAttribute('data-comparison', 'false');
  await expect(media.getByRole('img')).toHaveCount(1);
  await expect.poll(() => media.getByRole('img').evaluate(node => {
    const image = node as HTMLImageElement;
    if (!image.complete || !image.naturalWidth) return [];
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 280;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return [...context.getImageData(100, 160, 1, 1).data];
  })).toEqual([87, 171, 132, 255]);
  await workspaceButtons.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('treeitem', { name: 'preview.png', exact: true }).click();
  await expect(media).toHaveAttribute('data-path', 'preview.png');
  await expect.poll(() => media.getByRole('img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(480);
  await expect(media.getByRole('img')).toHaveAttribute('src', /^blob:/);
  await page.getByRole('treeitem', { name: 'preview.svg', exact: true }).click();
  await expect.poll(() => media.getByRole('img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(320);
  await expect(media.locator('object,embed,iframe')).toHaveCount(0);
  for (const [path, tag] of [['preview.wav', 'audio'], ['preview.webm', 'video']]) {
    await page.getByRole('treeitem', { name: path, exact: true }).click();
    const player = media.locator(tag);
    await expect.poll(() => player.evaluate(node => (node as HTMLMediaElement).readyState)).toBeGreaterThanOrEqual(1);
    expect(await player.evaluate(node => { const element = node as HTMLMediaElement; return element.paused && !element.autoplay && element.controls && element.currentSrc.startsWith('blob:'); })).toBe(true);
  }
  const rendererUrl = page.url();
  await page.evaluate(() => { location.href = 'https://example.com/'; });
  await page.waitForTimeout(100);
  expect(page.url()).toBe(rendererUrl);
  expect(application.windows()).toHaveLength(2);
  expect(errors).toEqual([]);
  await mkdir('artifacts', { recursive: true });
  console.log(`PASS: ${process.env.SMART_DIFF_SMOKE_DEV_URL ? 'development' : executablePath ? 'packaged' : 'production'} Electron renderer, unified HEAD/working comparisons, image/SVG/audio/video previews, HEAD/working image pixels, Settings preview/save/scheme import-export, branch checkout/comparison/commit review, editor tabs/splits/sidebar, draggable panes, staged/untracked added-file editors, Git comparisons, Project files, independent repository windows/watchers, Monaco/diff workers, IPC rejection`);
} finally {
  // A failed editable-file assertion may leave a draft. Test teardown must not
  // wait on the application's unsaved-changes confirmation.
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close();
  await rm(directory, { recursive: true, force: true });
}
