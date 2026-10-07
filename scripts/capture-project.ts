import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:5182';
await mkdir('artifacts/project', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`${base}/?view=project`);
  for (const folder of ['apps', 'apps/playground', 'apps/playground/src', 'apps/playground/src/components']) {
    const row = page.getByRole('treeitem', { name: folder, exact: true });
    await expect(row).toBeVisible();
    if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
  }
  await page.getByRole('treeitem', { name: 'apps/playground/src/components/RepositoryWelcome.tsx', exact: true }).click();
  await expect(page.getByTestId('file-surface').locator('.view-lines')).toContainText('RepositoryWelcomeProps');
  await page.mouse.move(600, 18);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/project/project-preview-1400x900.png' });
  await page.locator('.commit-preview-sidebar').screenshot({ path: 'artifacts/project/project-panel.png' });
  await page.setViewportSize({ width: 980, height: 720 });
  await page.evaluate(() => window.projectPreview.editor!.getAction('editor.action.toggleWordWrap')!.run());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'artifacts/project/project-preview-980x720.png' });
  console.log('Captured Project tree and file view at DPR 1 in artifacts/project.');
} finally { await browser.close(); }
