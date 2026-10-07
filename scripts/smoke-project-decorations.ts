/** Real Git facts, persisted root markings, and Monaco JSON diagnostics in Electron.
 * All mutations belong to a disposable repository/profile; no synthetic tree facts
 * or Monaco markers are injected, and the developer's running app is untouched. */
import { _electron as electron, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 30000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-project-decorations-'));
const repository = join(directory, 'semantic-project');
const profile = join(directory, 'profile');
const captures = join(directory, 'screenshots');
const artifacts = resolve('artifacts/project-decorations');
await Promise.all([mkdir(repository), mkdir(profile), mkdir(captures)]);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const write = async (path: string, text: string) => {
  await mkdir(dirname(join(repository, path)), { recursive: true });
  await writeFile(join(repository, path), text);
};
await git('init', '-q', '-b', 'main');
await git('config', 'user.name', 'Tree Smoke');
await git('config', 'user.email', 'tree-smoke@example.invalid');
await git('config', 'core.autocrlf', 'false');
await Promise.all(Object.entries({
  '.gitignore': '.idea/\n.vite/\nnode_modules/\nignored-folder/\n',
  '.github/README.md': '# Repository automation\n',
  '.github/workflows/ci.yml': 'name: CI\non: push\n',
  '.idea/workspace.xml': '<project version="4" />\n',
  'package.json': '{"name":"semantic-project","private":true}\n',
  'ordinary/clean.ts': 'export const ordinary = true;\n',
  'build/build-script.ts': 'export const authoredBuildScript = true;\n',
  'code/nested/main.ts': 'export const answer = 42;\n',
  'tests/unit/example.test.ts': 'export const testFixture = true;\n',
  'generated/client.ts': 'export const generatedClient = true;\n',
  'resources/messages.json': '{"hello":"world"}\n',
  'test-resources/fixture.json': '{"fixture":true}\n',
  'tracked-excluded/keep.ts': 'export const stillTracked = true;\n',
  'diagnostics/invalid.json': '{"enabled":true,"count":1}\n',
  'conflict.ts': 'export const branch = "base";\n',
}).map(([path, text]) => write(path, text)));
await git('add', '.');
await git('add', '-f', '--', '.idea/workspace.xml');
await git('commit', '-qm', 'Semantic tree baseline');
await git('checkout', '-qb', 'other');
await write('conflict.ts', 'export const branch = "other";\n');
await git('commit', '-qam', 'Other side');
await git('checkout', '-q', 'main');
await write('conflict.ts', 'export const branch = "main";\n');
await git('commit', '-qam', 'Main side');
await expect(git('merge', '--no-edit', 'other')).rejects.toThrow();
await Promise.all(Object.entries({
  '.github/workflows/ci.yml': 'name: CI\non: [push, pull_request]\n',
  '.idea/local.xml': '<project local="true" />\n',
  '.vite/cache.json': '{"cache":true}\n',
  'node_modules/example-package/package.json': '{"name":"example-package"}\n',
  'node_modules/example-package/index.js': 'module.exports = 42;\n',
  'ignored-folder/notes.txt': 'Ignored by Git, still ordinary project content.\n',
  'untracked.ts': 'export const untracked = true;\n',
  'staged.ts': 'export const staged = true;\n',
  'diagnostics/invalid.json': '{\n  "enabled": tru,\n  "count":\n}\n',
}).map(([path, text]) => write(path, text)));
await git('add', '--', 'staged.ts');
let links = true;
try {
  await symlink('code', join(repository, 'link-to-code'), 'dir');
  await symlink('missing-target', join(repository, 'broken-link'), 'file');
} catch (error) {
  links = false;
  console.warn('Symlink fixture unavailable:', error instanceof Error ? error.message : error);
}

const executablePath = process.env.SMART_DIFF_PACKAGED_EXECUTABLE;
const application = await electron.launch({
  ...(executablePath ? { executablePath, args: [`--user-data-dir=${profile}`] }
    : { args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${profile}`] }),
  env: { ...process.env, SMART_DIFF_DEV_URL: '' },
});
let page: Page | undefined;
let succeeded = false;
const captureErrors: string[] = [];
const capture = async (name: string, focus?: Locator) => {
  if (!page) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const target = await application.browserWindow(page);
  try {
    // macOS can suspend native captures after resizing an entirely hidden
    // window. Show only this disposable fixture window without activating it.
    await target.evaluate(window => { window.showInactive(); });
    if (focus) {
      await focus.focus();
      await expect(focus).toBeFocused();
    }
    // Clicking a max-content-width row can make Chromium scroll its far end
    // into view. Screenshots show the tree's normal left edge; horizontal
    // coverage is exercised separately below before restoring this position.
    await page.locator('.project-tree').evaluate(element => { element.scrollLeft = 0; });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const png = await Promise.race([
      captureWindow(application, page),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Window capture timed out: ${name}`)), 15000); }),
    ]);
    await writeFile(join(captures, name), png);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    captureErrors.push(message); console.warn(message);
  } finally {
    clearTimeout(timeout);
    await target.evaluate(window => { window.hide(); }).catch(() => {});
    await target.dispose();
  }
};
try {
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, repository);
  page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.stack ?? error.message); });
  const window = await application.browserWindow(page);
  try { await window.evaluate(window => { window.setContentSize(1440, 1040); }); }
  finally { await window.dispose(); }
  const projectButton = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true });
  if (await projectButton.getAttribute('aria-pressed') !== 'true') await projectButton.click();
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  const root = tree.getByRole('treeitem', { name: 'semantic-project', exact: true });
  const row = (path: string) => path ? tree.getByRole('treeitem', { name: path, exact: true }) : root;
  const color = (target: Locator) => target.locator('.project-node-name').evaluate(node => getComputedStyle(node).color);
  const background = (target: Locator) => target.evaluate(node => getComputedStyle(node).backgroundColor);
  const expand = async (path: string) => {
    await expect(row(path)).toBeVisible();
    if (await row(path).getAttribute('aria-expanded') !== 'true') await row(path).click();
    await expect(row(path)).toHaveAttribute('aria-expanded', 'true');
  };
  const collapseAll = async () => {
    await page!.getByRole('button', { name: 'Collapse project folders', exact: true }).click();
    await expand('');
  };
  const mark = async (path: string, name: string) => {
    await row(path).click({ button: 'right' });
    await page!.getByRole('menu', { name: 'Directory actions', exact: true }).getByRole('menuitem', { name: 'Mark Directory As', exact: true }).click();
    await page!.getByRole('menu', { name: 'Mark Directory As', exact: true }).getByRole('menuitemradio', { name, exact: true }).click();
    await expect(page!.locator('.project-action-error')).toHaveCount(0);
  };
  const preference = async (name: string, checked: boolean) => {
    await page!.getByRole('button', { name: 'Project view options', exact: true }).click();
    const item = page!.getByRole('menuitemcheckbox', { name, exact: true });
    if ((await item.getAttribute('aria-checked') === 'true') !== checked) await item.click();
    else await page!.keyboard.press('Escape');
  };
  await expect(root).toHaveAttribute('data-role', 'content');
  const sidebar = page.getByRole('separator', { name: 'Resize file sidebar', exact: true });
  await sidebar.focus();
  while (Number(await sidebar.getAttribute('aria-valuenow')) < 520) await page.keyboard.press('ArrowRight');

  // A dot prefix and a changed descendant do not recolor ordinary folder names.
  // A directory's own ignored Git state still has the warm Git foreground.
  const ordinaryColor = await color(row('ordinary'));
  for (const path of ['ordinary', 'build', '.github', '.idea', '.vite', 'ignored-folder']) {
    await expect(row(path)).toHaveAttribute('data-role', 'ordinary');
    await expect(row(path)).toHaveAttribute('data-inclusion', 'included');
    if (!['.vite', 'ignored-folder'].includes(path)) expect(await color(row(path))).toBe(ordinaryColor);
  }
  await expect(row('.github')).toHaveAttribute('data-git-state', 'clean');
  await expect(row('.idea')).toHaveAttribute('data-git-state', 'clean');
  await expect(row('.vite')).toHaveAttribute('data-git-state', 'ignored');
  expect(await color(row('.vite'))).not.toBe(ordinaryColor);
  expect(await color(row('.vite'))).toBe(await color(row('ignored-folder')));
  await expand('.github'); await expand('.github/workflows'); await expand('.idea'); await expand('.vite');
  await expect(row('.github/README.md')).toHaveAttribute('data-git-state', 'clean');
  await expect(row('.github/workflows/ci.yml')).toHaveAttribute('data-git-state', 'modified');
  await expect(row('.idea/workspace.xml')).toHaveAttribute('data-git-state', 'clean');
  await expect(row('.idea/local.xml')).toHaveAttribute('data-git-state', 'ignored');
  await expect(row('.idea/local.xml')).toHaveAttribute('title', /Ignored by \.gitignore:1/);
  expect(await color(row('.github/workflows/ci.yml'))).not.toBe(ordinaryColor);
  expect(await color(row('.idea/workspace.xml'))).toBe(ordinaryColor);
  expect(await color(row('.idea/local.xml'))).not.toBe(ordinaryColor);
  await row('.github/README.md').click();
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toContainText('Repository automation');
  await page.mouse.move(1300, 40);
  await tree.evaluate(element => { element.scrollTop = 0; });
  await capture('01-root-and-dot-directories.png');
  console.log('PASS: dot directories, ignored files, and tracked files keep independent semantic and Git presentation.');

  await collapseAll();
  await expect(row('node_modules')).toHaveAttribute('data-role', 'library');
  await expect(row('node_modules')).toHaveAttribute('data-role-declared', 'true');
  await expect(row('node_modules')).toHaveAttribute('data-inclusion', 'excluded');
  await expect(row('node_modules').locator('.project-semantic-icon')).toHaveAttribute('data-icon', 'library');
  await expect(row('node_modules').locator('.project-annotation')).toHaveText('library root');
  await expand('node_modules'); await expand('node_modules/example-package');
  const dependency = row('node_modules/example-package');
  await expect(dependency).toHaveAttribute('data-role', 'library');
  await expect(dependency).toHaveAttribute('data-role-declared', 'false');
  await expect(dependency).toHaveAttribute('data-inclusion', 'inherited-exclusion');
  await expect(dependency.locator('.project-annotation')).toHaveCount(0);
  await expect(dependency.locator('.project-semantic-icon')).not.toHaveAttribute('data-icon', 'library');
  await expect(row('node_modules/example-package/index.js')).toHaveAttribute('data-inclusion', 'inherited-exclusion');
  await expand('ordinary');
  await row('ordinary/clean.ts').click();
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toContainText('ordinary');
  await page.mouse.move(1300, 40);
  expect(await background(row('node_modules'))).toBe(await background(dependency));
  expect(await background(dependency)).not.toBe(await background(row('build')));
  // Long repository paths scroll the shared row surface horizontally. Short
  // scoped rows must continue painting through the right edge after that scroll.
  await tree.evaluate(element => { element.scrollLeft = 90; });
  await expect.poll(() => tree.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const viewportRight = await tree.evaluate(element => element.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(element).paddingRight));
  expect((await dependency.boundingBox())!.x + (await dependency.boundingBox())!.width).toBeGreaterThanOrEqual(viewportRight - 1);
  await tree.evaluate(element => { element.scrollLeft = 0; });
  await tree.evaluate(element => { element.scrollTop = 0; });
  await capture('02-library-unselected-and-children.png');
  // Select the library root, then re-expand with the keyboard without replacing
  // the selection; its scope background must yield to the full-width selection.
  await row('node_modules').click();
  await page.keyboard.press('ArrowRight');
  await expect(row('node_modules')).toHaveAttribute('aria-selected', 'true');
  await expect(dependency).toBeVisible();
  await page.mouse.move(1300, 40);
  expect(await background(row('node_modules'))).not.toBe(await background(dependency));
  await capture('03-library-selected.png', row('node_modules'));
  console.log('PASS: detected dependency root, inherited exclusion, annotations, and selection backgrounds remain distinct.');

  await collapseAll();
  for (const [path, marking, role] of [
    ['code', 'Sources', 'sources'], ['tests', 'Test Sources', 'test-sources'],
    ['resources', 'Resources', 'resources'], ['test-resources', 'Test Resources', 'test-resources'],
    ['generated', 'Generated Sources', 'sources'],
  ]) {
    await mark(path, marking);
    await expect(row(path)).toHaveAttribute('data-role', role);
    await expect(row(path)).toHaveAttribute('data-role-declared', 'true');
    await expect(row(path).locator('.project-semantic-icon')).toHaveAttribute('data-icon', role);
  }
  await mark('tracked-excluded', 'Excluded');
  await expect(row('tracked-excluded')).toHaveAttribute('data-inclusion', 'excluded');
  await expect(row('tracked-excluded')).toHaveAttribute('data-git-state', 'clean');
  await expect(row('generated')).toHaveAttribute('data-generated', 'true');
  await expand('code'); await expand('tests'); await expand('generated'); await expand('tracked-excluded');
  await expect(row('code/nested')).toHaveAttribute('data-role', 'sources');
  await expect(row('code/nested')).toHaveAttribute('data-role-declared', 'false');
  await expect(row('code/nested').locator('.project-semantic-icon')).toHaveAttribute('data-icon', 'folder');
  await expect(row('tests/unit')).toHaveAttribute('data-role-declared', 'false');
  await expect(row('generated/client.ts')).toHaveAttribute('data-generated', 'true');
  await expect(row('tracked-excluded/keep.ts')).toHaveAttribute('data-inclusion', 'inherited-exclusion');
  await expect(row('tracked-excluded/keep.ts')).toHaveAttribute('data-git-state', 'clean');
  await expect(row('build')).toHaveAttribute('data-generated', 'false');
  await expect(row('build')).toHaveAttribute('data-inclusion', 'included');
  await expect(row('untracked.ts')).toHaveAttribute('data-git-state', 'untracked');
  await expect(row('staged.ts')).toHaveAttribute('data-git-state', 'added');
  await expect(row('conflict.ts')).toHaveAttribute('data-git-state', 'conflicted');
  expect(await color(row('untracked.ts'))).not.toBe(await color(row('staged.ts')));
  expect(await color(row('conflict.ts'))).not.toBe(await color(row('staged.ts')));
  if (links) {
    await expect(row('link-to-code')).toHaveAttribute('data-kind', 'symlink');
    await expect(row('link-to-code')).toHaveAttribute('title', /[Ss]ymlink|[Ss]ymbolic link/);
    await expect(row('broken-link')).toHaveAttribute('title', /[Bb]roken/);
  }
  await page.mouse.move(1300, 40);
  await tree.evaluate(element => { element.scrollTop = 0; });
  await capture('04-marked-roots-and-git-states.png');
  console.log('PASS: UI directory markings distinguish declared roots, descendants, generated content, and Git state.');

  // Visibility controls are independent: Git-ignore does not imply exclusion.
  await collapseAll();
  await preference('Show excluded files', false);
  await expect(row('node_modules')).toHaveCount(0);
  await expect(row('tracked-excluded')).toHaveCount(0);
  await expect(row('.vite')).toBeVisible();
  await expect(row('ignored-folder')).toBeVisible();
  await preference('Show excluded files', true);
  await preference('Show ignored files', false);
  await expect(row('.vite')).toHaveCount(0);
  await expect(row('ignored-folder')).toHaveCount(0);
  await expect(row('tracked-excluded')).toBeVisible();
  await expand('.idea');
  await expect(row('.idea/workspace.xml')).toBeVisible();
  await expect(row('.idea/local.xml')).toHaveCount(0);
  await preference('Show ignored files', true);
  await preference('Show hidden files', false);
  await expect(row('.github')).toHaveCount(0);
  await expect(row('ordinary')).toBeVisible();
  await preference('Show hidden files', true);
  await preference('Highlight changed directories', true);
  await expect.poll(() => color(row('.github'))).not.toBe(ordinaryColor);
  await preference('Highlight changed directories', false);
  await expect.poll(() => color(row('.github'))).toBe(ordinaryColor);
  console.log('PASS: ignored/excluded/hidden filters and opt-in directory status colors operate independently.');

  // A renderer reload must load the markings from the real per-project profile,
  // not from a synthetic initial React state in this test.
  await page.reload();
  await expect(row('code')).toHaveAttribute('data-role', 'sources');
  await expect(row('generated')).toHaveAttribute('data-generated', 'true');
  await expect(row('tracked-excluded')).toHaveAttribute('data-inclusion', 'excluded');
  await expect(row('.github')).toBeVisible();
  await expect.poll(() => color(row('.github'))).toBe(ordinaryColor);
  await expect(root).not.toHaveAttribute('data-diagnostic', 'error');
  await expand('diagnostics');
  const invalid = row('diagnostics/invalid.json');
  await expect(invalid).not.toHaveAttribute('data-diagnostic', 'error');
  const beforeErrorColor = await color(invalid);
  await invalid.click();
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toContainText('"enabled"');
  // Monaco's real JSON language worker supplies the errors after the model is
  // opened. The tree consumes marker events; no test marker injection is used.
  await expect(invalid).toHaveAttribute('data-diagnostic', 'error');
  await expect(row('diagnostics')).toHaveAttribute('data-diagnostic', 'error');
  await expect(root).toHaveAttribute('data-diagnostic', 'error');
  await expect(invalid).toHaveAttribute('title', /Reported errors:/);
  await expect(root).toHaveAttribute('title', /open files only/);
  expect(await color(invalid)).toBe(beforeErrorColor);
  expect(await color(row('diagnostics'))).toBe(ordinaryColor);
  const underline = await invalid.locator('.project-node-name').evaluate(node => {
    const style = getComputedStyle(node);
    return { line: style.textDecorationLine, style: style.textDecorationStyle, color: style.textDecorationColor };
  });
  expect(underline.line).toBe('underline'); expect(underline.style).toBe('wavy');
  expect(underline.color).not.toBe(beforeErrorColor);
  await page.mouse.move(1300, 40);
  await tree.evaluate(element => { element.scrollTop = 0; });
  await capture('05-real-json-diagnostics.png');
  await write('diagnostics/invalid.json', '{"enabled":true,"count":2}\n');
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toContainText('2');
  await expect(invalid).not.toHaveAttribute('data-diagnostic', 'error');
  await expect(row('diagnostics')).not.toHaveAttribute('data-diagnostic', 'error');
  await expect(root).not.toHaveAttribute('data-diagnostic', 'error');
  await capture('06-cleared-json-diagnostics.png');
  expect(errors).toEqual([]);
  expect(captureErrors).toEqual([]);
  succeeded = true;
  console.log('PASS: persisted markings survive reload; real JSON diagnostics underline files/ancestors and clear after fixing the file.');
} catch (error) {
  await capture('failure.png').catch(() => {});
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
  }).catch(() => {});
  await application.close().catch(() => {});
  await mkdir(artifacts, { recursive: true });
  await cp(captures, artifacts, { recursive: true });
  if (succeeded) await rm(join(artifacts, 'failure.png'), { force: true });
  await rm(directory, { recursive: true, force: true });
  console.log(`Project decoration screenshots: ${artifacts}`);
}
