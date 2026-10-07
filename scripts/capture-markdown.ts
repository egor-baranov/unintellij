import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:4181';
const output = 'artifacts/markdown-preview';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`${base}/?view=project&path=docs/preview.md`);
  const surface = page.locator('.markdown-surface:visible');
  const toolbar = surface.getByRole('toolbar', { name: 'Markdown view', exact: true });
  await expect(surface.locator('article h1')).toHaveText('Project guide');
  await expect.poll(() => surface.locator('pre code span[class^="mtk"]').count()).toBeGreaterThan(2);
  await page.evaluate(() => document.fonts.ready);
  const measurements = [];
  for (const mode of ['Split', 'Code', 'Preview'] as const) {
    await toolbar.getByRole('button', { name: mode, exact: true }).click();
    await expect(surface).toHaveAttribute('data-mode', mode.toLowerCase());
    await page.mouse.move(700, 16);
    // Let Monaco's transient scrollbar fade out before taking the idle view.
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${output}/${mode.toLowerCase()}-1400x900.png` });
    measurements.push(await surface.evaluate(element => ({
      mode: element.getAttribute('data-mode'),
      code: element.querySelector('.file-surface')?.getBoundingClientRect().toJSON(),
      preview: element.querySelector('.markdown-preview')?.getBoundingClientRect().toJSON(),
      activeMonacoModels: window.projectPreview.monaco.editor.getModels().length,
    })));
  }
  const illustration = surface.getByRole('img', { name: 'Project illustration', exact: true });
  await expect.poll(() => illustration.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
  await surface.locator('.markdown-preview').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: `${output}/preview-image-checklist-1400x900.png` });
  await toolbar.getByRole('button', { name: 'Split', exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${output}/split-1000x680.png` });
  await writeFile(`${output}/measurements.json`, `${JSON.stringify(measurements, null, 2)}\n`);
  console.log(`Captured Markdown code, split, preview and narrow layouts in ${output}.`);
} finally { await browser.close(); }
