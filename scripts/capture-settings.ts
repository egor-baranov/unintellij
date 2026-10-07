import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:5182';
await mkdir('artifacts/settings', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`${base}/?view=project`);
  await page.waitForFunction(() => window.projectPreview?.editor?.getModel()?.getValueLength());
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const category = (name: string) => dialog.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name, exact: true }).click();
  const choose = async (label: string, option: string) => {
    await dialog.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  const capture = async (name: string) => {
    await page.locator('img.jb-icon').evaluateAll(nodes => Promise.all(nodes.map(node => (node as HTMLImageElement).decode())));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: `artifacts/settings/${name}.png` });
  };
  await capture('appearance-1400x900');
  await dialog.getByRole('combobox', { name: 'Theme preset', exact: true }).click();
  await capture('theme-dropdown-dark-1400x900');
  await page.keyboard.press('Escape');
  await dialog.getByRole('combobox', { name: 'UI font suggestions', exact: true }).click();
  await capture('font-suggestions-dark-1400x900');
  await page.keyboard.press('Escape');
  await category('Syntax Colors'); await capture('syntax-1400x900');
  await category('Component Themes'); await choose('Component', 'Diff highlights');
  await capture('diff-colors-1400x900');
  await dialog.getByRole('combobox', { name: 'Component', exact: true }).click();
  await capture('component-dropdown-1400x900');
  await page.keyboard.press('Escape');
  await category('Schemes'); await capture('schemes-1400x900');
  await category('Appearance'); await choose('Theme preset', 'Light');
  await capture('light-1400x900');
  await dialog.getByRole('combobox', { name: 'Theme preset', exact: true }).click();
  await capture('theme-dropdown-light-1400x900');
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await capture('light-workspace-1400x900');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await choose('Theme preset', 'Reference');
  await page.setViewportSize({ width: 950, height: 640 });
  await dialog.getByRole('spinbutton', { name: 'UI scale', exact: true }).fill('150');
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  await capture('scaled-950x640');
  await dialog.getByRole('combobox', { name: 'UI font suggestions', exact: true }).click();
  await capture('font-dropdown-scaled-950x640');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 720, height: 640 });
  await dialog.getByRole('combobox', { name: 'UI font suggestions', exact: true }).click();
  await capture('font-dropdown-scaled-720x640');
  console.log('Captured Settings categories, custom dropdowns in dark/light themes, Light workspace and 150% scale in artifacts/settings.');
} finally { await browser.close(); }
