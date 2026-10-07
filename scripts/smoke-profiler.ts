/** Real Electron telemetry smoke. Uses a disposable profile, never a user project. */
import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureWindow } from './electron-smoke-windows';

const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-profiler-'));
const profile = join(temporary, 'profile');
const output = resolve('artifacts/profiler');
await Promise.all([mkdir(profile), mkdir(output, { recursive: true })]);
await writeFile(join(profile, 'profiler-fixture.bin'), Buffer.alloc(1024 ** 2));
const bootstrap = join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
BrowserWindow.prototype.show = function () { this.webContents.setBackgroundThrottling(false); this.hide(); };
app.on('browser-window-created', (_event, window) => { window.setOpacity(0); window.setIgnoreMouseEvents(true); window.setFocusable(false); });
require(${JSON.stringify(resolve('apps/desktop/dist/index.cjs'))});
`);
const application = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], env: { ...process.env, SMART_DIFF_DEV_URL: '' } });
try {
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(window => { window.setContentSize(1440, 1000); window.webContents.setBackgroundThrottling(false); });
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  await application.evaluate(({ ipcMain }) => {
    type Handler = (event: import('electron').IpcMainInvokeEvent) => unknown;
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler>;
    const channels = ['profiler:read', 'profiler:history', 'profiler:clear-history'];
    Reflect.set(globalThis, 'profilerSmokeReads', 0);
    for (const channel of channels) {
      const original = handlers.get(channel);
      if (!original) throw new Error(`Missing ${channel} handler`);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, event => {
        Reflect.set(globalThis, 'profilerSmokeReads', Reflect.get(globalThis, 'profilerSmokeReads') + 1);
        return original(event);
      });
      let rejected = false;
      try { original({ sender: {}, senderFrame: {} } as import('electron').IpcMainInvokeEvent); } catch { rejected = true; }
      if (!rejected) throw new Error(`${channel} accepted an untrusted sender`);
    }
  });
  const calls = () => application.evaluate(() => Reflect.get(globalThis, 'profilerSmokeReads') as number);
  // No profiler read, settings tab, or renderer subscription starts the sampler.
  await page.waitForTimeout(4100);
  expect(await calls()).toBe(0);
  const startupHistory = await page.evaluate(() => window.desktop.readProfilerHistory());
  expect(startupHistory.length).toBeGreaterThanOrEqual(4);
  expect(new Set(startupHistory.map(sample => sample.timestamp)).size).toBe(startupHistory.length);
  const openedAt = Date.now();
  expect(startupHistory.every(sample => sample.timestamp < openedAt)).toBe(true);
  const first = startupHistory[0];
  const latestStartup = startupHistory.at(-1)!;
  expect(first.processes.some(process => process.type === 'Browser')).toBe(true);
  expect(latestStartup.processes.some(process => process.type === 'Tab')).toBe(true);
  expect(first.heapUsedBytes).toBeGreaterThan(0);
  expect(first.systemMemory.totalBytes).toBeGreaterThan(0);
  expect(first.gpu.utilizationPercent).toBeNull();
  expect(latestStartup.processes.find(process => process.type === 'Browser')?.cpuPercent).not.toBeNull();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Profiler', exact: true }).click();
  const panel = page.locator('.profiler-panel');
  const sampleCount = async () => Number(await panel.getAttribute('data-sample-count'));
  await expect(panel.locator('svg[role="img"]')).toHaveCount(6);
  await expect.poll(sampleCount).toBeGreaterThanOrEqual(startupHistory.length);
  const capture = async (filename: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await nativeWindow.evaluate(window => window.showInactive());
      const image = await Promise.race([captureWindow(application, page), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Profiler capture timed out')), 8000); })]);
      await writeFile(join(output, filename), image);
    } finally { clearTimeout(timer); await nativeWindow.evaluate(window => window.hide()); }
  };
  await capture('startup-history.png');
  // Real, bounded work creates a visible CPU/heap response without fake samples.
  await application.evaluate(async () => {
    Reflect.set(globalThis, 'profilerSmokeAllocation', new Uint8Array(16 * 1024 ** 2).fill(7));
    for (let i = 0; i < 5; i++) {
      const until = performance.now() + 80;
      while (performance.now() < until) Math.sqrt(performance.now());
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  });
  const sample = await page.evaluate(() => window.desktop.readProfilerSnapshot());
  expect(sample.cpuPercent).not.toBeNull();
  expect(sample.disk.status).toBe('ready');
  expect(sample.disk.bytes).toBeGreaterThanOrEqual(1024 ** 2);
  expect(sample.eventLoopDelayMs).not.toBeNull();
  expect(sample.eventLoopDelayMs).toBeGreaterThanOrEqual(0);
  if (process.platform !== 'linux') expect(sample.memoryBytes).toBeGreaterThan(0);
  await panel.getByRole('button', { name: 'Pause charts', exact: true }).click();
  const pausedReads = await calls();
  const pausedCount = await sampleCount();
  await page.waitForTimeout(2500);
  expect(await calls()).toBe(pausedReads);
  expect(await sampleCount()).toBe(pausedCount);
  const pausedHistory = await page.evaluate(() => window.desktop.readProfilerHistory());
  expect(pausedHistory.at(-1)!.timestamp).toBeGreaterThan(sample.timestamp);
  expect(pausedHistory.at(-1)!.processes.find(process => process.type === 'Browser')?.cpuPercent).not.toBeNull();
  await panel.getByRole('button', { name: 'Resume charts', exact: true }).click();
  await expect.poll(sampleCount).toBeGreaterThan(pausedCount);
  await capture('profiler-live.png');
  await panel.locator('.profiler-process-heading').scrollIntoViewIfNeeded();
  await capture('profiler-processes.png');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  const closedReads = await calls();
  const closedAt = Date.now();
  await page.waitForTimeout(3200);
  expect(await calls()).toBe(closedReads);
  const closedHistory = await page.evaluate(() => window.desktop.readProfilerHistory());
  const hiddenSamples = closedHistory.filter(sample => sample.timestamp > closedAt);
  expect(hiddenSamples.length).toBeGreaterThanOrEqual(2);
  expect(hiddenSamples.every(sample => sample.processes.find(process => process.type === 'Browser')?.cpuPercent !== null)).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Profiler', exact: true }).click();
  await expect.poll(sampleCount).toBeGreaterThanOrEqual(closedHistory.length);
  await panel.getByRole('button', { name: 'Pause charts', exact: true }).click();
  const clearedAt = Date.now();
  await panel.getByRole('button', { name: 'Clear history', exact: true }).click();
  await expect.poll(sampleCount).toBe(0);
  await page.waitForTimeout(1200);
  const afterClear = await page.evaluate(() => window.desktop.readProfilerHistory());
  expect(afterClear.length).toBeGreaterThan(0);
  expect(afterClear.every(sample => sample.timestamp >= clearedAt)).toBe(true);
  expect(afterClear.at(-1)!.processes.find(process => process.type === 'Browser')?.cpuPercent).not.toBeNull();
  await panel.getByRole('button', { name: 'Resume charts', exact: true }).click();
  await expect.poll(sampleCount).toBeGreaterThan(0);
  expect(await sampleCount()).toBeLessThan(closedHistory.length);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  expect(errors).toEqual([]);
  await writeFile(join(output, 'summary.json'), JSON.stringify({
    sample,
    startup: { samplesBeforeOpening: startupHistory.length, firstTimestamp: first.timestamp, lastTimestamp: latestStartup.timestamp, openedAt },
    background: { closedAt, samplesWhileClosed: hiddenSamples.length, latestTimestamp: closedHistory.at(-1)!.timestamp },
    cleared: { clearedAt, firstTimestamp: afterClear[0].timestamp, samplesAfterClear: afterClear.length },
    checks: ['startup sampling without profiler IPC', 'history predates settings opening', 'real Electron IPC metrics', 'all profiler channels reject untrusted senders', 'six graphs', 'known profile disk bytes', 'continuous CPU baseline', 'real main-loop delay', 'pause freezes charts only', 'close stops UI polling only', 'reopen includes background history', 'clear removes old samples without stopping sampler', 'no renderer errors'],
  }, null, 2));
  await nativeWindow.dispose();
  console.log('PASS: startup profiler history, background sampling, charts, clear lifecycle and sender validation');
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
