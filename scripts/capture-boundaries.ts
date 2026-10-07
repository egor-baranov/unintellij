import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:5182';
const output = process.argv[3] ?? 'artifacts/boundaries';
await mkdir(output, { recursive: true });
type Variant = {
  name: string; fixture: string; layout?: 'compact' | 'aligned'; collapse?: boolean;
  scale?: number; change?: 'first' | 'last' | number; counterpart?: 'above' | 'below'; scroll?: number;
};
const variants: Variant[] = [
  { name: 'single-insert', fixture: 'single-insert' },
  { name: 'single-delete', fixture: 'single-delete' },
  ...(['insert', 'delete'] as const).flatMap(fixture => (['above', 'below'] as const).map(counterpart => ({ name: `${fixture}-${counterpart}`, fixture, counterpart }))),
  { name: 'large-insert', fixture: 'large-insert' },
  { name: 'large-delete', fixture: 'large-delete' },
  { name: 'insert-aligned', fixture: 'insert', layout: 'aligned' },
  { name: 'delete-aligned', fixture: 'delete', layout: 'aligned' },
  { name: 'folds-compact', fixture: 'folds', collapse: true, change: 1 },
  { name: 'folds-aligned', fixture: 'folds', collapse: true, layout: 'aligned', change: 1 },
  { name: 'insert-fractional-above', fixture: 'insert', counterpart: 'above', scale: .875 },
  { name: 'delete-fractional-below', fixture: 'delete', counterpart: 'below', scale: .875 },
  { name: 'insert-scrolled', fixture: 'insert', counterpart: 'below', scroll: 37 },
  { name: 'delete-scrolled', fixture: 'delete', counterpart: 'above', scroll: 37 },
  { name: 'insert-bof', fixture: 'edges-insert', change: 'first' },
  { name: 'insert-eof', fixture: 'edges-insert', change: 'last' },
  { name: 'delete-bof', fixture: 'edges-delete', change: 'first' },
  { name: 'delete-eof', fixture: 'edges-delete', change: 'last' },
];
const browser = await chromium.launch();
const manifest: object[] = [];
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 720 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    for (const variant of variants) {
      await page.goto(`${base}/?fixture=boundary-${variant.fixture}`);
      await expect.poll(() => page.evaluate(() => window.playground?.viewer?.getState().status)).toBe('ready');
      await page.evaluate(variant => window.playground.setPreferences({ collapse: variant.collapse ?? false, sync: false, layout: variant.layout ?? 'compact' }), variant);
      await settle();
      const id = await page.evaluate(variant => {
        const viewer = window.playground.viewer!, changes = viewer.getComparison()!.changes;
        const index = variant.change === 'last' ? changes.length - 1 : typeof variant.change === 'number' ? variant.change : 0;
        const change = changes[index]; viewer.goToChange(change.id);
        if (variant.scale) {
          const root = document.querySelector<HTMLElement>('.smart-diff')!;
          root.style.transformOrigin = 'top left'; root.style.transform = `scale(${variant.scale})`;
          viewer.layout();
        }
        return change.id;
      }, variant);
      await settle();
      if (variant.counterpart) {
        await page.evaluate(({ id, variant }) => {
          const viewer = window.playground.viewer!, change = viewer.getComparison()!.changes.find(change => change.id === id)!;
          const empty = change.kind === 'insert' ? 'original' : 'modified';
          for (const side of ['original', 'modified'] as const) {
            const editor = viewer.getEditors()[side];
            const target = side === empty ? 120 : variant.counterpart === 'above' ? 64 : 200;
            editor.setScrollTop(Math.max(0, editor.getTopForLineNumber(change[side].start) - target + (variant.scroll ?? 0)));
          }
        }, { id, variant });
      }
      await settle();
      const ribbon = page.locator(`.smart-diff-connectors path.smart-diff-boundary[data-change-id="${id}"]`);
      await expect(ribbon).toHaveCount(1);
      await page.mouse.move(20, 20);
      const name = `dpr-${dpr}-${variant.name}`;
      await page.screenshot({ path: `${output}/${name}-full.png`, animations: 'disabled', caret: 'hide' });
      const geometry = await ribbon.evaluate(node => {
        const path = node as SVGPathElement, matrix = path.getScreenCTM()!;
        const side = path.getAttribute('data-boundary-side')!;
        const boundaryY = new DOMPoint(0, Number(path.getAttribute(`data-${side}-paint-top`))).matrixTransform(matrix).y;
        const gutter = document.querySelector('.smart-diff-gutter')!.getBoundingClientRect();
        return { boundaryY, gutter: { x: gutter.x, y: gutter.y, width: gutter.width, height: gutter.height },
          path: path.getAttribute('d'), attributes: Object.fromEntries([...path.attributes].filter(attribute => attribute.name.startsWith('data-')).map(attribute => [attribute.name, attribute.value])) };
      });
      const viewport = page.viewportSize()!, width = Math.min(viewport.width, geometry.gutter.width + 280), height = 240;
      const x = Math.max(0, Math.min(viewport.width - width, geometry.gutter.x - 140));
      const y = Math.max(geometry.gutter.y, Math.min(viewport.height - height, geometry.boundaryY - height / 2));
      await page.screenshot({ path: `${output}/${name}-junction.png`, clip: { x, y, width, height }, animations: 'disabled', caret: 'hide' });
      manifest.push({ name, dpr, variant, geometry, full: `${name}-full.png`, junction: `${name}-junction.png` });
    }
    await context.close();
  }
  await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`Captured ${manifest.length} variants (full viewer + junction) at DPR 1/2 in ${output}; fractional scale, above/below, compact/aligned, folds, scroll and file edges included.`);
} finally { await browser.close(); }
