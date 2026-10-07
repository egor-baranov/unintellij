/** Read-only production Electron smoke for a real, explicitly supplied repository.
 * Usage: npx tsx scripts/smoke-large-repository.ts /path/to/repository [relative-file] [relative-directory]
 * Build desktop main/renderer first. Only the disposable profile and artifacts are written. */
import { _electron as electron, expect as baseExpect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const input = process.argv[2];
if (!input) throw new Error('Usage: npx tsx scripts/smoke-large-repository.ts /path/to/repository [relative-file] [relative-directory]');
const repository = await realpath(resolve(input));
if (!(await stat(repository)).isDirectory()) throw new Error('Repository argument must be a directory.');
const rootEntries = await readdir(repository, { withFileTypes: true });
const filePath = process.argv[3] ?? ['README.md', 'README', 'package.json'].find(name => rootEntries.some(entry => entry.name === name && entry.isFile()));
const directoryPath = process.argv[4] ?? ['docs', 'src', 'apps', 'packages'].find(name => rootEntries.some(entry => entry.name === name && entry.isDirectory()))
  ?? rootEntries.find(entry => entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'dist', 'build'].includes(entry.name))?.name;
if (!filePath || !directoryPath) throw new Error('Supply a relative text file and a relative directory when the repository has no safe default.');
for (const candidate of [filePath, directoryPath]) {
  const absolute = resolve(repository, candidate);
  const contained = relative(repository, await realpath(absolute));
  if (isAbsolute(candidate) || candidate.split(/[\\/]/).some(part => ['..', '.git'].includes(part)) || !contained || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error('Smoke paths must refer to entries inside the chosen repository, outside Git internals.');
  }
}
if (!(await lstat(join(repository, filePath))).isFile() || !(await lstat(join(repository, directoryPath))).isDirectory()) throw new Error('Expected a regular file and an ordinary directory.');
const fileBytes = await readFile(join(repository, filePath));
if (fileBytes.length > 1024 * 1024 || fileBytes.includes(0)) throw new Error('Choose a text file no larger than 1 MiB.');
const childEntries = (await readdir(join(repository, directoryPath), { withFileTypes: true })).filter(entry => entry.name !== '.git');
if (!childEntries.length) throw new Error('Choose a nonempty directory to verify expansion.');
const run = promisify(execFile);
const git = async (...args: string[]) => (await run('git', ['--no-optional-locks', '-C', repository, ...args], { shell: false })).stdout.trim();
const indexPath = resolve(repository, await git('rev-parse', '--git-path', 'index'));
const before = { head: await git('rev-parse', 'HEAD'), index: await stat(indexPath), fileHash: createHash('sha256').update(fileBytes).digest('hex') };
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-large-repository-'));
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/large-repository');
await Promise.all([mkdir(profile), mkdir(artifacts, { recursive: true })]);
const expect = baseExpect.configure({ timeout: 60000 });
const errors: string[] = [];
const started = performance.now();
const timings: Record<string, number> = {};
const milliseconds = (since: number) => Math.round((performance.now() - since) * 10) / 10;
const application = await electron.launch({
  args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${profile}`],
  env: { ...process.env, SMART_DIFF_DEV_URL: '' },
  timeout: 60000,
});
let page: Page | undefined;
interface ReadTiming { channel: string; milliseconds: number; path?: string; entryCount?: number; error?: string }
const capture = async (page: Page, name: string) => {
  const window = await application.browserWindow(page);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const opacity = await window.evaluate(window => window.getOpacity());
  try {
    // macOS may not produce a new compositor frame for a hidden window. Paint
    // transparently without taking focus, and always bound the capture wait.
    await window.evaluate(window => { window.setFocusable(false); window.setOpacity(0); window.setIgnoreMouseEvents(true); window.showInactive(); });
    const image = await Promise.race([
      captureWindow(application, page),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Native screenshot did not finish within 8 seconds.')), 8000); }),
    ]);
    await writeFile(join(artifacts, name), image);
  } finally {
    clearTimeout(deadline);
    await window.evaluate((window, opacity) => { window.hide(); window.setOpacity(opacity); }, opacity).catch(() => {});
    await window.dispose();
  }
};

try {
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  timings.launchToWelcomeMs = milliseconds(started);
  // No edits are made, and auto-save is disabled defensively in this isolated profile.
  await welcome.evaluate(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
  await application.evaluate(({ app, BrowserWindow, dialog, ipcMain }, repository) => {
    // A production ready-to-show callback can run after the test's first hide.
    // Prevent native showing/focus before that call happens, inside this test
    // process only. Capture uses transparent, nonfocusable showInactive below.
    BrowserWindow.prototype.show = function () { this.webContents.setBackgroundThrottling(false); this.hide(); };
    app.on('browser-window-created', (_event, window) => {
      window.setOpacity(0); window.setIgnoreMouseEvents(true); window.setFocusable(false);
    });
    for (const window of BrowserWindow.getAllWindows()) { window.setOpacity(0); window.setIgnoreMouseEvents(true); window.setFocusable(false); window.hide(); }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] });
    type Handler = (event: import('electron').IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler> | undefined;
    if (!(handlers instanceof Map)) throw new Error('Electron IPC timing adapter unavailable.');
    const timings: ReadTiming[] = [];
    Reflect.set(globalThis, 'largeRepositoryReadTimings', timings);
    for (const channel of ['repository:choose', 'repository:last', 'repository:refresh', 'project:list', 'project:read']) {
      const original = handlers.get(channel);
      if (!original) throw new Error(`Missing genuine IPC handler: ${channel}`);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        const started = performance.now();
        try {
          const result = await original(event, ...args);
          const directory = result as import('../apps/desktop/src/bridge').ProjectDirectory | null;
          timings.push({ channel, milliseconds: Math.round((performance.now() - started) * 10) / 10,
            ...(directory && typeof directory.path === 'string' ? { path: directory.path } : {}),
            ...(directory && Array.isArray(directory.entries) ? { entryCount: directory.entries.length } : {}) });
          return result;
        } catch (error) {
          timings.push({ channel, milliseconds: Math.round((performance.now() - started) * 10) / 10, error: String(error) });
          throw error;
        }
      });
    }
  }, repository);
  const opening = performance.now();
  page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click({ timeout: 60000 }));
  timings.openToProjectWindowMs = milliseconds(opening);
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const window = await application.browserWindow(page);
  try { await window.evaluate(window => { window.setContentSize(1440, 980); window.hide(); }); }
  finally { await window.dispose(); }
  await expect(page.getByRole('button', { name: 'Project switcher', exact: true })).toContainText(basename(repository));
  const project = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true });
  if (await project.getAttribute('aria-pressed') !== 'true') await project.click();
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  const row = (path: string) => tree.getByRole('treeitem', { name: path, exact: true });
  await expect(row(filePath.split('/')[0])).toBeVisible();
  await expect(tree).toHaveAttribute('aria-busy', 'false');
  timings.openToRootRowsMs = milliseconds(opening);
  const rootRowCount = await tree.getByRole('treeitem').count();
  console.log(`PASS: ${basename(repository)} root displayed ${rootRowCount} tree rows in ${timings.openToRootRowsMs} ms.`);

  const expansion = performance.now();
  let path = '';
  for (const part of directoryPath.split('/')) {
    path = path ? `${path}/${part}` : part;
    const item = row(path);
    await expect(item).toBeVisible();
    if (await item.getAttribute('aria-expanded') !== 'true') await item.locator('.project-node-name').click();
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  }
  await expect.poll(() => tree.getByRole('treeitem').evaluateAll((items, directory) => items.filter(item => item.getAttribute('aria-label')?.startsWith(`${directory}/`)).length, directoryPath)).toBeGreaterThan(0);
  await expect(tree).toHaveAttribute('aria-busy', 'false');
  await expect(tree.locator('.project-directory-message').filter({ hasText: 'Loading' })).toHaveCount(0);
  await expect(tree.locator('.project-directory-error')).toHaveCount(0);
  timings.directoryExpansionMs = milliseconds(expansion);
  console.log(`PASS: ${directoryPath} expanded in ${timings.directoryExpansionMs} ms with no loading or error leftovers.`);

  const reading = performance.now();
  path = '';
  for (const part of filePath.split('/').slice(0, -1)) {
    path = path ? `${path}/${part}` : part;
    const item = row(path);
    if (await item.getAttribute('aria-expanded') !== 'true') await item.locator('.project-node-name').click();
  }
  await row(filePath).locator('.project-node-name').click();
  const file = page.getByTestId('file-surface');
  await expect(file).toHaveAttribute('data-path', filePath);
  await expect(file.locator('.monaco-editor')).toBeVisible();
  await expect(file.locator('.view-line').first()).toBeVisible();
  timings.fileOpenMs = milliseconds(reading);
  console.log(`PASS: ${filePath} rendered as a normal code file in ${timings.fileOpenMs} ms.`);
  const previousRefreshes = await application.evaluate(() => (Reflect.get(globalThis, 'largeRepositoryReadTimings') as ReadTiming[]).filter(read => read.channel === 'repository:refresh').length);
  const refreshing = performance.now();
  await page.getByRole('button', { name: 'Refresh project', exact: true }).click();
  await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, 'largeRepositoryReadTimings') as ReadTiming[]).filter(read => read.channel === 'repository:refresh').length), { timeout: 75000 }).toBeGreaterThan(previousRefreshes);
  timings.explicitRefreshMs = milliseconds(refreshing);
  await expect(tree).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.notice[role="alert"]')).toHaveCount(0);
  await expect(file).toHaveAttribute('data-path', filePath);
  console.log(`PASS: explicit repository refresh completed in ${timings.explicitRefreshMs} ms without an error banner.`);
  const reads = await application.evaluate(() => Reflect.get(globalThis, 'largeRepositoryReadTimings') as ReadTiming[]);
  const afterIndex = await stat(indexPath);
  const headUnchanged = await git('rev-parse', 'HEAD') === before.head;
  const openedFileHashUnchanged = createHash('sha256').update(await readFile(join(repository, filePath))).digest('hex') === before.fileHash;
  const indexObservation = {
    before: { size: before.index.size, mtimeMs: before.index.mtimeMs },
    after: { size: afterIndex.size, mtimeMs: afterIndex.mtimeMs },
    unchanged: before.index.size === afterIndex.size && before.index.mtimeMs === afterIndex.mtimeMs,
  };
  // This is a live repository, so external index/HEAD edits are observations,
  // not evidence of a mutation by the read-only test or a reason to revert it.
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({
    repository, profileIsolated: true, uiChecksPassed: true, timings, rootRowCount,
    directoryPath, filePath, fileBytes: fileBytes.length, ipcReads: reads, rendererErrors: errors,
    readOnlyObservations: { headUnchanged, index: indexObservation, openedFileHashUnchanged },
    screenshot: join(artifacts, 'repository-open.png'),
    captureMode: 'Transparent, unfocused native window, hidden again immediately after capture.',
    visualInspection: 'Pending capture and separate rendered-image inspection.',
  }, null, 2));
  await tree.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; });
  await capture(page, 'repository-open.png');
  await expect(page.locator('.notice[role="alert"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(reads.filter(read => read.error)).toEqual([]);
  await Promise.all(['failure.txt', 'failure.png'].map(name => rm(join(artifacts, name), { force: true })));
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const reads = await application.evaluate(() => Reflect.get(globalThis, 'largeRepositoryReadTimings') as ReadTiming[]).catch(() => undefined);
  await writeFile(join(artifacts, 'failure.txt'), JSON.stringify({ message, timings, ipcReads: reads, rendererErrors: errors, body: page ? await page.locator('body').innerText().catch(() => '') : undefined }, null, 2));
  if (page) await capture(page, 'failure.png').catch(() => {});
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
