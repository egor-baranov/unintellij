import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:5182';
const output = process.argv[3] ?? 'artifacts/omissions';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const manifest: object[] = [];
const variants = [
  { name: 'counts', fixture: 'counts', region: 1 },
  { name: 'unequal', fixture: 'unequal', region: 1 },
  { name: 'repeated', fixture: 'repeated', region: 2 },
  { name: 'large-original-above', fixture: 'large', region: 2, originalY: 140, modifiedY: 650 },
  { name: 'large-original-below', fixture: 'large', region: 2, originalY: 650, modifiedY: 140 },
  { name: 'wrapped', fixture: 'wrapped', region: 0, wrap: true },
];
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    for (const variant of variants) {
      await page.goto(`${base}/?fixture=omission-${variant.fixture}`);
      await expect.poll(() => page.evaluate(() => window.playground?.viewer?.getState().status)).toBe('ready');
      await page.evaluate(variant => window.playground.setPreferences({ collapse: true, sync: false, layout: 'compact', wrap: variant.wrap ?? false }), variant);
      await settle();
      const id = await page.locator('.smart-diff-omission[data-side="original"]').nth(variant.region).getAttribute('data-region-id');
      if (!id) throw new Error(`No region ${variant.region} in ${variant.fixture}`);
      if (variant.originalY !== undefined) {
        await page.evaluate(({ id, originalY, modifiedY }) => {
          const editors = window.playground.viewer!.getEditors();
          for (const side of ['original', 'modified'] as const) {
            const control = document.querySelector<HTMLButtonElement>(`.smart-diff-omission[data-region-id="${id}"][data-side="${side}"]`)!;
            editors[side].setScrollTop(editors[side].getScrollTop() + Number(control.dataset.baselineY) - (side === 'original' ? originalY! : modifiedY!));
          }
        }, { id, originalY: variant.originalY, modifiedY: variant.modifiedY });
      } else {
        await page.evaluate(() => { const editors = window.playground.viewer!.getEditors(); editors.original.setScrollTop(0); editors.modified.setScrollTop(0); });
      }
      await settle();
      await expect(page.locator(`.smart-diff-omission-path[data-region-id="${id}"]`)).toHaveCount(1);
      await page.mouse.move(8, 8);
      const name = `dpr-${dpr}-${variant.name}`;
      await page.screenshot({ path: `${output}/${name}-full.png`, animations: 'disabled', caret: 'hide' });
      const geometry = await page.locator(`.smart-diff-omission-path[data-region-id="${id}"]`).evaluate(node => {
        const path = node as SVGPathElement, matrix = path.getScreenCTM()!;
        const points = (['original', 'modified'] as const).map(side => {
          const x = Number(path.getAttribute(side === 'original' ? 'data-center-left' : 'data-center-right'));
          const y = Number(path.getAttribute(`data-${side}-y`));
          const screen = new DOMPoint(x, y).matrixTransform(matrix);
          return { x: screen.x, y: screen.y };
        });
        return { original: points[0], modified: points[1], path: path.getAttribute('d'),
          attributes: Object.fromEntries([...path.attributes].filter(attribute => attribute.name.startsWith('data-')).map(attribute => [attribute.name, attribute.value])) };
      });
      for (const side of ['original', 'modified'] as const) {
        const viewport = page.viewportSize()!, point = geometry[side], width = 260, height = 160;
        const clip = { x: Math.max(0, Math.min(viewport.width - width, point.x - width / 2)), y: Math.max(0, Math.min(viewport.height - height, point.y - height / 2)), width, height };
        await page.screenshot({ path: `${output}/${name}-${side}-join.png`, clip, animations: 'disabled', caret: 'hide' });
      }
      manifest.push({ name, dpr, variant, geometry, full: `${name}-full.png`, joins: ['original', 'modified'].map(side => `${name}-${side}-join.png`) });
    }
    await context.close();
  }
  await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`Captured ${manifest.length} omission cases with full views and both pane-to-center joins at DPR 1/2 in ${output}.`);
} finally { await browser.close(); }
