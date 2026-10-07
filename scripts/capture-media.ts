import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:5182';
await mkdir('artifacts/media', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  const surface = page.getByTestId('media-surface');
  const capture = async (name: string) => {
    await page.locator('img').evaluateAll(nodes => Promise.all(nodes.map(node => (node as HTMLImageElement).decode())));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: `artifacts/media/${name}.png` });
  };
  await page.goto(`${base}/?view=project&path=artifacts/sample.png`);
  await expect(surface.getByRole('img')).toBeVisible();
  await capture('project-image-1400x900');
  await page.goto(`${base}/?view=commit&file=image-modified`);
  await expect(surface.getByRole('img')).toHaveCount(2);
  await expect(surface.getByRole('img').first()).toBeVisible();
  await capture('image-comparison-1400x900');
  await page.setViewportSize({ width: 850, height: 620 });
  await capture('image-comparison-850x620');
  await page.goto(`${base}/?view=project&path=artifacts/demo.webm`);
  await expect.poll(() => surface.locator('video').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
  await capture('video-850x620');
  console.log('Captured image previews, comparison and video in artifacts/media.');
} finally { await browser.close(); }
