/** Read-only production memory benchmark. Does not build or edit repository files.
 * Usage: npx tsx scripts/benchmark-memory.ts /path/to/repo before|after changed-file [changed-file...]
 * Files must be repository-relative text files with local changes (up to 1 MiB each). */
import { _electron as electron, expect as baseExpect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { captureWindow, openRepositoryWindow } from './electron-smoke-windows';

const [input, label, ...fileArguments] = process.argv.slice(2);
if (!input || !label || !fileArguments.length) throw new Error('Usage: npx tsx scripts/benchmark-memory.ts /path/to/repo label changed-file [changed-file...]');
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Benchmark label must use lowercase letters, digits and hyphens.');
const repository = await realpath(resolve(input));
if (!(await stat(repository)).isDirectory()) throw new Error('Expected a repository directory.');
const artifacts = resolve('artifacts/memory');
const summaryPath = join(artifacts, `${label}.json`);
if (await stat(summaryPath).then(() => true, () => false)) throw new Error(`Will not overwrite baseline: ${summaryPath}`);
const run = promisify(execFile);
const git = async (...args: string[]) => (await run('git', ['--no-optional-locks', '--literal-pathspecs', '-C', repository, ...args], {
  shell: false, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
})).stdout.trim();
const hash = async (path: string) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
};
if (await realpath(await git('rev-parse', '--show-toplevel')) !== repository) throw new Error('Use the repository root directory.');
const paths: string[] = [];
for (const filePath of fileArguments) {
  if (isAbsolute(filePath) || filePath.split(/[\\/]/).some(part => part === '..' || part.toLowerCase() === '.git')) {
    throw new Error(`Comparison files must be repository-relative and outside Git internals: ${filePath}`);
  }
  const target = resolve(repository, filePath);
  const contained = relative(repository, await realpath(target));
  if (!contained || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained) || contained.split(sep).some(part => part.toLowerCase() === '.git')) {
    throw new Error(`The comparison file must stay inside the repository and outside Git internals: ${filePath}`);
  }
  const info = await lstat(target);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error(`Choose a regular text comparison file no larger than 1 MiB: ${filePath}`);
  const bytes = await readFile(target);
  if (bytes.includes(0)) throw new Error(`Choose a UTF-8 text comparison file: ${filePath}`);
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`Choose a UTF-8 text comparison file: ${filePath}`); }
  const normalized = relative(repository, target).split(sep).join('/');
  if (!await git('status', '--porcelain=v1', '--untracked-files=normal', '--', normalized)) throw new Error(`The comparison file must have local changes: ${filePath}`);
  if (paths.includes(normalized)) throw new Error(`Supply each comparison file only once: ${filePath}`);
  paths.push(normalized);
}
const checkpointCounts = new Set([1, Math.ceil(paths.length / 3), Math.ceil(paths.length * 2 / 3), paths.length]);
const indexPath = resolve(repository, await git('rev-parse', '--git-path', 'index'));
const before = { head: await git('rev-parse', 'HEAD'), index: await hash(indexPath), files: Object.fromEntries(await Promise.all(paths.map(async path => [path, await hash(join(repository, path))]))) };
const build = { mainSHA256: await hash(resolve('apps/desktop/dist/index.cjs')), rendererHTMLSHA256: await hash(resolve('apps/desktop/dist/renderer/index.html')).catch(() => null) };
await mkdir(artifacts, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-memory-'));
const profile = join(temporary, 'profile');
await mkdir(profile);
const bootstrap = join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
BrowserWindow.prototype.show = function () { this.webContents.setBackgroundThrottling(false); this.hide(); };
BrowserWindow.prototype.focus = function () {};
app.on('browser-window-created', (_event, window) => {
  window.setOpacity(0); window.setIgnoreMouseEvents(true); window.setFocusable(false);
  window.webContents.setBackgroundThrottling(false);
});
require(${JSON.stringify(resolve('apps/desktop/dist/index.cjs'))});
`);
const application = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], env: { ...process.env, SMART_DIFF_DEV_URL: '', GIT_OPTIONAL_LOCKS: '0' }, timeout: 60000 });
const expect = baseExpect.configure({ timeout: 90000 });
const errors: string[] = [];
const checkpoints: unknown[] = [];
const opened: { path: string; milliseconds: number }[] = [];
let phase = 'launch';
let page: Page | undefined;
let rendererMetrics: (() => Promise<unknown>) | undefined;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report = async (name: string) => {
  phase = name;
  const samples: unknown[] = [];
  for (let count = 0; count < 3; count++) {
    const metrics = await application.evaluate(({ app, BrowserWindow }) => ({
      timestamp: Date.now(), uptime: process.uptime(), mainHeap: process.memoryUsage(),
      processes: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, name: metric.name, serviceName: metric.serviceName,
        workingSetBytes: metric.memory?.workingSetSize === undefined ? null : metric.memory.workingSetSize * 1024,
        peakWorkingSetBytes: metric.memory?.peakWorkingSetSize === undefined ? null : metric.memory.peakWorkingSetSize * 1024,
        cpu: metric.cpu })),
      windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, visible: window.isVisible(), rendererPid: window.webContents.getOSProcessId() })),
    }));
    const renderer = await rendererMetrics?.();
    const dom = await page?.evaluate(() => ({
      tabs: document.querySelectorAll('[role="tab"]').length,
      editorDOMs: document.querySelectorAll('.monaco-editor').length,
      fileSurfaces: document.querySelectorAll('[data-testid="file-surface"]').length,
      diffSurfaces: document.querySelectorAll('.smart-diff').length,
      visibleEditorDOMs: [...document.querySelectorAll('.monaco-editor')].filter(editor => (editor as HTMLElement).offsetWidth > 0 && (editor as HTMLElement).offsetHeight > 0).length,
      resources: performance.getEntriesByType('resource').length,
    }));
    samples.push({ ...metrics, renderer, dom, totalWorkingSetBytes: metrics.processes.reduce((sum, item) => sum + (item.workingSetBytes ?? 0), 0) });
    if (count < 2) await wait(1000);
  }
  checkpoints.push({ name, samples });
  const last = samples.at(-1) as { totalWorkingSetBytes: number; mainHeap: { heapUsed: number }; dom?: unknown; renderer?: unknown };
  console.log(`${name}: ${(last.totalWorkingSetBytes / 1024 / 1024).toFixed(1)} MiB total; main heap ${(last.mainHeap.heapUsed / 1024 / 1024).toFixed(1)} MiB; ${JSON.stringify({ dom: last.dom, renderer: last.renderer })}`);
  await writeFile(join(artifacts, `${label}-partial.json`), JSON.stringify({ repository, label, build, checkpoints, opened, errors }, null, 2));
};

try {
  const welcome = await application.firstWindow();
  await welcome.evaluate(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
  await application.evaluate(({ app, dialog, ipcMain }, { repository, profile }) => {
    if (app.getPath('userData') !== profile) throw new Error('Profile isolation failed.');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] });
    for (const channel of ['branches:run', 'tree-actions:perform', 'text:save', 'repository:create', 'repository:clone', 'file-actions:open', 'project:mark']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => { throw new Error(`Mutation blocked by read-only memory benchmark: ${channel}`); });
    }
  }, { repository, profile });
  await report('welcome');
  const start = performance.now();
  page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  page.setDefaultTimeout(90000);
  const window = await application.browserWindow(page);
  await window.evaluate(window => { window.setContentSize(1440, 1000); window.hide(); });
  await window.dispose();
  await expect(page.getByRole('button', { name: 'Project switcher', exact: true })).toContainText(basename(repository));
  let cdp = await page.context().newCDPSession(page);
  rendererMetrics = async () => ({ heap: await cdp.send('Runtime.getHeapUsage'), dom: await cdp.send('Memory.getDOMCounters') });
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: new RegExp(`^${paths[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`) })).toBeVisible();
  // The application opens the first changed file automatically. Close that tab
  // explicitly so the idle checkpoint actually has no editor/model attached.
  while (await page.locator('.workspace-tab-close').count()) await page.locator('.workspace-tab-close').first().click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await wait(10000);
  await report('project-idle');
  console.log(`Project ready in ${Math.round(performance.now() - start)} ms including fixed 10-second idle.`);
  for (const [index, path] of paths.entries()) {
    phase = `open ${path}`;
    const started = performance.now();
    const row = page.getByRole('treeitem', { name: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`) }).first();
    await row.click();
    await expect(page.locator('.monaco-editor').filter({ visible: true }).first()).toBeVisible();
    await wait(1500);
    opened.push({ path, milliseconds: Math.round(performance.now() - started) });
    if (checkpointCounts.has(index + 1)) await report(`tabs-${index + 1}`);
  }
  await wait(10000);
  await report(`tabs-${paths.length}-idle`);
  if (label.startsWith('after')) {
    phase = 'profiler-capture';
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('navigation', { name: 'Settings categories', exact: true }).getByRole('button', { name: 'Profiler', exact: true }).click();
    await expect(settings.getByText('RAM · working sets', { exact: true })).toBeVisible();
    await wait(1200);
    const captureHandle = await application.browserWindow(page);
    try {
      await captureHandle.evaluate(window => window.showInactive());
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await writeFile(join(artifacts, `${label}-profiler.png`), await captureWindow(application, page));
    } finally {
      await captureHandle.evaluate(window => window.hide());
      await captureHandle.dispose();
    }
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  phase = 'close-project';
  await cdp.detach();
  rendererMetrics = undefined;
  const closingWindow = await application.browserWindow(page);
  const restoredWelcome = application.waitForEvent('window', { timeout: 30000 });
  // This is the same BrowserWindow.close path invoked by File > Close Project.
  // No file buffer is edited, so there are no pending save prompts.
  await closingWindow.evaluate(window => window.close());
  await closingWindow.dispose();
  page = await restoredWelcome;
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('button', { name: 'Open…', exact: true })).toBeVisible();
  cdp = await page.context().newCDPSession(page);
  rendererMetrics = async () => ({ heap: await cdp.send('Runtime.getHeapUsage'), dom: await cdp.send('Memory.getDOMCounters') });
  await wait(10000);
  await report('closed-project-idle');
  const after = { head: await git('rev-parse', 'HEAD'), index: await hash(indexPath), files: Object.fromEntries(await Promise.all(paths.map(async path => [path, await hash(join(repository, path))]))) };
  const readOnlyObservations = { headUnchanged: before.head === after.head, indexUnchanged: before.index === after.index, openedFilesUnchanged: JSON.stringify(before.files) === JSON.stringify(after.files) };
  expect(readOnlyObservations).toEqual({ headUnchanged: true, indexUnchanged: true, openedFilesUnchanged: true });
  expect(errors).toEqual([]);
  await writeFile(summaryPath, JSON.stringify({ repository, label, build, configuration: { viewport: [1440, 1000], sampleCount: 3, idleWaitMs: 10000, betweenFilesMs: 1500, profileIsolated: true, mutationsBlocked: true, windowHidden: true, backgroundThrottling: false, garbageCollectionForced: false }, checkpoints, opened, errors, readOnlyObservations }, null, 2));
  await rm(join(artifacts, `${label}-partial.json`), { force: true });
  await cdp.detach();
  console.log(`Memory benchmark saved: ${summaryPath}`);
} catch (error) {
  await writeFile(join(artifacts, `${label}-failure.json`), JSON.stringify({ phase, error: String(error), checkpoints, opened, errors, body: await page?.locator('body').innerText().catch(() => undefined) }, null, 2));
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
