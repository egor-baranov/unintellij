import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:5182';
await mkdir('artifacts/branches', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${base}/?view=project`);
  await page.getByRole('button', { name: 'Git branches', exact: true }).click();
  const branch = page.getByRole('menuitem', { name: 'feature/compact-gutter', exact: true }).first();
  await expect(branch).toBeVisible();
  await page.locator('img.jb-icon').evaluateAll(nodes => Promise.all(nodes.map(node => (node as HTMLImageElement).decode())));
  await page.screenshot({ path: 'artifacts/branches/popup-1400x900.png' });
  await branch.click();
  const compare = page.getByRole('menuitem', { name: 'Show Diff with Working Tree', exact: true });
  await expect(compare).toBeVisible();
  await page.screenshot({ path: 'artifacts/branches/submenu-1400x900.png' });
  await compare.click();
  await expect(page.locator('.branch-comparison .smart-diff')).toHaveAttribute('data-status', 'ready');
  await page.screenshot({ path: 'artifacts/branches/comparison-1400x900.png' });
  await page.getByRole('button', { name: 'Close branch comparison' }).click();
  await page.setViewportSize({ width: 800, height: 600 });
  await page.getByRole('button', { name: 'Git branches', exact: true }).click();
  await page.getByPlaceholder('Search for branches and actions').fill('compact');
  await branch.click();
  await expect(compare).toBeVisible();
  await page.screenshot({ path: 'artifacts/branches/submenu-800x600.png' });
  console.log('Captured production branch menu, action submenu and actual diff view.');
} finally { await browser.close(); }
