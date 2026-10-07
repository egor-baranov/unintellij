import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:5182';
await mkdir('artifacts/workspace', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`${base}/?view=project`);
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  const primary = page.locator('section[data-group="primary"]');
  const secondary = page.locator('section[data-group="secondary"]');
  const initialPath = 'apps/playground/src/ReviewPreferencesPanel.tsx';
  for (const path of ['README.md', 'package.json']) {
    await tree.getByRole('treeitem', { name: path, exact: true }).click();
    await expect(primary.getByTestId('file-surface')).toHaveAttribute('data-path', path);
  }
  await primary.getByRole('tab', { name: initialPath, exact: true }).click();
  await expect(primary.getByTestId('file-surface')).toHaveAttribute('data-path', initialPath);
  await page.screenshot({ path: 'artifacts/workspace/tabs-1600x1000.png' });
  await primary.getByRole('button', { name: 'Editor group 1 options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Split right', exact: true }).click();
  await expect(secondary.getByTestId('file-surface')).toHaveAttribute('data-path', initialPath);
  await tree.getByRole('treeitem', { name: 'apps/playground/src/components', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'apps/playground/src/components/RepositoryWelcome.tsx', exact: true }).click();
  await expect(secondary.getByTestId('file-surface').locator('.view-lines')).toContainText('RepositoryWelcomeProps');
  await page.mouse.move(800, 18);
  await page.screenshot({ path: 'artifacts/workspace/split-right-1600x1000.png' });
  await secondary.getByRole('button', { name: 'Editor group 2 options', exact: true }).click();
  await page.screenshot({ path: 'artifacts/workspace/group-menu.png' });
  await page.getByRole('menuitem', { name: 'Split down', exact: true }).click();
  await expect(page.getByRole('separator', { name: 'Resize editor groups', exact: true })).toHaveAttribute('aria-orientation', 'horizontal');
  await page.screenshot({ path: 'artifacts/workspace/split-down-1600x1000.png' });
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true }).click();
  await expect(tree).toBeHidden();
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.screenshot({ path: 'artifacts/workspace/sidebar-hidden-1000x760.png' });
  console.log('Captured code tabs, editor splits, group menu, and collapsed sidebar in artifacts/workspace.');
} finally { await browser.close(); }
