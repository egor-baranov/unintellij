/** Production Electron context menus, real OS discovery, and capability checks.
 * Only Finder/File Explorer reveal is invoked, through a main-process stub.
 * Launching installed applications is covered by the backend adapter tests. */
import { _electron as electron, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const expect = baseExpect.configure({ timeout: 15000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-context-menu-smoke-'));
const repository = join(directory, 'repository');
const samplePath = 'sample café.txt';
const deletedPath = 'deleted.txt';
const artifactDirectory = resolve('artifacts/context-menus');
await mkdir(repository);
await mkdir(artifactDirectory, { recursive: true });
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
await git('init', '-q', '-b', 'main');
await writeFile(join(repository, samplePath), 'Original text.\nShared context.\n');
await writeFile(join(repository, deletedPath), 'This tracked file will be removed.\n');
await git('add', '.');
await git('-c', 'user.name=Smoke Test', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'Temporary context-menu fixture');
await writeFile(join(repository, samplePath), 'Updated text.\nShared context.\n');
await rm(join(repository, deletedPath));
const canonicalRepository = await realpath(repository);
const absoluteSamplePath = join(canonicalRepository, samplePath);
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
  await writeFile(join(artifactDirectory, name), await captureWindow(application, page));
};
try {
  await application.evaluate(({ clipboard, dialog, shell }, path) => {
    // Keep the clipboard snapshot in the main process, including NativeImage;
    // never serialize the user's clipboard contents into test output.
    const formats = new Set(clipboard.availableFormats());
    const text = clipboard.readText(), html = clipboard.readHTML(), rtf = clipboard.readRTF(), image = clipboard.readImage();
    const contents: import('electron').Data = {};
    if (text || formats.has('text/plain')) contents.text = text;
    if (html || formats.has('text/html')) contents.html = html;
    if (rtf || formats.has('text/rtf')) contents.rtf = rtf;
    if (!image.isEmpty()) contents.image = image;
    Reflect.set(globalThis, 'smokeContextClipboard', contents);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    Reflect.set(globalThis, 'smokeContextReveals', []);
    shell.showItemInFolder = filePath => { (Reflect.get(globalThis, 'smokeContextReveals') as string[]).push(filePath); };
    shell.openPath = async () => { throw new Error('The context-menu smoke never launches the default application.'); };
  }, repository);
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  repositoryPage = page;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
  expect(page.url()).toBe('app://smart-diff/index.html');
  const menu = page.getByRole('menu', { name: 'File actions', exact: true });
  const menuItem = (name: string) => menu.getByRole('menuitem', { name, exact: true });
  const submenu = page.getByRole('menu', { name: 'Open In', exact: true });
  const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText());
  const openMenu = async (target: Locator) => {
    await target.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(menuItem('Copy Path')).toBeEnabled();
  };
  const copy = async (target: Locator, action: 'Copy Path' | 'Copy Relative Path', expected: string) => {
    await openMenu(target); await menuItem(action).click();
    await expect.poll(clipboard).toBe(expected);
    await expect(menu).toHaveCount(0);
  };

  const changedRow = page.getByRole('treeitem', { name: `${samplePath} (working)`, exact: true });
  await changedRow.click();
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  const diffTab = page.getByRole('tab', { name: `Commit: ${samplePath} — working`, exact: true });
  await expect(diffTab).toHaveAttribute('aria-selected', 'true');
  // Tab document IDs contain the issued repository ID; obtaining it here does
  // not re-register/refresh the repository or invalidate the selected changes.
  const documentId = await diffTab.getAttribute('data-document-id');
  const repositoryId = (JSON.parse(documentId!) as string[])[0];
  const snapshot = await page.evaluate(id => window.desktop.listChanges(id), repositoryId);
  const change = snapshot.workingChanges!.find(value => value.path === samplePath)!;
  const target = { kind: 'change' as const, id: change.id };
  const info = await page.evaluate(({ id, target }) => window.desktop.getFileActions(id, target), { id: repositoryId, target });
  expect(info.path).toBe(samplePath); expect(info.absolutePath).toBe(absoluteSamplePath);
  expect(info.source).toMatchObject({ path: samplePath, kind: 'file' });
  const fileManagerName = process.platform === 'darwin' ? 'Finder' : process.platform === 'win32' ? 'File Explorer' : 'File manager';
  expect(info.applications.some(value => value.name === fileManagerName)).toBe(true);
  expect(info.applications.some(value => value.isDefault)).toBe(true);
  if (process.platform === 'darwin') {
    // A .txt file should have actual registered handlers on macOS. The fallback
    // alone would hide a failing NSWorkspace discovery implementation.
    expect(info.applications.filter(value => value.name !== 'Finder' && value.name !== 'Default application').length).toBeGreaterThan(0);
    expect(info.applications.every(value => /^data:image\/png;base64,/.test(value.icon ?? ''))).toBe(true);
    // Nonempty data alone is insufficient: Electron can return the same generic
    // document glyph for every .app directory, including Finder.
    expect(new Set(info.applications.map(value => value.icon)).size).toBeGreaterThan(1);
    const decoded = await application.evaluate(({ nativeImage }, icons) => icons.map(icon => {
      const image = nativeImage.createFromDataURL(icon);
      return { empty: image.isEmpty(), ...image.getSize() };
    }), info.applications.map(value => value.icon!));
    expect(decoded.every(icon => !icon.empty && icon.width > 0 && icon.height > 0)).toBe(true);
  }
  expect(await application.evaluate(() => Reflect.get(globalThis, 'smokeContextReveals'))).toEqual([]);
  console.log(`PASS: actual ${process.platform} file handlers: ${info.applications.map(value => value.name).join(', ')}; discovery did not launch anything.`);

  await copy(diffTab, 'Copy Path', absoluteSamplePath);
  await copy(diffTab, 'Copy Relative Path', samplePath);
  await copy(changedRow, 'Copy Relative Path', samplePath);
  await openMenu(diffTab);
  await expect(menuItem('Jump to Source')).toBeEnabled();
  await capture('electron-file-actions.png');
  await menuItem('Open In').click();
  await expect(submenu).toBeVisible();
  for (const application of info.applications) await expect(submenu.getByRole('menuitem', { name: application.name, exact: true })).toBeEnabled();
  if (process.platform === 'darwin') {
    await expect(submenu.locator('img.file-action-app-icon')).toHaveCount(info.applications.length);
    await expect.poll(() => submenu.locator('img.file-action-app-icon').evaluateAll(images => images.every(image => {
      const icon = image as HTMLImageElement;
      return icon.complete && icon.naturalWidth > 0 && icon.src.startsWith('data:image/png;base64,');
    }))).toBe(true);
  }
  await capture('electron-open-in-applications.png');
  const fileManager = submenu.getByRole('menuitem', { name: fileManagerName, exact: true });
  await fileManager.scrollIntoViewIfNeeded();
  await capture('electron-open-in-finder.png');
  await fileManager.click();
  await expect.poll(() => application.evaluate(() => Reflect.get(globalThis, 'smokeContextReveals'))).toEqual([absoluteSamplePath]);
  await expect(menu).toHaveCount(0);
  console.log('PASS: diff-tab and Commit-sidebar path copying, real application submenu/icons, and the stubbed file-manager action.');

  await openMenu(diffTab); await expect(menuItem('Jump to Source')).toBeEnabled(); await menuItem('Jump to Source').click();
  const codeTab = page.getByRole('tab', { name: samplePath, exact: true });
  const file = page.getByTestId('file-surface');
  await expect(codeTab).toHaveAttribute('aria-selected', 'true');
  await expect(file).toHaveAttribute('data-path', samplePath);
  await expect(file).toHaveAttribute('data-editable', 'true');
  await expect(file.locator('.view-lines')).toContainText('Updated text.');
  await expect(page.locator('.smart-diff')).toHaveCount(0);
  await copy(codeTab, 'Copy Path', absoluteSamplePath);
  await copy(codeTab, 'Copy Relative Path', samplePath);
  const projectRow = page.getByRole('tree', { name: 'Project files', exact: true }).getByRole('treeitem', { name: samplePath, exact: true });
  await copy(projectRow, 'Copy Path', absoluteSamplePath);
  await openMenu(codeTab); await expect(menuItem('Jump to Source')).toHaveCount(0); await page.keyboard.press('Escape');
  console.log('PASS: Jump to Source opens the ordinary editable working file; code tabs and Project-sidebar paths copy correctly.');

  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true }).click();
  const deletedRow = page.getByRole('treeitem', { name: `${deletedPath} (working)`, exact: true });
  await deletedRow.click();
  const deletedTab = page.getByRole('tab', { name: `Commit: ${deletedPath} — working`, exact: true });
  await expect(deletedTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await openMenu(deletedTab);
  await expect(menuItem('Jump to Source')).toBeDisabled();
  await expect(menuItem('Jump to Source')).toHaveAttribute('aria-description', /does not exist/);
  await menuItem('Open In').click();
  await expect(submenu.getByRole('menuitem')).toHaveCount(1);
  await expect(submenu.getByRole('menuitem')).toBeDisabled();
  await expect(submenu).toContainText('does not exist');
  await capture('electron-deleted-file-actions.png');
  await page.keyboard.press('Escape');
  await copy(deletedTab, 'Copy Path', join(canonicalRepository, deletedPath));
  await copy(deletedRow, 'Copy Relative Path', deletedPath);
  const removed = snapshot.workingChanges!.find(value => value.path === deletedPath)!;
  const removedInfo = await page.evaluate(({ id, changeId }) => window.desktop.getFileActions(id, { kind: 'change', id: changeId }), { id: repositoryId, changeId: removed.id });
  expect(removedInfo.source).toBeUndefined(); expect(removedInfo.applications).toEqual([]);

  // These go through the isolated renderer's real preload/IPC validation, not
  // a direct service call. Renderer-supplied raw paths are not capabilities.
  await expect(page.evaluate(target => window.desktop.getFileActions('../outside', target), target)).rejects.toThrow();
  for (const raw of ['../../etc/passwd', '/etc/hosts', '.git/index', samplePath, absoluteSamplePath]) {
    await expect(page.evaluate(({ id, raw }) => window.desktop.getFileActions(id, { kind: 'project', id: raw }), { id: repositoryId, raw })).rejects.toThrow();
  }
  await expect(page.evaluate(id => Reflect.apply(window.desktop.getFileActions, window.desktop, [id, { kind: 'path', id: '/etc/hosts' }]), repositoryId)).rejects.toThrow();
  await expect(page.evaluate(id => Reflect.apply(window.desktop.getFileActions, window.desktop, [id, null]), repositoryId)).rejects.toThrow();
  await expect(page.evaluate(({ id, target }) => Reflect.apply(window.desktop.copyFilePath, window.desktop, [id, target, 'raw']), { id: repositoryId, target })).rejects.toThrow();
  await expect(page.evaluate(id => window.desktop.copyFilePath(id, { kind: 'project', id: '/etc/hosts' }, 'absolute'), repositoryId)).rejects.toThrow();
  await expect.poll(clipboard).toBe(deletedPath);
  await expect(page.evaluate(({ id, target }) => window.desktop.openFileIn(id, target, '/Applications/Arbitrary.app'), { id: repositoryId, target })).rejects.toThrow();
  await expect(page.evaluate(({ id, sourceId, applicationId }) => window.desktop.openFileIn(id, { kind: 'project', id: sourceId }, applicationId), {
    id: repositoryId, sourceId: info.source!.id, applicationId: info.applications[0].id,
  })).rejects.toThrow();
  expect(await application.evaluate(() => Reflect.get(globalThis, 'smokeContextReveals'))).toEqual([absoluteSamplePath]);
  expect(errors).toEqual([]);
  expect((await git('diff', '--name-only', '-z')).stdout.split('\0').filter(Boolean).sort()).toEqual([deletedPath, samplePath].sort());
  console.log('PASS: deleted paths remain copyable, source/open actions are unavailable, and raw paths, malformed targets, arbitrary app IDs, and cross-target capabilities are rejected.');
  console.log(`Screenshots: ${artifactDirectory}`);
} catch (error) {
  await capture('electron-context-menu-failure.png').catch(() => {});
  throw error;
} finally {
  try {
    await application.evaluate(({ clipboard }) => {
      const contents = Reflect.get(globalThis, 'smokeContextClipboard') as import('electron').Data | undefined;
      if (contents) { clipboard.write(contents); Reflect.deleteProperty(globalThis, 'smokeContextClipboard'); }
    });
  } finally {
    await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}
