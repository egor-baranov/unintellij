/** Click-to-paint timings against the production Electron app and a disposable Git repository.
 * Build the desktop app first, then: npx tsx scripts/smoke-diff-open.ts [baseline|after]
 * No user repository, application profile, or visible window is changed.
 */
import { _electron as electron, expect as baseExpect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FileComparison } from '../apps/desktop/src/bridge';
import { captureWindow, openRepositoryWindow } from './electron-smoke-windows';

interface ReadTiming { startedAt: number; completedAt?: number; path?: string; state?: string; error?: string }
interface PaintTiming { label: string; path: string; start: number; firstCodeMs?: number; readyMs?: number }
const phase = process.argv[2] ?? 'after';
if (!/^[a-z-]+$/.test(phase)) throw new Error('Use a simple output phase such as baseline or after.');
const expect = baseExpect.configure({ timeout: 30000 });
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-open-'));
const repository = join(temporary, 'diff-open');
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/diff-open', phase);
const run = promisify(execFile);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const paths = ['service.go', 'main.tf', 'service.ts'];
const count = 8000;
await Promise.all([mkdir(repository), mkdir(profile), mkdir(artifacts, { recursive: true })]);
const source = (extension: string, changed: boolean) => {
  const prefix = extension === 'go' ? 'package fixture\n\n' : extension === 'tf' ? '# Terraform fixture\n\n' : '// TypeScript fixture\n\n';
  return prefix + Array.from({ length: 800 }, (_, index) => {
    const value = changed && index % 80 === 0 ? index + 42 : index;
    if (extension === 'go') return `func Function${index}() int { return ${value} }`;
    if (extension === 'tf') return `locals { value_${index} = ${value} }`;
    return `export const value${index}: number = ${value};`;
  }).join('\n') + '\n';
};
await git('init', '-q', '-b', 'main');
await mkdir(join(repository, 'indexed'));
for (let base = 0; base < count; base += 100) {
  await Promise.all(Array.from({ length: 100 }, (_, offset) => writeFile(join(repository, 'indexed', `file-${base + offset}.txt`), 'Tracked index fixture.\n')));
}
await Promise.all(paths.map(path => writeFile(join(repository, path), source(path.split('.').at(-1)!, false))));
await git('add', '.');
await git('-c', 'user.name=Diff open smoke', '-c', 'user.email=diff-open@example.invalid', 'commit', '-qm', 'Fixture');
await Promise.all(paths.map(path => writeFile(join(repository, path), source(path.split('.').at(-1)!, true))));
await writeFile(join(repository, 'untracked.txt'), 'Untracked fixture.\n');
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
const application = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], env: { ...process.env, SMART_DIFF_DEV_URL: '' } });
const errors: string[] = [];
const measurements: PaintTiming[] = [];
let page: Page | undefined;
const reads = () => application.evaluate(() => Reflect.get(globalThis, 'diffOpenReads') as ReadTiming[]);
try {
  const welcome = await application.firstWindow();
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  await application.evaluate(({ dialog, ipcMain }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    type Handler = (event: import('electron').IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler>;
    const original = handlers.get('repository:read');
    if (!original) throw new Error('Missing repository:read handler');
    const timings: ReadTiming[] = [];
    Reflect.set(globalThis, 'diffOpenReads', timings);
    ipcMain.removeHandler('repository:read');
    ipcMain.handle('repository:read', async (event, ...args: unknown[]) => {
      const timing: ReadTiming = { startedAt: Date.now() }; timings.push(timing);
      try {
        const result = await original(event, ...args) as FileComparison;
        timing.completedAt = Date.now(); timing.path = result.path; timing.state = result.state;
        return result;
      } catch (error) { timing.completedAt = Date.now(); timing.error = String(error); throw error; }
    });
  }, repository);
  page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(window => window.setContentSize(1440, 900));
  await expect(page.getByRole('button', { name: 'Project switcher', exact: true })).toContainText('diff-open');
  const commit = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true });
  if (await commit.getAttribute('aria-pressed') !== 'true') await commit.click();
  await expect(page.getByRole('treeitem', { name: 'service.go (working)', exact: true })).toBeVisible();
  await page.evaluate(`(() => {
    // Time from the actual click event, excluding Playwright's actionability waits.
    // Code appearance and worker-ready appearance use the same renderer clock.
    let active;
    Reflect.set(window, 'diffOpenPaints', []);
    const observe = () => {
      if (!active || active.readyMs !== undefined) return;
      const main = document.querySelector('.workspace-group.is-active main[aria-label="Selected file comparison"]');
      if (main?.getAttribute('data-path') !== active.path) return;
      const panes = main.querySelectorAll('.smart-diff-pane .view-lines');
      if (panes.length === 2 && [...panes].every(pane => pane.textContent?.trim())) {
        active.firstCodeMs ??= performance.now() - active.start;
        if (main.querySelector('.smart-diff[data-status="ready"]')) active.readyMs = performance.now() - active.start;
      }
    };
    document.addEventListener('click', event => {
      const target = event.target.closest('[role="treeitem"], [role="tab"]');
      if (!target) return;
      const armed = Reflect.get(window, 'diffOpenArmed');
      if (!armed) return;
      active = { ...armed, start: performance.now() };
      Reflect.get(window, 'diffOpenPaints').push(active);
      Reflect.deleteProperty(window, 'diffOpenArmed');
      requestAnimationFrame(observe);
    }, true);
    new MutationObserver(observe).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  })();`);
  const expectPath = async (path: string) => {
    const main = page!.locator('.workspace-group.is-active main[aria-label="Selected file comparison"]');
    await expect(main).toHaveAttribute('data-path', path);
    await expect(main).toHaveAttribute('data-original-path', path);
    await expect(main.locator('.source-headers')).toHaveCount(0);
    await expect(main.locator('.smart-diff[data-status="ready"]')).toBeVisible();
    await expect(main.locator('[data-side="modified"] .view-lines')).toContainText(path.endsWith('.go') ? 'Function' : 'value');
    await expect(main.getByRole('heading', { name: 'Loading comparison…', exact: true })).toHaveCount(0);
  };
  const click = async (path: string, label: string, tab = false) => {
    await page!.evaluate(armed => Reflect.set(window, 'diffOpenArmed', armed), { path, label });
    await page!.getByRole(tab ? 'tab' : 'treeitem', { name: tab ? `Commit: ${path} — working` : `${path} (working)`, exact: true }).click();
    await expectPath(path);
    await expect.poll(() => page!.evaluate(label => (Reflect.get(window, 'diffOpenPaints') as PaintTiming[]).find(item => item.label === label)?.readyMs, label)).toBeGreaterThan(0);
    measurements.push(await page!.evaluate(label => (Reflect.get(window, 'diffOpenPaints') as PaintTiming[]).find(item => item.label === label)!, label));
  };
  await click(paths[0], 'cold-first');
  await click(paths[1], 'second-file');
  await click(paths[2], 'third-file');
  await click(paths[0], 'revisit-first', true);
  await click(paths[1], 'revisit-second', true);
  await click(paths[2], 'revisit-third', true);
  await page.getByRole('button', { name: `Close Commit: ${paths[0]} — working`, exact: true }).click();
  await click(paths[0], 'closed-then-reopened');
  // Give every switch a render frame; late replies may never replace the last target.
  await page.evaluate(async paths => {
    for (const path of paths) {
      document.querySelector<HTMLElement>(`[role="tab"][aria-label="Commit: ${path} — working"]`)!.click();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  }, [paths[2], paths[1], paths[0]]);
  await expectPath(paths[0]);
  const instance = await page.locator('.workspace-group.is-active main').getAttribute('data-instance-id');
  await writeFile(join(repository, paths[1]), source('tf', true) + '# Background update\n');
  await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Changed files', exact: true })).toHaveAttribute('aria-busy', 'false');
  await expectPath(paths[0]);
  await expect(page.locator('.workspace-group.is-active main')).toHaveAttribute('data-instance-id', instance!);
  await click(paths[1], 'updated-file-after-refresh', true);
  // Inspect the live Monaco source, not only the collapsed visible excerpt.
  await expect(page.locator('.workspace-group.is-active main')).not.toContainText('File unavailable');
  await expect(page.locator('.notice[role="alert"]')).toHaveCount(0);
  const changes = page.getByTestId('change-count');
  await expect(changes).toHaveText('1 / 11');
  await page.getByRole('button', { name: 'Previous change', exact: true }).click();
  await expect(page.locator('.workspace-group.is-active [data-side="modified"] .view-lines')).toContainText('# Background update');
  await page.getByRole('button', { name: 'Next change', exact: true }).click();
  expect(errors).toEqual([]);
  expect((await reads()).filter(read => read.error)).toEqual([]);
  await nativeWindow.evaluate(window => window.showInactive());
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await writeFile(join(artifacts, 'comparison.png'), await captureWindow(application, page));
  await nativeWindow.evaluate(window => window.hide());
  const ipc = (await reads()).map(read => ({ ...read, durationMs: read.completedAt === undefined ? undefined : read.completedAt - read.startedAt }));
  const result = { phase, indexedFiles: count + paths.length, linesPerComparison: 803, measurements, ipc,
    errors, checks: ['real temporary Git repository', 'cold and warm click-to-paint and worker-ready timing', 'closed tab reopen', 'rapid tab switching keeps last target', 'background refresh preserves active instance', 'changed target opens after refresh', 'no renderer or IPC errors'],
    screenshot: join(artifacts, 'comparison.png'), captureMode: 'Hidden before first show; transparent nonfocusable compositor capture.' };
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify(result, null, 2));
  await rm(join(artifacts, 'failure.json'), { force: true });
  console.log(JSON.stringify(result, null, 2));
  await nativeWindow.dispose();
} catch (error) {
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ error: String(error), measurements, ipc: await reads().catch(() => []), errors,
    body: page ? await page.locator('body').innerText().catch(() => '') : undefined }, null, 2));
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
