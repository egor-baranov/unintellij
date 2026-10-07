/** Read-only production Electron branch-menu smoke for an explicitly supplied repository.
 * Usage: npx tsx scripts/smoke-large-branches.ts /path/to/repository
 * Build the desktop first. Writes only an isolated profile and artifacts/large-branches. */
import { _electron as electron, expect as baseExpect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { BranchSnapshot } from '../apps/shared/branches/types';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const input = process.argv[2];
if (!input) throw new Error('Usage: npx tsx scripts/smoke-large-branches.ts /path/to/repository');
const repository = await realpath(resolve(input));
if (!(await stat(repository)).isDirectory()) throw new Error('Repository argument must be a directory.');
const run = promisify(execFile);
const git = async (...args: string[]) => (await run('git', ['--no-optional-locks', '-C', repository, ...args], {
  shell: false, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
})).stdout.trim();
const hashFile = async (file: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const indexPath = resolve(repository, await git('rev-parse', '--git-path', 'index'));
const referenceOutput = await git('for-each-ref', '--sort=refname', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags');
// Ignore symbolic remote HEAD aliases, exactly as the branch menu does.
const referenceNames = referenceOutput.split('\n').map(line => line.split('\0')).filter(([ref, symbolic]) => ref && !symbolic).map(([ref]) => ref);
const currentRef = await git('symbolic-ref', '--quiet', 'HEAD').catch(() => '');
const before = { head: await git('rev-parse', 'HEAD'), index: await stat(indexPath), indexDigest: await hashFile(indexPath) };
const remote = [...referenceNames].reverse().find(ref => ref.startsWith('refs/remotes/')) ?? referenceNames.at(-1);
if (!remote) throw new Error('Choose a repository with at least one branch or tag.');
const searchName = remote.replace(/^refs\/(heads|remotes|tags)\//, '');
const expectedCurrent = currentRef.replace(/^refs\/heads\//, '') || before.head.slice(0, 8);
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-large-branches-'));
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/large-branches');
await Promise.all([mkdir(profile), mkdir(artifacts, { recursive: true })]);
const expect = baseExpect.configure({ timeout: 90000 });
const errors: string[] = [];
const timings: Record<string, number> = {};
const milliseconds = (since: number) => Math.round((performance.now() - since) * 10) / 10;
interface BranchRead { milliseconds: number; count?: number; current?: string | null; refs?: string[]; error?: string }
const started = performance.now();
const application = await electron.launch({
  args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${profile}`],
  env: { ...process.env, SMART_DIFF_DEV_URL: '', GIT_OPTIONAL_LOCKS: '0' }, timeout: 60000,
});
let page: Page | undefined;
const capture = async (page: Page, name: string) => {
  const window = await application.browserWindow(page);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // Hidden macOS windows sometimes need a transparent compositor frame.
    await window.evaluate(window => { window.setFocusable(false); window.setOpacity(0); window.setIgnoreMouseEvents(true); window.showInactive(); });
    const image = await Promise.race([
      captureWindow(application, page),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Screenshot timed out after 8 seconds.')), 8000); }),
    ]);
    await writeFile(join(artifacts, name), image);
  } finally {
    clearTimeout(deadline);
    await window.evaluate(window => window.hide()).catch(() => {});
    await window.dispose();
  }
};
const readTimings = () => application.evaluate(() => (Reflect.get(globalThis, 'largeBranchReadTimings') as BranchRead[] | undefined) ?? []);

try {
  const welcome = await application.firstWindow();
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  await hideWindow(application, welcome);
  timings.launchToWelcomeMs = milliseconds(started);
  await welcome.evaluate(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
  await application.evaluate(({ app, BrowserWindow, dialog, ipcMain }, repository) => {
    BrowserWindow.prototype.show = function () { this.webContents.setBackgroundThrottling(false); this.hide(); };
    app.on('browser-window-created', (_event, window) => {
      window.setOpacity(0); window.setIgnoreMouseEvents(true); window.setFocusable(false);
    });
    for (const window of BrowserWindow.getAllWindows()) { window.setOpacity(0); window.setIgnoreMouseEvents(true); window.setFocusable(false); window.hide(); }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] });
    type Handler = (event: import('electron').IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler> | undefined;
    const original = handlers?.get('branches:list');
    if (!original) throw new Error('Genuine branches:list handler unavailable.');
    const reads: BranchRead[] = [];
    Reflect.set(globalThis, 'largeBranchReadTimings', reads);
    ipcMain.removeHandler('branches:list');
    ipcMain.handle('branches:list', async (event, ...args: unknown[]) => {
      const start = performance.now();
      try {
        const result = await original(event, ...args) as BranchSnapshot;
        reads.push({ milliseconds: Math.round((performance.now() - start) * 10) / 10,
          count: result.branches.length, current: result.current, refs: result.branches.map(branch => branch.ref).sort() });
        return result;
      } catch (error) {
        reads.push({ milliseconds: Math.round((performance.now() - start) * 10) / 10, error: String(error) });
        throw error;
      }
    });
    // Protect the live repository if a selector ever accidentally targets an action.
    ipcMain.removeHandler('branches:run');
    ipcMain.handle('branches:run', () => { throw new Error('Git mutations and network operations are disabled by this read-only smoke.'); });
  }, repository);
  const opening = performance.now();
  page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click({ timeout: 60000 }));
  timings.openToWindowMs = milliseconds(opening);
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const window = await application.browserWindow(page);
  try { await window.evaluate(window => { window.setContentSize(1440, 980); window.hide(); }); }
  finally { await window.dispose(); }
  await expect(page.getByRole('button', { name: 'Project switcher', exact: true })).toContainText(basename(repository));
  const trigger = page.getByRole('button', { name: 'Git branches', exact: true });
  await expect(trigger).toContainText(expectedCurrent);
  timings.openToCurrentBranchMs = milliseconds(opening);
  const popup = page.getByRole('dialog', { name: 'Git branches and actions', exact: true });
  const menuStart = performance.now();
  await trigger.click();
  await expect(popup).toBeVisible();
  await expect(popup.locator('.branch-error')).toHaveCount(0);
  await expect(popup.getByText('Refreshing branches…', { exact: true })).toHaveCount(0);
  await expect.poll(() => popup.locator('.branch-row').count()).toBeGreaterThan(0);
  timings.menuReadyMs = milliseconds(menuStart);
  const renderedBranchRows = await popup.locator('.branch-row').count();
  if (currentRef) await expect(popup.locator('.branch-row-main[aria-current="true"]').first()).toContainText(expectedCurrent.split('/').at(-1)!);
  await capture(page, 'branches.png');
  console.log(`PASS: ${referenceNames.length} references loaded; ${renderedBranchRows} branch rows rendered; menu ready in ${timings.menuReadyMs} ms.`);

  const search = popup.getByRole('textbox', { name: 'Search for branches and actions', exact: true });
  const searching = performance.now();
  await search.fill(searchName);
  await expect(popup.getByRole('menuitem', { name: searchName, exact: true }).first()).toBeVisible();
  timings.searchMs = milliseconds(searching);
  await expect(popup.locator('.branch-error')).toHaveCount(0);
  await capture(page, 'branch-search.png');
  console.log(`PASS: a branch at the end of the full reference catalog is searchable in ${timings.searchMs} ms.`);

  await search.press('Escape');
  await expect(popup).toHaveCount(0);
  const beforeRefresh = (await readTimings()).length;
  const refreshing = performance.now();
  await trigger.click();
  await expect.poll(async () => (await readTimings()).length).toBeGreaterThan(beforeRefresh);
  await expect(popup.getByText('Refreshing branches…', { exact: true })).toHaveCount(0);
  await expect(popup.locator('.branch-error')).toHaveCount(0);
  timings.reopenAndRefreshMs = milliseconds(refreshing);
  await expect(trigger).toContainText(expectedCurrent);
  await expect(page.locator('.notice[role="alert"]')).toHaveCount(0);
  const reads = await readTimings();
  expect(reads.filter(read => read.error)).toEqual([]);
  // Assert exact ref membership, not only a count or the first visible rows.
  for (const read of reads) expect(read.refs).toEqual([...referenceNames].sort());
  expect(errors).toEqual([]);
  const afterIndex = await stat(indexPath);
  const observations = {
    headUnchanged: await git('rev-parse', 'HEAD') === before.head,
    indexDigestUnchanged: await hashFile(indexPath) === before.indexDigest,
    indexSizeBefore: before.index.size, indexSizeAfter: afterIndex.size,
    indexMtimeUnchanged: before.index.mtimeMs === afterIndex.mtimeMs,
  };
  // External changes to this live repository are reported, never reverted.
  expect(observations.headUnchanged).toBe(true);
  expect(observations.indexDigestUnchanged).toBe(true);
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({
    repository, profileIsolated: true, gitMutationsBlocked: true, uiChecksPassed: true,
    timings, referenceCount: referenceNames.length, renderedBranchRows,
    ipcReads: reads.map(({ refs, ...read }) => ({ ...read, referenceMembershipVerified: refs?.length === referenceNames.length })),
    rendererErrors: errors, readOnlyObservations: observations,
    screenshots: ['branches.png', 'branch-search.png'].map(name => join(artifacts, name)),
    captureMode: 'Transparent, unfocused native window, hidden again immediately after capture.',
    visualInspection: 'Pending separate rendered-image inspection.',
  }, null, 2));
  await Promise.all(['failure.txt', 'failure.png'].map(name => rm(join(artifacts, name), { force: true })));
  console.log(`PASS: menu refresh completed in ${timings.reopenAndRefreshMs} ms; all refs preserved; HEAD and index digest unchanged.`);
} catch (error) {
  await writeFile(join(artifacts, 'failure.txt'), JSON.stringify({
    message: error instanceof Error ? error.stack ?? error.message : String(error), timings,
    ipcReads: (await readTimings().catch(() => [])).map(({ refs: _refs, ...read }) => read), rendererErrors: errors,
    body: page ? await page.locator('body').innerText().catch(() => '') : undefined,
  }, null, 2));
  if (page) await capture(page, 'failure.png').catch(() => {});
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
