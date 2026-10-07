import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

type Side = 'original' | 'modified';
type FrameSample = { frame: number; left: number; scroll: number[]; hunks: number; omissions: number; maxDeviation: number; errors: string[] };
declare global {
  interface Window { frameSyncProbe?: { stop: () => FrameSample[] } }
}

async function paint(page: Page) {
  // A task queued by rAF runs after all callbacks for that frame. Reading from
  // an earlier rAF callback could incorrectly reject work that paints later in
  // the very same frame. No extra animation frame is allowed for convergence.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))));
}

async function open(page: Page, sync: boolean, layout: 'compact' | 'aligned') {
  await page.goto('/?fixture=omission-wrapped');
  await expect.poll(() => page.evaluate(() => window.playground?.viewer?.getState().status)).toBe('ready');
  await page.evaluate(preferences => window.playground.setPreferences({ collapse: true, wrap: true, ...preferences }), { sync, layout });
  await expect(page.locator('.smart-diff-omission-path')).not.toHaveCount(0);
  await paint(page); await paint(page);
}

async function beginSampling(page: Page) {
  await page.evaluate(() => {
    const samples: FrameSample[] = [];
    const controls = [...document.querySelectorAll<HTMLButtonElement>('.smart-diff-omission')];
    let running = true, frame = 0, scheduled = 0;
    const sample = () => {
      const viewer = window.playground.viewer!, editors = viewer.getEditors();
      const overlay = document.querySelector<SVGSVGElement>('.smart-diff-connectors')!;
      const gutter = document.querySelector<SVGSVGElement>('.smart-diff-gutter')!;
      const matrix = overlay.getScreenCTM()!;
      const overlayBox = overlay.getBoundingClientRect(), gutterBox = gutter.getBoundingClientRect();
      const left = (gutterBox.left - overlayBox.left) / matrix.a;
      const right = (gutterBox.right - overlayBox.left) / matrix.a;
      const errors: string[] = [];
      let maxDeviation = 0;
      for (const control of controls) {
        if (!control.isConnected) errors.push(`${control.dataset.regionId} ${control.dataset.side} omission control was replaced during geometry-only input`);
      }
      const close = (label: string, actual: number, expected: number, tolerance = .75) => {
        if (Number.isFinite(actual)) maxDeviation = Math.max(maxDeviation, Math.abs(actual - expected));
        if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) errors.push(`${label}: ${actual.toFixed(2)} vs ${expected.toFixed(2)}`);
      };
      const changes = new Map(viewer.getComparison()!.changes.map(change => [change.id, change]));
      const paths = [...overlay.querySelectorAll<SVGPathElement>('path[data-change-id]')];
      for (const path of paths) {
        const change = changes.get(path.dataset.changeId!)!;
        const values = (path.getAttribute('d')!.match(/-?(?:\d*\.?\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
        // The two cubic endpoints must move with the actual gutter rectangle.
        close(`${change.id} original join x`, values[2], left + 48);
        close(`${change.id} modified join x`, values[7], right - 48);
        for (const side of ['original', 'modified'] as const) {
          const editor = editors[side], range = change[side], count = editor.getModel()!.getLineCount();
          const top = (range.start > count ? editor.getBottomForLineNumber(count) : editor.getTopForLineNumber(range.start)) - editor.getScrollTop();
          const bottom = range.end === range.start ? top : Math.max(top, editor.getBottomForLineNumber(range.end - 1) - editor.getScrollTop());
          close(`${change.id} ${side} top`, Number(path.getAttribute(`data-${side}-top`)), top);
          close(`${change.id} ${side} bottom`, Number(path.getAttribute(`data-${side}-bottom`)), bottom);
          // Verify the painted path itself, including the finite empty-side marker.
          const boundary = range.start === range.end;
          close(`${change.id} ${side} painted top`, values[side === 'original' ? 1 : 8], top - (boundary ? 2 : 0));
          close(`${change.id} ${side} painted bottom`, values[side === 'original' ? 17 : 10], bottom + (boundary ? 2 : 0));
        }
      }
      const omissions = [...overlay.querySelectorAll<SVGPathElement>('.smart-diff-omission-path')];
      for (const path of omissions) {
        const id = path.dataset.regionId!;
        const curves = [...path.getAttribute('d')!.matchAll(/C ([^MC]+)/g)].map(match => match[1].trim().split(/\s+/).map(Number));
        const centerIndex = curves.findIndex(curve => Math.abs(curve[4] - Number(path.dataset.centerRight)) < .001);
        const center = curves[centerIndex], beforeCenter = curves[centerIndex - 1];
        close(`${id} painted original omission join x`, beforeCenter?.[4] ?? NaN, left + 48);
        close(`${id} painted modified omission join x`, center?.[4] ?? NaN, right - 48);
        close(`${id} original omission join x`, Number(path.dataset.centerLeft), left + 48);
        close(`${id} modified omission join x`, Number(path.dataset.centerRight), right - 48);
        for (const side of ['original', 'modified'] as const) {
          const editor = editors[side];
          const button = document.querySelector<HTMLButtonElement>(`.smart-diff-omission[data-region-id="${id}"][data-side="${side}"]`)!;
          const end = Number(path.getAttribute(`data-${side}-end`));
          const rowHeight = parseFloat(button.style.height);
          const offset = (editor.getContainerDomNode().getBoundingClientRect().top - overlayBox.top) / matrix.d;
          // This fixture keeps context after each fold, so the next visible
          // line independently identifies the bottom of its omission zone.
          const expected = editor.getTopForLineNumber(end) - editor.getScrollTop() - rowHeight / 2 + offset;
          close(`${id} ${side} painted omission y`, side === 'original' ? beforeCenter?.[5] ?? NaN : center?.[5] ?? NaN, expected);
          close(`${id} ${side} omission y`, Number(path.getAttribute(`data-${side}-y`)), expected);
          close(`${id} ${side} control y`, parseFloat(button.style.top) + rowHeight / 2 + offset, expected);
        }
      }
      for (const node of document.querySelectorAll<SVGTextElement>('.smart-diff-line-number')) {
        const editor = editors[node.dataset.numberSide as Side], lineNumber = Number(node.dataset.lineNumber);
        close(`line ${lineNumber} ${node.dataset.numberSide}`, Number(node.getAttribute('y')),
          editor.getTopForLineNumber(lineNumber) - editor.getScrollTop() + editor.getLineHeightForPosition({ lineNumber, column: 1 }) / 2);
      }
      samples.push({ frame: frame++, left, scroll: [editors.original.getScrollTop(), editors.modified.getScrollTop()], hunks: paths.length, omissions: omissions.length, maxDeviation, errors });
    };
    const tick = () => {
      if (!running) return;
      setTimeout(() => { if (running) sample(); }, 0);
      scheduled = requestAnimationFrame(tick);
    };
    scheduled = requestAnimationFrame(tick);
    window.frameSyncProbe = { stop: () => { running = false; cancelAnimationFrame(scheduled); return samples; } };
  });
}

async function finishSampling(page: Page, motion: 'split' | Side) {
  await paint(page);
  const samples = await page.evaluate(() => window.frameSyncProbe!.stop());
  const report = test.info().outputPath('painted-frame-geometry.json');
  await writeFile(report, JSON.stringify({
    test: test.info().title,
    sampledFrames: samples.length, mismatchedFrames: samples.filter(sample => sample.errors.length).length,
    maximumDeviationPx: Math.max(...samples.map(sample => sample.maxDeviation)), samples,
  }, null, 2));
  await test.info().attach('painted-frame-geometry.json', { path: report, contentType: 'application/json' });
  expect(samples.length, 'Every drag must sample multiple rendered frames').toBeGreaterThan(3);
  expect(samples.some(sample => sample.hunks > 0), 'The drag exercised painted change ribbons').toBe(true);
  expect(samples.some(sample => sample.omissions > 0), 'The drag exercised painted folded boundaries').toBe(true);
  const positions = samples.map(sample => motion === 'split' ? sample.left : sample.scroll[motion === 'original' ? 0 : 1]);
  expect(Math.max(...positions) - Math.min(...positions), 'The gesture changed the sampled geometry').toBeGreaterThan(20);
  const failures = samples.filter(sample => sample.errors.length).slice(0, 3).map(sample => ({ ...sample, errors: sample.errors.slice(0, 8) }));
  expect(failures, 'Overlay geometry must match both editors in every painted frame, including frames while the pointer remains held').toEqual([]);
}

for (const layout of ['compact', 'aligned'] as const) for (const sync of [false, true]) {
  test(`${layout} wrapped folded overlays follow every divider drag frame with synchronized scrolling ${sync ? 'on' : 'off'}`, async ({ page }) => {
    await open(page, sync, layout);
    await page.evaluate(() => window.playground.viewer!.getEditors().modified.setScrollTop(180));
    await paint(page); await paint(page);
    const handle = page.getByRole('separator', { name: 'Resize diff panes', exact: true });
    const box = (await handle.boundingBox())!, x = box.x + box.width / 2, y = box.y + 130;
    await page.mouse.move(x, y); await page.mouse.down();
    await beginSampling(page);
    for (const delta of [-30, -65, -100, -135, -170, -205, -160, -115, -70, -25, 20, 65]) {
      await page.mouse.move(x + delta, y);
      await paint(page);
    }
    // Retain the held pointer until all moving-frame measurements are captured.
    await finishSampling(page, 'split');
    await page.mouse.up();
  });

  for (const side of ['original', 'modified'] as const) {
    test(`${layout} wrapped folded overlays follow ${side} scrollbar frames with synchronized scrolling ${sync ? 'on' : 'off'}`, async ({ page }) => {
      await open(page, sync, layout);
      const thumb = page.locator(`.smart-diff-pane[data-side="${side}"] .scrollbar.vertical .slider`);
      await expect(thumb).toBeVisible();
      const box = (await thumb.boundingBox())!, x = box.x + box.width / 2, y = box.y + Math.min(12, box.height / 2);
      await page.mouse.move(x, y); await page.mouse.down();
      await beginSampling(page);
      for (const delta of [8, 16, 24, 32, 40, 48, 56, 64, 56, 48, 40, 32]) {
        await page.mouse.move(x, y + delta);
        await paint(page);
      }
      await finishSampling(page, side);
      await page.mouse.up();
    });
  }
}
