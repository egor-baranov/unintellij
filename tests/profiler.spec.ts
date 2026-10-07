import { expect, test, type Page } from '@playwright/test';
import type { ProfilerSnapshot } from '../apps/shared/profiler/types';

const snapshot: ProfilerSnapshot = {
  timestamp: 0, uptimeSeconds: 120, cpuPercent: 12, memoryBytes: 320 * 1024 ** 2,
  heapUsedBytes: 24 * 1024 ** 2, heapTotalBytes: 48 * 1024 ** 2, eventLoopUtilization: .06, eventLoopDelayMs: 1.2,
  systemMemory: { totalBytes: 16 * 1024 ** 3, freeBytes: 4 * 1024 ** 3 },
  processes: [{ pid: 123, createdAt: 1, type: 'Browser', name: 'Main process', cpuPercent: 12, memoryBytes: 320 * 1024 ** 2 }],
  disk: { bytes: 64 * 1024 ** 2, sampledAt: 1, status: 'ready', files: 20 },
  gpu: { status: 'enabled', device: 'Test GPU', processMemoryBytes: 32 * 1024 ** 2, cpuPercent: 1, utilizationPercent: null, reason: 'GPU hardware utilization and VRAM are not exposed by Electron.' },
};

async function fixture(page: Page) {
  // A test-only bridge: the shipped browser playground never invents telemetry.
  await page.addInitScript(sample => {
    const control = { calls: 0, collected: 0, clears: 0, fail: false, unavailable: false, delay: 0, active: 0, maxActive: 0, history: [] as typeof sample[] };
    Reflect.set(window, 'profilerTest', control);
    const collect = () => {
      const count = ++control.collected;
      const timestamp = Date.now();
      control.history = [...control.history.filter(item => item.timestamp >= timestamp - 120000),
        { ...sample, timestamp, cpuPercent: control.unavailable ? null : count * 7,
          memoryBytes: control.unavailable ? null : sample.memoryBytes! + count * 1024 ** 2 }].slice(-121);
    };
    collect();
    setInterval(collect, 1000);
    Reflect.set(window, 'desktop', {
      readProfilerHistory: async () => {
        control.calls++;
        control.maxActive = Math.max(control.maxActive, ++control.active);
        const result = structuredClone(control.history);
        try {
          if (control.delay) await new Promise(resolve => setTimeout(resolve, control.delay));
          if (control.fail) throw new Error('Temporary profiler failure');
          return result;
        } finally { control.active--; }
      },
      clearProfilerHistory: async () => { control.clears++; control.history = []; },
    });
  }, snapshot);
}
async function open(page: Page) {
  await page.goto('/?view=project');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Profiler', exact: true }).click();
}
const calls = (page: Page) => page.evaluate(() => Reflect.get(window, 'profilerTest').calls as number);

test('loads startup history and pauses only charts while recording continues', async ({ page }) => {
  await fixture(page);
  await page.goto('/?view=project');
  await page.waitForTimeout(2200);
  expect(await calls(page)).toBe(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Profiler', exact: true }).click();
  const panel = page.locator('.profiler-panel');
  await expect.poll(async () => Number(await panel.getAttribute('data-sample-count'))).toBeGreaterThanOrEqual(3);
  await expect(panel.locator('svg[role="img"]')).toHaveCount(6);
  await expect.poll(() => calls(page)).toBeGreaterThanOrEqual(2);
  const value = await panel.locator('[data-metric="cpu"] .profiler-value').textContent();
  await expect(panel.locator('[data-metric="cpu"] .profiler-value')).not.toHaveText(value!);
  await panel.getByRole('button', { name: 'Pause charts', exact: true }).click();
  const paused = await calls(page);
  const collected = await page.evaluate(() => Reflect.get(window, 'profilerTest').collected as number);
  const frozen = await panel.getAttribute('data-sample-count');
  await page.waitForTimeout(1300);
  expect(await calls(page)).toBe(paused);
  await expect(panel).toHaveAttribute('data-sample-count', frozen!);
  expect(await page.evaluate(() => Reflect.get(window, 'profilerTest').collected as number)).toBeGreaterThan(collected);
  await expect(panel).toContainText('Charts paused · recording continues');
  await panel.getByRole('button', { name: 'Resume charts', exact: true }).click();
  await expect.poll(() => calls(page)).toBeGreaterThan(paused);
  await panel.getByRole('button', { name: 'Pause charts', exact: true }).click();
  await panel.getByRole('button', { name: 'Clear history', exact: true }).click();
  await expect(panel).toHaveAttribute('data-sample-count', '0');
  await page.waitForTimeout(1300);
  await panel.getByRole('button', { name: 'Resume charts', exact: true }).click();
  await expect.poll(async () => Number(await panel.getAttribute('data-sample-count'))).toBeGreaterThan(0);
  expect(await page.evaluate(() => Reflect.get(window, 'profilerTest').clears)).toBe(1);
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Files', exact: true }).click();
  const left = await calls(page);
  await page.waitForTimeout(1300);
  expect(await calls(page)).toBe(left);
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Profiler', exact: true }).click();
  await expect.poll(() => calls(page)).toBeGreaterThan(left);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  const closed = await calls(page);
  const beforeClose = await page.evaluate(() => Reflect.get(window, 'profilerTest').history.length as number);
  await page.waitForTimeout(2300);
  expect(await calls(page)).toBe(closed);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Profiler', exact: true }).click();
  await expect.poll(async () => Number(await panel.getAttribute('data-sample-count'))).toBeGreaterThan(beforeClose);
});

test('unavailable readings are not zero, errors recover and slow reads do not overlap', async ({ page }) => {
  await fixture(page);
  await open(page);
  await expect.poll(() => calls(page)).toBeGreaterThan(0);
  await page.evaluate(() => { Reflect.get(window, 'profilerTest').unavailable = true; });
  const cpu = page.locator('[data-metric="cpu"] .profiler-value');
  await expect(cpu).toHaveText(/—|unavailable/i);
  await page.evaluate(() => { Reflect.get(window, 'profilerTest').fail = true; });
  await expect(page.locator('.profiler-panel')).toContainText('Temporary profiler failure');
  await page.evaluate(() => { Reflect.get(window, 'profilerTest').fail = false; Reflect.get(window, 'profilerTest').unavailable = false; });
  await expect(cpu).toHaveText(/%/);
  await page.evaluate(() => { Reflect.get(window, 'profilerTest').delay = 2400; });
  const before = await calls(page);
  await expect.poll(() => calls(page)).toBe(before + 1);
  await page.waitForTimeout(1300);
  expect(await calls(page)).toBe(before + 1);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.waitForTimeout(2700);
  expect(await calls(page)).toBe(before + 1);
  expect(await page.evaluate(() => Reflect.get(window, 'profilerTest').maxActive)).toBe(1);
});

test('browser playground reports desktop-only telemetry instead of fake graphs', async ({ page }) => {
  await open(page);
  await expect(page.locator('.profiler-panel')).toContainText(/desktop/i);
  await expect(page.locator('.profiler-panel svg')).toHaveCount(0);
});

test('clearing history rejects an older in-flight history response', async ({ page }) => {
  await fixture(page);
  await open(page);
  const panel = page.locator('.profiler-panel');
  await expect.poll(async () => Number(await panel.getAttribute('data-sample-count'))).toBeGreaterThan(0);
  await page.evaluate(() => { Reflect.get(window, 'profilerTest').delay = 2500; });
  const before = await calls(page);
  await expect.poll(() => calls(page)).toBe(before + 1);
  await panel.getByRole('button', { name: 'Pause charts', exact: true }).click();
  await panel.getByRole('button', { name: 'Clear history', exact: true }).click();
  await expect(panel).toHaveAttribute('data-sample-count', '0');
  await page.waitForTimeout(2800);
  await expect(panel).toHaveAttribute('data-sample-count', '0');
  expect(await page.evaluate(() => Reflect.get(window, 'profilerTest').clears)).toBe(1);
  await page.evaluate(() => { Reflect.get(window, 'profilerTest').delay = 0; });
  await panel.getByRole('button', { name: 'Resume charts', exact: true }).click();
  await expect.poll(async () => Number(await panel.getAttribute('data-sample-count'))).toBeGreaterThan(0);
});

test('hidden documents stop only chart polling and narrow settings stay usable', async ({ page }) => {
  await fixture(page);
  await open(page);
  await expect.poll(() => calls(page)).toBeGreaterThan(0);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hidden = await calls(page);
  const collected = await page.evaluate(() => Reflect.get(window, 'profilerTest').collected as number);
  await page.waitForTimeout(1300);
  expect(await calls(page)).toBe(hidden);
  expect(await page.evaluate(() => Reflect.get(window, 'profilerTest').collected as number)).toBeGreaterThan(collected);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => calls(page)).toBeGreaterThan(hidden);
  await page.setViewportSize({ width: 720, height: 640 });
  const form = page.locator('.settings-form');
  expect(await form.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await page.locator('[data-metric="event-loop"]').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-metric="event-loop"] svg')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeInViewport();
});
