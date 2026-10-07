import { expect, test, type Page } from '@playwright/test';
import { oneSidedFixtures } from '../apps/playground/src/one-sided-fixtures';

type Side = 'original' | 'modified';
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const viewer = window.playground?.viewer, comparison = viewer?.getComparison(), editors = viewer?.getEditors();
    return viewer?.getState().status === 'ready' && comparison?.originalVersion === editors?.original.getModel()?.getVersionId() && comparison?.modifiedVersion === editors?.modified.getModel()?.getVersionId();
  })).toBe(true);
  await settle(page);
}
async function preferences(page: Page, preferences: Parameters<Window['playground']['setPreferences']>[0]) {
  await page.evaluate(value => window.playground.setPreferences(value), preferences); await ready(page);
}
async function open(page: Page, fixture: string) {
  await page.goto(`/?fixture=boundary-${fixture}`); await ready(page);
  await preferences(page, { collapse: false, sync: false });
}
async function changes(page: Page) { return page.evaluate(() => window.playground.viewer!.getComparison()!.changes); }
async function reveal(page: Page, id: string) {
  await page.evaluate(id => window.playground.viewer!.goToChange(id), id); await settle(page);
}

/** Public Monaco geometry and actual SVG path samples are independent of the
 * paint metadata. A semantic boundary remains empty while its one filled ribbon
 * has finite paint thickness, including under a scaled ancestor. */
async function boundaryGeometry(page: Page, id: string, side: Side) {
  const ribbon = page.locator(`.smart-diff-connectors path.connector.smart-diff-boundary[data-change-id="${id}"][data-boundary-side="${side}"]`);
  await expect(ribbon).toHaveCount(1);
  await expect(page.locator('line.smart-diff-boundary, .smart-diff-boundaries')).toHaveCount(0);
  await expect.poll(() => page.evaluate(({ id, side }) => {
    const viewer = window.playground.viewer!, editor = viewer.getEditors()[side], model = editor.getModel()!;
    const change = viewer.getComparison()!.changes.find(change => change.id === id)!;
    const range = change[side], fullSide = side === 'original' ? 'modified' : 'original';
    const fullEditor = viewer.getEditors()[fullSide], fullRange = change[fullSide];
    const pane = document.querySelector<HTMLElement>(`.smart-diff-pane[data-side="${side}"]`)!.getBoundingClientRect();
    const gutter = document.querySelector<SVGSVGElement>('.smart-diff-gutter')!.getBoundingClientRect();
    const path = document.querySelector<SVGPathElement>(`.smart-diff-connectors path[data-change-id="${id}"]`)!;
    const matrix = path?.getScreenCTM();
    if (!matrix) return false;
    const attr = (name: string) => Number(path.getAttribute(`data-${side}-${name}`));
    const y = (range.start > model.getLineCount() ? editor.getBottomForLineNumber(model.getLineCount()) : editor.getTopForLineNumber(range.start)) - editor.getScrollTop();
    const paintTop = attr('paint-top'), paintBottom = attr('paint-bottom');
    const screenTop = new DOMPoint(0, paintTop).matrixTransform(matrix).y;
    const screenBottom = new DOMPoint(0, paintBottom).matrixTransform(matrix).y;
    // Four local CSS pixels, rounded as one strip to the nearest device pixel
    // under fractional host scaling. Both edges share the same snapped center.
    const thicknessInPixels = Math.max(1, Math.round(4 * matrix.d * devicePixelRatio));
    const expectedScreenThickness = thicknessInPixels / devicePixelRatio;
    const fullTop = fullEditor.getTopForLineNumber(fullRange.start) - fullEditor.getScrollTop();
    const fullBottom = fullEditor.getBottomForLineNumber(fullRange.end - 1) - fullEditor.getScrollTop();
    const edge = path.getBBox(), inverse = matrix.inverse();
    const curveStart = new DOMPoint(gutter.left, gutter.top).matrixTransform(inverse).x + 48;
    const curveEnd = new DOMPoint(gutter.right, gutter.top).matrixTransform(inverse).x - 48;
    const endpointYs: number[] = [], total = path.getTotalLength();
    for (let step = 0; step <= 6000; step++) {
      const point = path.getPointAtLength(total * step / 6000);
      if (side === 'original' ? point.x < curveStart - 1 : point.x > curveEnd + 1) endpointYs.push(point.y);
    }
    const actualEdge = new DOMPoint(side === 'original' ? edge.x : edge.x + edge.width, 0).matrixTransform(matrix).x;
    const style = getComputedStyle(path);
    return range.start === range.end
      && path.getAttribute(`data-${side}-kind`) === 'boundary'
      && Math.abs(attr('top') - y) < .01 && Math.abs(attr('bottom') - y) < .01
      && Math.abs(screenBottom - screenTop - expectedScreenThickness) < .01
      && Math.abs((screenTop + screenBottom) / 2 - (pane.top + y * matrix.d)) <= .5 / devicePixelRatio + .01
      && Math.abs(screenTop * devicePixelRatio - Math.round(screenTop * devicePixelRatio)) < .02
      && Math.abs(screenBottom * devicePixelRatio - Math.round(screenBottom * devicePixelRatio)) < .02
      && ['top', 'paint-top'].every(edge => Math.abs(Number(path.getAttribute(`data-${fullSide}-${edge}`)) - fullTop) < .01)
      && ['bottom', 'paint-bottom'].every(edge => Math.abs(Number(path.getAttribute(`data-${fullSide}-${edge}`)) - fullBottom) < .01)
      && Math.abs(actualEdge - (side === 'original' ? pane.left : pane.right)) < .1
      && endpointYs.length > 1 && Math.abs(Math.min(...endpointYs) - paintTop) < .02
      && Math.abs(Math.max(...endpointYs) - paintBottom) < .02
      && style.fill !== 'none' && style.stroke === 'none' && Number(style.opacity) > 0;
  }, { id, side })).toBe(true);
}

/** Walk the actual path commands to verify tangent continuity at both ends,
 * including the reverse boundary. This catches a kink even if metadata agrees. */
async function horizontalTangents(page: Page, id: string) {
  const curves = await page.locator(`.smart-diff-connectors path[data-change-id="${id}"]`).evaluate(node => {
    const tokens = (node.getAttribute('d') ?? '').match(/[A-Za-z]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/g) ?? [];
    const curves: { start: number[]; first: number[]; second: number[]; end: number[] }[] = [];
    let x = 0, y = 0, index = 0;
    const number = () => Number(tokens[index++]);
    while (index < tokens.length) {
      const command = tokens[index++];
      if (command === 'M' || command === 'L') { x = number(); y = number(); }
      else if (command === 'H') x = number();
      else if (command === 'V') y = number();
      else if (command === 'C') {
        const first = [number(), number()], second = [number(), number()], end = [number(), number()];
        curves.push({ start: [x, y], first, second, end }); [x, y] = end;
      } else if (command !== 'Z') throw new Error(`Unexpected ribbon command: ${command}`);
    }
    return curves;
  });
  expect(curves).toHaveLength(2);
  for (const curve of curves) {
    expect(curve.first[1]).toBeCloseTo(curve.start[1], 6);
    expect(curve.second[1]).toBeCloseTo(curve.end[1], 6);
    const direction = Math.sign(curve.end[0] - curve.start[0]);
    expect(direction * (curve.first[0] - curve.start[0])).toBeGreaterThan(0);
    expect(direction * (curve.end[0] - curve.second[0])).toBeGreaterThan(0);
    expect(direction * (curve.second[0] - curve.first[0])).toBeGreaterThanOrEqual(0);
  }
}
async function visibleGeometry(page: Page) {
  const visible = await page.locator('path.smart-diff-boundary').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-change-id')!, side: node.getAttribute('data-boundary-side')! as Side })));
  expect(visible.length).toBeGreaterThan(0);
  for (const item of visible) await boundaryGeometry(page, item.id, item.side);
}

for (const suffix of ['single-insert', 'single-delete', 'insert', 'delete', 'large-insert', 'large-delete']) {
  test(`${suffix} uses a zero-height empty-side boundary and a filled changed block`, async ({ page }) => {
    await open(page, suffix);
    const comparison = await changes(page); expect(comparison).toHaveLength(1);
    const change = comparison[0], emptySide: Side = change.kind === 'insert' ? 'original' : 'modified', fullSide: Side = emptySide === 'original' ? 'modified' : 'original';
    expect(change[emptySide].end).toBe(change[emptySide].start);
    expect(change[fullSide].end - change[fullSide].start).toBe(suffix.startsWith('large') ? 60 : suffix.startsWith('single') ? 1 : 3);
    await reveal(page, change.id); await boundaryGeometry(page, change.id, emptySide);
    await expect(page.locator(`.smart-diff-boundary[data-change-id="${change.id}"][data-boundary-side="${fullSide}"]`)).toHaveCount(0);
    const painted = await page.evaluate(({ emptySide, fullSide }) => {
      const editors = window.playground.viewer!.getEditors();
      const blocks = (side: Side) => editors[side].getModel()!.getAllDecorations().filter(decoration => decoration.options.isWholeLine && decoration.options.className?.includes('smart-diff-line-')).length;
      return [blocks(emptySide), blocks(fullSide)];
    }, { emptySide, fullSide });
    expect(painted[0]).toBe(0); expect(painted[1]).toBeGreaterThan(0);
    const connector = page.locator(`.connector[data-change-id="${change.id}"]`);
    await expect(connector).toHaveAttribute(`data-${fullSide}-kind`, 'block');
    const height = Number(await connector.getAttribute(`data-${fullSide}-bottom`)) - Number(await connector.getAttribute(`data-${fullSide}-top`));
    expect(height).toBeGreaterThan(0);
    await expect(page.locator('.smart-diff-connectors')).toHaveCSS('pointer-events', 'none');
    await horizontalTangents(page, change.id);
    await expect(page.locator('.smart-diff-spacer')).toHaveCount(0);
    const source = oneSidedFixtures.find(fixture => fixture.id === `boundary-${suffix}`)!;
    expect(await page.evaluate(() => {
      const editors = window.playground.viewer!.getEditors();
      return [editors.original.getModel()!.getValue(), editors.modified.getModel()!.getValue()];
    })).toEqual([source.original, source.modified]);
  });
}

for (const suffix of ['edges-insert', 'edges-delete', 'empty-original', 'empty-modified']) {
  test(`${suffix} retains precise file-start and file-end boundary positions`, async ({ page }) => {
    await open(page, suffix);
    const comparison = await changes(page);
    expect(comparison).toHaveLength(suffix.startsWith('edges') ? 2 : 1);
    for (const change of comparison) {
      const side: Side = change.kind === 'insert' ? 'original' : 'modified';
      await reveal(page, change.id); await boundaryGeometry(page, change.id, side);
    }
    if (suffix.startsWith('empty')) {
      const side: Side = suffix === 'empty-original' ? 'original' : 'modified';
      expect(await page.evaluate(side => window.playground.viewer!.getEditors()[side].getModel()!.getValue(), side)).toBe('');
      expect(comparison[0][side]).toEqual({ start: 1, end: 1 });
    }
    expect(await page.locator('.connector').evaluateAll(paths => paths.every(path => !/NaN|Infinity/.test(path.getAttribute('d') ?? '')))).toBe(true);
  });
}

test('actual inserted and deleted blank lines remain blocks, while mixed replacements stay two-sided', async ({ page }) => {
  for (const suffix of ['blank-insert', 'blank-delete']) {
    await open(page, suffix);
    const [change] = await changes(page), empty: Side = change.kind === 'insert' ? 'original' : 'modified', full: Side = empty === 'original' ? 'modified' : 'original';
    expect(change[full].end - change[full].start).toBe(1);
    expect(await page.evaluate(({ side, line }) => window.playground.viewer!.getEditors()[side].getModel()!.getLineContent(line), { side: full, line: change[full].start })).toBe('');
    await reveal(page, change.id); await boundaryGeometry(page, change.id, empty);
    await expect(page.locator(`.connector[data-change-id="${change.id}"]`)).toHaveAttribute(`data-${full}-kind`, 'block');
  }
  await open(page, 'nearby');
  const comparison = await changes(page); expect(comparison.map(change => change.kind)).toEqual(['insert', 'delete', 'replace']);
  for (const change of comparison) {
    await reveal(page, change.id);
    if (change.kind === 'replace') {
      await expect(page.locator(`.smart-diff-boundary[data-change-id="${change.id}"]`)).toHaveCount(0);
      for (const side of ['original', 'modified']) await expect(page.locator(`.connector[data-change-id="${change.id}"]`)).toHaveAttribute(`data-${side}-kind`, 'block');
    } else await boundaryGeometry(page, change.id, change.kind === 'insert' ? 'original' : 'modified');
  }
});

test('fold expansion and navigation keep omission separators distinct from empty-side boundaries', async ({ page }) => {
  await open(page, 'folds'); await preferences(page, { collapse: true });
  await expect(page.locator('.smart-diff-omission')).not.toHaveCount(0);
  const comparison = await changes(page);
  for (const change of comparison) { await reveal(page, change.id); await boundaryGeometry(page, change.id, change.kind === 'insert' ? 'original' : 'modified'); }
  await reveal(page, comparison[0].id);
  const omission = page.locator('[data-side="original"] .smart-diff-omission').first();
  const id = await omission.getAttribute('data-region-id');
  await omission.click();
  await expect(page.locator(`.smart-diff-omission[data-region-id="${id}"]`)).toHaveCount(0);
  await settle(page); await visibleGeometry(page);
  for (const change of comparison) { await reveal(page, change.id); await boundaryGeometry(page, change.id, change.kind === 'insert' ? 'original' : 'modified'); }
});

test('wrapping, horizontal scroll, resize and font changes use rendered boundary geometry', async ({ page }) => {
  await open(page, 'wrap'); await preferences(page, { wrap: true });
  const [change] = await changes(page);
  await reveal(page, change.id); await boundaryGeometry(page, change.id, 'original');
  await page.setViewportSize({ width: 920, height: 620 });
  await reveal(page, change.id); await boundaryGeometry(page, change.id, 'original');
  await page.evaluate(() => window.playground.viewer!.updateOptions({ editorOptions: { fontSize: 19, lineHeight: 31 } }));
  await settle(page); await reveal(page, change.id); await boundaryGeometry(page, change.id, 'original');
  await preferences(page, { wrap: false });
  await reveal(page, change.id);
  const before = await page.locator(`.smart-diff-boundary[data-change-id="${change.id}"]`).boundingBox();
  await page.evaluate(() => { const editors = window.playground.viewer!.getEditors(); editors.original.setScrollLeft(460); editors.modified.setScrollLeft(280); });
  await settle(page); await boundaryGeometry(page, change.id, 'original');
  const after = await page.locator(`.smart-diff-boundary[data-change-id="${change.id}"]`).boundingBox();
  expect(after?.x).toBeCloseTo(before!.x, 1); expect(after?.width).toBeCloseTo(before!.width, 1);
});

test('aligned spacer zones do not inflate empty ranges and switching layout retains exact anchors', async ({ page }) => {
  await open(page, 'large-insert');
  const [change] = await changes(page);
  await preferences(page, { layout: 'aligned' });
  await expect(page.locator('.smart-diff-spacer')).not.toHaveCount(0);
  await reveal(page, change.id); await boundaryGeometry(page, change.id, 'original');
  expect((await changes(page))[0].original).toEqual(change.original);
  await preferences(page, { layout: 'compact' });
  await expect(page.locator('.smart-diff-spacer')).toHaveCount(0);
  await reveal(page, change.id); await boundaryGeometry(page, change.id, 'original');
});

test('consumer view zones move the shared boundary and connector without adding model lines', async ({ page }) => {
  await open(page, 'single-insert');
  const [change] = await changes(page);
  const zone = await page.evaluate(() => {
    const viewer = window.playground.viewer!, editor = viewer.getEditors().original;
    const boundary = viewer.getComparison()!.changes[0].original.start;
    let id = '';
    editor.changeViewZones(accessor => {
      id = accessor.addZone({ afterLineNumber: boundary - 1, heightInPx: 17, domNode: document.createElement('div') });
    });
    return id;
  });
  await boundaryGeometry(page, change.id, 'original');
  await page.evaluate(id => window.playground.viewer!.getEditors().original.changeViewZones(accessor => accessor.removeZone(id)), zone);
  await boundaryGeometry(page, change.id, 'original');
});

test('either scroll leader updates boundary geometry without feedback oscillation', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 480 });
  await open(page, 'folds'); await preferences(page, { sync: true });
  const editorsScroll = () => page.evaluate(() => { const editors = window.playground.viewer!.getEditors(); return [editors.original.getScrollTop(), editors.modified.getScrollTop()]; });
  await page.locator('.smart-diff-pane[data-side="original"]').hover();
  await page.mouse.wheel(0, 240);
  await expect.poll(async () => (await editorsScroll())[1]).toBeGreaterThan(0);
  await settle(page); await visibleGeometry(page);
  const before = await editorsScroll();
  await page.locator('.smart-diff-pane[data-side="modified"]').hover();
  await page.mouse.wheel(0, -90);
  await expect.poll(async () => (await editorsScroll())[0]).toBeLessThan(before[0]);
  await settle(page); await visibleGeometry(page);
  const saved = await editorsScroll(); await settle(page);
  const after = await editorsScroll();
  expect(Math.abs(saved[0] - after[0])).toBeLessThan(2); expect(Math.abs(saved[1] - after[1])).toBeLessThan(2);
});

/** Compare two real compositor screenshots, with only the tested ribbon hidden
 * in the second one. The delta mask must stay connected across every column at
 * the junction; this detects a raster gap that matching vector attrs miss. */
async function continuousRaster(page: Page, id: string) {
  const path = page.locator(`.smart-diff-connectors path[data-change-id="${id}"]`);
  const clip = await path.evaluate(node => {
    const path = node as SVGPathElement, matrix = path.getScreenCTM()!;
    const gutter = document.querySelector('.smart-diff-gutter')!.getBoundingClientRect();
    const values = ['original', 'modified'].flatMap(side => ['top', 'bottom'].map(edge =>
      new DOMPoint(0, Number(path.getAttribute(`data-${side}-paint-${edge}`))).matrixTransform(matrix).y));
    const x = Math.floor(gutter.left + 40 * matrix.a);
    const y = Math.max(0, Math.floor(Math.min(...values) - 4));
    return { x, y, width: Math.ceil(gutter.right - 40 * matrix.a) - x, height: Math.ceil(Math.max(...values) + 4) - y };
  });
  const painted = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  await path.evaluate(node => { (node as SVGElement).style.visibility = 'hidden'; });
  let baseline: Buffer;
  try { baseline = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' }); }
  finally { await path.evaluate(node => { (node as SVGElement).style.removeProperty('visibility'); }); }
  const marker = await path.evaluate(node => ({
    side: node.getAttribute('data-boundary-side'),
    thicknessInPixels: Math.max(1, Math.round(4 * (node as SVGPathElement).getScreenCTM()!.d * devicePixelRatio)),
  }));
  const raster = await page.evaluate(async ([painted, baseline]) => {
    const pixels = async (source: string) => {
      const image = new Image(); image.src = `data:image/png;base64,${source}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const [a, b] = await Promise.all([pixels(painted), pixels(baseline)]);
    const mask = new Uint8Array(a.width * a.height), columns = new Uint8Array(a.width);
    for (let pixel = 0; pixel < mask.length; pixel++) {
      const i = pixel * 4;
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 2) {
        mask[pixel] = 1; columns[pixel % a.width] = 1;
      }
    }
    // Eight-neighbor connectivity includes legitimate antialiased diagonal edges.
    const visited = new Uint8Array(mask.length), queue: number[] = [];
    for (let y = 0; y < a.height; y++) if (mask[y * a.width]) { const index = y * a.width; visited[index] = 1; queue.push(index); }
    let reachesRight = false;
    for (let next = 0; next < queue.length; next++) {
      const pixel = queue[next], x = pixel % a.width, y = Math.floor(pixel / a.width);
      if (x === a.width - 1) reachesRight = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, neighbor = ny * a.width + nx;
        if (nx >= 0 && nx < a.width && ny >= 0 && ny < a.height && mask[neighbor] && !visited[neighbor]) {
          visited[neighbor] = 1; queue.push(neighbor);
        }
      }
    }
    const paintedRows = (x: number) => Array.from({ length: a.height }, (_, y) => mask[y * a.width + x]).reduce((sum, value) => sum + value, 0);
    return {
      width: a.width, missingColumns: [...columns].flatMap((present, x) => present ? [] : [x]), reachesRight,
      leftThickness: paintedRows(0), rightThickness: paintedRows(a.width - 1),
    };
  }, [painted.toString('base64'), baseline!.toString('base64')]);
  expect(raster.missingColumns, `Ribbon raster has an unpainted column (width ${raster.width})`).toEqual([]);
  expect(raster.reachesRight, 'Painted marker and widening band form one connected raster region').toBe(true);
  const thickness = marker.side === 'original' ? raster.leftThickness : raster.rightThickness;
  expect(Math.abs(thickness - marker.thicknessInPixels), 'Raster marker thickness matches the shared four-CSS-pixel ribbon endpoint').toBeLessThanOrEqual(1);
}

for (const dpr of [1, 2]) for (const scale of [1, .875]) {
  test(`one-sided ribbons remain connected at DPR ${dpr}, CSS scale ${scale}, above and below`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 1200, height: 600 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    try {
      for (const suffix of ['insert', 'delete']) {
        await open(page, suffix);
        await page.evaluate(scale => {
          const root = document.querySelector<HTMLElement>('.smart-diff')!;
          root.style.transformOrigin = 'top left'; root.style.transform = `scale(${scale})`;
          window.playground.viewer!.layout();
        }, scale);
        const [change] = await changes(page), empty: Side = suffix === 'insert' ? 'original' : 'modified';
        for (const position of ['above', 'below'] as const) {
          await page.evaluate(({ empty, position }) => {
            const viewer = window.playground.viewer!, change = viewer.getComparison()!.changes[0];
            for (const side of ['original', 'modified'] as const) {
              const editor = viewer.getEditors()[side];
              const target = side === empty ? 120 : position === 'above' ? 64 : 200;
              editor.setScrollTop(Math.max(0, editor.getTopForLineNumber(change[side].start) - target));
            }
          }, { empty, position });
          await settle(page); await boundaryGeometry(page, change.id, empty); await horizontalTangents(page, change.id);
          const relation = await page.locator(`.connector[data-change-id="${change.id}"]`).evaluate((path, empty) => {
            const full = empty === 'original' ? 'modified' : 'original';
            return Number(path.getAttribute(`data-${full}-top`)) - Number(path.getAttribute(`data-${empty}-top`));
          }, empty);
          expect(relation * (position === 'above' ? -1 : 1)).toBeGreaterThan(30);
          await continuousRaster(page, change.id);
        }
      }
    } finally { await context.close(); }
  });
}
