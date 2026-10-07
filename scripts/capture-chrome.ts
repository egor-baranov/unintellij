import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:5182';
await mkdir('artifacts/chrome', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const iconsReady = () => page.locator('img.jb-icon').evaluateAll(nodes => Promise.all(nodes.map(node => (node as HTMLImageElement).decode())));
  await page.goto(`${base}/?view=commit`);
  await page.waitForFunction(() => window.commitPreview?.viewer?.getState().status === 'ready');
  await page.getByRole('checkbox', { name: 'Include Unversioned Files in review', exact: true }).check();
  await page.getByLabel('Commit message (local draft)', { exact: true }).fill('Refine project navigation and comparison controls');
  await page.getByRole('button', { name: 'Project switcher', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Project switcher', exact: true })).toBeVisible();
  await iconsReady();
  await page.screenshot({ path: 'artifacts/chrome/project-picker-1440x960.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Diff options', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Diff options', exact: true })).toBeVisible();
  await iconsReady();
  await page.screenshot({ path: 'artifacts/chrome/diff-options-1440x960.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true }).click();
  await page.waitForFunction(() => window.projectPreview?.editor);
  await page.getByRole('button', { name: 'Project view options', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Project view options', exact: true })).toBeVisible();
  await iconsReady();
  await page.screenshot({ path: 'artifacts/chrome/project-view-1440x960.png' });
  await page.keyboard.press('Escape');
  await page.goto(`${base}/?fixture=reference`);
  await page.waitForFunction(() => window.playground?.getState().status === 'ready');
  await page.setViewportSize({ width: 900, height: 640 });
  await page.getByRole('button', { name: 'Choose fixture', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Choose fixture', exact: true })).toBeVisible();
  await iconsReady();
  await page.screenshot({ path: 'artifacts/chrome/fixture-menu-900x640.png' });
  console.log('Captured native-style app controls and menus at DPR 1 in artifacts/chrome.');
} finally { await browser.close(); }
