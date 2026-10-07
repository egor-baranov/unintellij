/** Visual audit of concentric shell/menu corners against actual rendered insets. */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:4181';
const output = 'artifacts/radii';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const measurements: unknown[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`${base}/?view=commit`);
  await page.waitForFunction(() => window.commitPreview?.getState().status === 'ready');
  const capture = async (name: string) => {
    await page.locator('img.jb-icon').evaluateAll(nodes => Promise.all(nodes.map(node => (node as HTMLImageElement).decode())));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: `${output}/${name}.png` });
  };
  for (const scale of [100, 150]) {
    if (scale !== 100) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      await dialog.getByRole('spinbutton', { name: 'UI scale', exact: true }).fill(String(scale));
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    }
    await capture(`workspace-${scale}`);
    await page.screenshot({ path: `${output}/bottom-corners-${scale}.png`, clip: { x: 0, y: 735, width: 1400, height: 165 } });
    const frame = await page.locator('.application').evaluate(node => {
      const outer = node.getBoundingClientRect();
      return { radius: getComputedStyle(node).borderBottomLeftRadius,
        panels: ['.commit-preview-sidebar', '.editor-workspace'].map(selector => {
          const element = node.querySelector(selector)!;
          const rect = element.getBoundingClientRect();
          return { selector, radius: getComputedStyle(element).borderBottomLeftRadius,
            leftInset: rect.left - outer.left, rightInset: outer.right - rect.right, bottomInset: outer.bottom - rect.bottom };
        }) };
    });
    expect(frame.panels[0].leftInset).toBe(frame.panels[0].bottomInset);
    expect(frame.panels[1].rightInset).toBe(frame.panels[1].bottomInset);
    for (const panel of frame.panels) expect(parseFloat(panel.radius) + panel.bottomInset).toBe(parseFloat(frame.radius));

    await page.getByRole('button', { name: 'Project switcher', exact: true }).click();
    await page.getByRole('menuitem').first().focus();
    await capture(`project-menu-${scale}`);
    const menu = await page.locator('.project-picker-menu').evaluate(node => {
      const popup = getComputedStyle(node), item = getComputedStyle(node.querySelector('.ui-menu-item')!);
      return { radius: popup.borderTopLeftRadius, padding: popup.paddingLeft, border: popup.borderLeftWidth, itemRadius: item.borderTopLeftRadius };
    });
    expect(parseFloat(menu.radius)).toBe(parseFloat(menu.itemRadius) + parseFloat(menu.padding) + parseFloat(menu.border));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.getByRole('combobox', { name: 'Theme preset', exact: true }).click();
    await capture(`settings-dropdown-${scale}`);
    const select = await page.locator('.ui-select-popup').evaluate(node => {
      const popup = getComputedStyle(node), item = getComputedStyle(node.querySelector('.ui-select-option')!);
      return { radius: popup.borderTopLeftRadius, padding: popup.paddingLeft, border: popup.borderLeftWidth, itemRadius: item.borderTopLeftRadius };
    });
    expect(parseFloat(select.radius)).toBe(parseFloat(select.itemRadius) + parseFloat(select.padding) + parseFloat(select.border));
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    measurements.push({ scale, frame, menu, select });
  }
  await writeFile(`${output}/measurements.json`, JSON.stringify(measurements, null, 2));
  console.log('Captured frame corners and popup nesting at 100% and 150% UI scale in artifacts/radii.');
} finally { await browser.close(); }
