import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:5182';
await mkdir('artifacts/commit', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`${base}/?view=commit`);
  await page.waitForFunction(() => window.commitPreview?.getState().status === 'ready');
  await page.getByRole('checkbox', { name: 'Include Unversioned Files in review', exact: true }).check();
  await page.getByLabel('Commit message (local draft)', { exact: true }).fill('Refine the changes tree and diff presentation');
  await page.locator('[data-file-id="preferences"] input[type="checkbox"]').check();
  await page.getByRole('tree', { name: 'Changed files' }).evaluate(node => { node.scrollTop = 0; node.scrollLeft = 0; });
  await page.mouse.move(600, 18);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: 'artifacts/commit/commit-preview-1600x1000.png' });
  await page.locator('.commit-preview-sidebar').screenshot({ path: 'artifacts/commit/commit-panel.png' });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: 'artifacts/commit/commit-preview-1400x900.png' });
  const divider = page.getByRole('separator', { name: 'Resize diff panes', exact: true });
  const handle = (await divider.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 135, handle.y + 120, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(600, 18);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: 'artifacts/commit/resized-diff-1400x900.png' });
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await page.locator('[data-file-id="new-panel"]').click();
  await page.waitForFunction(() => window.commitPreview?.getSelected() === 'new-panel' && window.commitPreview?.getState().status === 'ready');
  await page.waitForTimeout(1600);
  await page.screenshot({ path: 'artifacts/commit/untracked-file-1400x900.png' });
  console.log('Captured interactive Commit preview at DPR 1 in artifacts/commit.');
} finally { await browser.close(); }
