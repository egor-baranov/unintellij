import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Page } from '@playwright/test';

// Capture the real application, including workers and Monaco, at a known scale.
// Start dev:playground or a production preview, then pass its URL as argument 1.
const base = process.argv[2] ?? 'http://127.0.0.1:5182';
const output = 'artifacts/presentation';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
async function settle(page: Page) {
  await page.waitForFunction(() => window.playground?.getState().status === 'ready');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  // Monaco briefly displays its scroll thumbs after layout. Capture the idle
  // presentation after their normal fade, without changing the actual styles.
  await page.waitForTimeout(1600);
}
try {
  await page.goto(`${base}/?fixture=reference`);
  await settle(page);
  await page.screenshot({ path: `${output}/reference-1400x900.png` });
  await page.screenshot({ path: `${output}/center-numbers-and-bands.png`, clip: { x: 520, y: 70, width: 360, height: 680 } });
  const toolbar = await page.locator('.editor-toolbar').first().boundingBox();
  if (toolbar) await page.screenshot({ path: `${output}/toolbar-editor-join.png`, clip: { ...toolbar, height: toolbar.height + 64 } });
  const separator = await page.locator('.smart-diff-pane[data-side="original"] .smart-diff-omission:visible').first().boundingBox();
  if (separator) await page.screenshot({ path: `${output}/omission-separator.png`, clip: { x: 0, y: Math.max(0, separator.y - 22), width: 850, height: 64 } });
  const measurements = await page.evaluate(() => {
    const viewer = window.playground.viewer!, editors = viewer.getEditors();
    const font = editors.original.getOption(window.playground.monaco.editor.EditorOption.fontInfo);
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      gutterWidth: document.querySelector('.smart-diff-gutter')!.getBoundingClientRect().width,
      toolbarHeight: document.querySelector('.topbar')!.getBoundingClientRect().height,
      toolbarEditorGap: document.querySelector('.smart-diff')!.getBoundingClientRect().top - document.querySelector('.editor-toolbar')!.getBoundingClientRect().bottom,
      font: { fontFamily: font.fontFamily, fontSize: font.fontSize, lineHeight: font.lineHeight, fontWeight: font.fontWeight, letterSpacing: font.letterSpacing },
      modelLines: { original: editors.original.getModel()!.getLineCount(), modified: editors.modified.getModel()!.getLineCount() },
      changeCount: viewer.getComparison()!.changes.length,
      collapsedRegionCount: document.querySelectorAll('.smart-diff-pane[data-side="original"] .smart-diff-omission').length,
    };
  });
  // CSS font-family alone doesn't prove which font supplied the rendered glyphs.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.smart-diff-pane .view-line span' });
  const platformFonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  await writeFile(`${output}/measurements.json`, JSON.stringify({ ...measurements, actualRenderedFonts: platformFonts.fonts }, null, 2) + '\n');
  await page.evaluate(() => {
    const viewer = window.playground.viewer!;
    const changes = viewer.getComparison()!.changes;
    viewer.goToChange(changes[changes.length - 1].id);
  });
  await settle(page);
  await page.screenshot({ path: `${output}/reference-jsx-1400x900.png` });
  const band = await page.locator('.smart-diff-connectors .connector-insert').first().boundingBox();
  if (band) {
    const top = Math.max(67, band.y - 24), bottom = Math.min(900, band.y + band.height + 24);
    await page.screenshot({ path: `${output}/unequal-insertion-band.png`, clip: { x: band.x - 100, y: top, width: band.width + 200, height: bottom - top } });
  }
  await page.goto(`${base}/?fixture=tsx`); await settle(page);
  await page.screenshot({ path: `${output}/short-tsx-1400x900.png` });
  await page.screenshot({ path: `${output}/inline-highlights.png`, clip: { x: 0, y: 210, width: 1400, height: 350 } });
  await page.setViewportSize({ width: 900, height: 640 });
  await page.goto(`${base}/?fixture=reference`); await settle(page);
  await page.screenshot({ path: `${output}/reference-900x640.png` });
  await page.evaluate(() => window.playground.setPreferences({ wrap: true })); await settle(page);
  await page.screenshot({ path: `${output}/reference-wrapped-900x640.png` });
  console.log(JSON.stringify({ output, ...measurements, actualRenderedFonts: platformFonts.fonts }, null, 2));
} finally { await browser.close(); }
