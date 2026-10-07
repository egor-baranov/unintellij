import { expect, test, type Page } from '@playwright/test';
import { deriveCollapsedRegions } from '../packages/monaco-smart-diff/src/folding/regions';
import { omissionFixtures } from '../apps/playground/src/omission-fixtures';

type Side = 'original' | 'modified';
const paths = '.smart-diff-omission-path';
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const viewer = window.playground?.viewer, comparison = viewer?.getComparison(), editors = viewer?.getEditors();
    return viewer?.getState().status === 'ready' && comparison?.originalVersion === editors?.original.getModel()?.getVersionId() && comparison?.modifiedVersion === editors?.modified.getModel()?.getVersionId();
  })).toBe(true);
  await settle(page);
}
async function open(page: Page, fixture = 'counts') {
  await page.goto(`/?fixture=omission-${fixture}`); await ready(page);
  await page.evaluate(() => window.playground.setPreferences({ collapse: true, sync: false, layout: 'compact' })); await ready(page);
}
async function regions(page: Page) {
  return deriveCollapsedRegions((await page.evaluate(() => window.playground.viewer!.getComparison()))!, { contextLines: 3, minimumHiddenLines: 6 });
}
async function geometry(page: Page) {
  await expect.poll(() => page.locator(paths).evaluateAll(nodes => nodes.every(node => {
    const path = node as SVGPathElement, matrix = path.getScreenCTM()!;
    return Math.abs(path.getBBox().width - path.ownerSVGElement!.getBoundingClientRect().width / matrix.a) < .05;
  }))).toBe(true);
  const expected = await regions(page);
  const actual = await page.locator(paths).evaluateAll(nodes => nodes.map(node => {
    const path = node as SVGPathElement, matrix = path.getScreenCTM()!, box = path.getBBox();
    const id = path.dataset.regionId!, style = getComputedStyle(path);
    const endpoint = (side: Side) => {
      const control = document.querySelector<HTMLButtonElement>(`.smart-diff-omission[data-region-id="${id}"][data-side="${side}"]`)!;
      const pane = document.querySelector<HTMLElement>(`.smart-diff-pane[data-side="${side}"]`)!.getBoundingClientRect();
      const y = Number(path.getAttribute(`data-${side}-y`));
      // Public view-zone callbacks position these owned controls. Read the
      // control's actual paint box instead of deriving Y from model lines.
      const controlY = pane.top + (parseFloat(control.style.top) + control.offsetHeight / 2) * matrix.d;
      return { y, screenY: new DOMPoint(0, y).matrixTransform(matrix).y, controlY, hidden: control.hidden,
        start: Number(path.getAttribute(`data-${side}-start`)), end: Number(path.getAttribute(`data-${side}-end`)) };
    };
    return { id, original: endpoint('original'), modified: endpoint('modified'), d: path.getAttribute('d'),
      x: box.x, width: box.width, viewportWidth: path.ownerSVGElement!.getBoundingClientRect().width / matrix.a,
      fill: style.fill, strokeWidth: style.strokeWidth, dash: style.strokeDasharray,
      count: Number(path.getAttribute('data-hidden-line-count')) };
  }));
  expect(actual.length).toBeGreaterThan(0);
  for (const path of actual) {
    const region = expected.find(region => region.id === path.id);
    expect(region, 'Each painted region identifies one canonical unchanged correspondence').toBeDefined();
    expect(path.count).toBe(region!.hiddenLineCount);
    for (const side of ['original', 'modified'] as const) {
      expect({ start: path[side].start, end: path[side].end }).toEqual(region![side]);
      if (!path[side].hidden) expect(path[side].screenY).toBeCloseTo(path[side].controlY, 1);
    }
    expect(path.d).not.toMatch(/NaN|Infinity/);
    expect(path.d?.match(/M/g)).toHaveLength(1);
    expect(path.x).toBeCloseTo(0, 1); expect(path.width).toBeCloseTo(path.viewportWidth, 1);
    expect(path.fill).toBe('none'); expect(path.strokeWidth).toBe('1px'); expect(path.dash).toBe('none');
  }
  expect(new Set(actual.map(path => path.id)).size).toBe(actual.length);
  await expect(page.locator('.smart-diff-omission svg')).toHaveCount(0);
  await expect(page.locator('.smart-diff-connectors')).toHaveCSS('pointer-events', 'none');
  return actual;
}

test('56, 84 and 12-line folds each use one paired boundary across both panes and both gutters', async ({ page }) => {
  await open(page);
  expect((await regions(page)).map(region => region.hiddenLineCount)).toEqual([56, 84, 12]);
  await expect(page.locator(paths)).toHaveCount(3);
  const actual = await geometry(page);
  for (const region of actual) expect(region.original.y).toBeCloseTo(region.modified.y, 1);
  for (const region of await regions(page)) {
    await expect(page.locator(`.smart-diff-omission[data-region-id="${region.id}"]`)).toHaveCount(2);
    await expect(page.locator(`.smart-diff-omission[data-region-id="${region.id}"]`).first()).toHaveAttribute('aria-label', `Expand ${region.hiddenLineCount} unchanged lines`);
  }
  const control = page.locator('.smart-diff-omission[data-side="original"]').first();
  const before = await control.boundingBox();
  await control.hover();
  expect(await control.boundingBox()).toEqual(before);
  await expect(control).toHaveCSS('border-top-width', '0px');
  await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const fixture = omissionFixtures.find(fixture => fixture.id === 'omission-counts')!;
  expect(await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    return [editors.original.getModel()!.getValue(), editors.modified.getModel()!.getValue()];
  })).toEqual([fixture.original, fixture.modified]);
});

test('unequal folds connect the original above and below its true counterpart without alignment spacers', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1300 }); await open(page, 'unequal');
  const actual = await geometry(page);
  expect(actual).toHaveLength(3);
  expect(actual[1].original.y).toBeLessThan(actual[1].modified.y - 100);
  expect(actual[2].original.y).toBeGreaterThan(actual[2].modified.y + 100);
  await expect(page.locator('.smart-diff-spacer')).toHaveCount(0);
});

test('identical hidden counts stay paired by canonical ranges during independent scrolling and clipping', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 480 }); await open(page, 'repeated');
  expect((await regions(page)).map(region => region.hiddenLineCount)).toEqual([56, 56, 56]);
  const before = await geometry(page), first = before[0];
  await page.evaluate(() => window.playground.viewer!.getEditors().modified.setScrollTop(220)); await settle(page);
  const after = await geometry(page), endpoint = after.find(region => region.id === first.id)!;
  expect(endpoint.original.y).toBeCloseTo(first.original.y, 1);
  expect(endpoint.modified.y).toBeLessThan(0);
  expect(endpoint.modified.y).toBeCloseTo(first.modified.y - 220, 1);
  expect(after.map(region => region.id)).toContain(first.id);
  // The real offscreen Y survives. The shared SVG clips it instead of clamping.
  await expect(page.locator('.smart-diff-connectors')).toHaveCSS('overflow', 'hidden');
});

test('large changes, wrapping, resize, font changes, extra zones and horizontal scroll use rendered anchors', async ({ page }) => {
  await open(page, 'wrapped');
  await page.evaluate(() => window.playground.setPreferences({ wrap: true })); await ready(page);
  await geometry(page);
  await page.setViewportSize({ width: 920, height: 760 }); await settle(page); await geometry(page);
  await page.evaluate(() => window.playground.viewer!.updateOptions({ editorOptions: { fontSize: 18, lineHeight: 29 } })); await settle(page); await geometry(page);
  const firstBeforeZone = (await geometry(page))[0];
  const firstRegion = (await regions(page))[0];
  const zone = await page.evaluate(afterLineNumber => {
    let id = ''; window.playground.viewer!.getEditors().original.changeViewZones(accessor => {
      id = accessor.addZone({ afterLineNumber, heightInPx: 23, domNode: document.createElement('div'), showInHiddenAreas: true });
    }); return id;
  }, firstRegion.original.start - 1);
  await settle(page);
  const firstAfterZone = (await geometry(page)).find(region => region.id === firstBeforeZone.id)!;
  expect(firstAfterZone.original.y - firstBeforeZone.original.y).toBeCloseTo(23, 1);
  await page.evaluate(id => window.playground.viewer!.getEditors().original.changeViewZones(accessor => accessor.removeZone(id)), zone);
  await page.evaluate(() => window.playground.setPreferences({ wrap: false })); await ready(page);
  const before = await page.locator(paths).evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
  await page.evaluate(() => { const editors = window.playground.viewer!.getEditors(); editors.original.setScrollLeft(400); editors.modified.setScrollLeft(260); });
  await settle(page); await geometry(page);
  expect(await page.locator(paths).evaluateAll(nodes => nodes.map(node => node.getAttribute('d')))).toEqual(before);
  await page.evaluate(() => window.playground.selectFixture('omission-large')); await ready(page);
  for (const region of await regions(page)) {
    await page.evaluate(range => {
      const editors = window.playground.viewer!.getEditors();
      for (const side of ['original', 'modified'] as const) editors[side].setScrollTop(Math.max(0, editors[side].getTopForLineNumber(range[side].start - 1) - 150));
    }, region); await settle(page); await geometry(page);
  }
});

test('zero-context trailing folds and contiguous hidden ranges retain real zone positions offscreen', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 480 }); await open(page);
  await page.evaluate(() => {
    const lines = Array.from({ length: 80 }, (_, index) => `const unchanged${index} = ${index};`).join('\n');
    window.playground.setContents(`const header = "old";\n${lines}`, `const header = "new";\n${lines}`);
    window.playground.viewer!.updateOptions({ unchangedRegions: { collapse: true, contextLines: 0, minimumHiddenLines: 6 } });
  }); await ready(page);
  await expect(page.locator(paths)).toHaveCount(1);
  const initial = await page.locator(paths).evaluate(node => ({ id: node.getAttribute('data-region-id')!, original: Number(node.getAttribute('data-original-y')), modified: Number(node.getAttribute('data-modified-y')) }));
  const expectedY = await page.evaluate(() => window.playground.viewer!.getEditors().original.getBottomForLineNumber(1) + 9);
  expect(initial.original).toBeCloseTo(expectedY, 1); expect(initial.modified).toBeCloseTo(expectedY, 1);
  const externalZone = await page.evaluate(() => {
    let id = ''; window.playground.viewer!.getEditors().modified.changeViewZones(accessor => {
      id = accessor.addZone({ afterLineNumber: 1, heightInPx: 600, domNode: document.createElement('div'), showInHiddenAreas: true });
    }); return id;
  }); await settle(page);
  const path = page.locator(`${paths}[data-region-id="${initial.id}"]`);
  await expect(path).toHaveCount(1);
  expect(Number(await path.getAttribute('data-modified-y'))).toBeCloseTo(initial.modified + 600, 1);
  expect(Number(await path.getAttribute('data-modified-y'))).toBeGreaterThan(500);
  await page.evaluate(() => window.playground.viewer!.getEditors().modified.setScrollTop(300)); await settle(page);
  expect(Number(await path.getAttribute('data-modified-y'))).toBeCloseTo(initial.modified + 300, 1);
  expect(Number(await path.getAttribute('data-original-y'))).toBeCloseTo(initial.original, 1);
  await page.evaluate(id => window.playground.viewer!.getEditors().modified.changeViewZones(accessor => accessor.removeZone(id)), externalZone);

  await page.evaluate(() => {
    const a = Array.from({ length: 50 }, (_, index) => `const before${index} = ${index};`);
    const b = Array.from({ length: 50 }, (_, index) => `const after${index} = ${index};`);
    window.playground.setContents(['const header = "old";', ...a, ...b, 'const footer = "old";'].join('\n'),
      ['const header = "new";', ...a, 'const inserted1 = 1;', 'const inserted2 = 2;', 'const inserted3 = 3;', ...b, 'const footer = "new";'].join('\n'));
  }); await ready(page);
  await page.evaluate(() => { const editors = window.playground.viewer!.getEditors(); editors.original.setScrollTop(0); editors.modified.setScrollTop(0); }); await settle(page);
  const pairs = await page.locator(paths).evaluateAll(nodes => nodes.map(node => ({
    count: Number(node.getAttribute('data-hidden-line-count')), original: Number(node.getAttribute('data-original-y')), modified: Number(node.getAttribute('data-modified-y')),
  })));
  expect(pairs).toHaveLength(2); expect(pairs.map(pair => pair.count)).toEqual([50, 50]);
  expect(pairs[1].original - pairs[0].original).toBeCloseTo(18, 1);
  const lineHeight = await page.evaluate(() => window.playground.viewer!.getEditors().modified.getOption(window.playground.monaco.editor.EditorOption.lineHeight));
  expect(pairs[1].modified - pairs[0].modified).toBeCloseTo(18 + 3 * lineHeight, 1);

  // Monaco cannot hide every model line. Retain genuine source context when
  // context=0 would otherwise collapse the entire original of an EOF insertion.
  await page.evaluate(() => {
    const common = Array.from({ length: 60 }, (_, index) => `const unchanged${index} = ${index};`).join('\n');
    window.playground.setContents(common, `${common}\nconst addedAtEnd = true;`);
  }); await ready(page);
  await expect(page.locator('.smart-diff-omission')).toHaveCount(0);
  await expect(page.locator(paths)).toHaveCount(0);
  expect(await page.evaluate(() => {
    const editor = window.playground.viewer!.getEditors().original;
    return [1, editor.getModel()!.getLineCount()].every(lineNumber => editor.getLineHeightForPosition({ lineNumber, column: 1 }) > 0);
  })).toBe(true);
});

test('mouse and keyboard expansion remove both controls and the connected path; restore can recollapse', async ({ page }) => {
  await open(page);
  const state = await page.evaluate(() => window.playground.viewer!.saveViewState());
  const [first, second] = await regions(page);
  await page.locator(`.smart-diff-omission[data-region-id="${first.id}"][data-side="original"]`).click();
  await expect(page.locator(`.smart-diff-omission[data-region-id="${first.id}"]`)).toHaveCount(0);
  await expect(page.locator(`${paths}[data-region-id="${first.id}"]`)).toHaveCount(0);
  await page.evaluate(state => window.playground.viewer!.restoreViewState(state), state); await settle(page);
  await expect(page.locator(`${paths}[data-region-id="${first.id}"]`)).toHaveCount(1);
  const control = page.locator(`.smart-diff-omission[data-region-id="${second.id}"][data-side="modified"]`);
  await control.focus(); await expect(control).toBeFocused(); await control.press('Enter');
  await expect(page.locator(`.smart-diff-omission[data-region-id="${second.id}"]`)).toHaveCount(0);
  await expect(page.locator(`${paths}[data-region-id="${second.id}"]`)).toHaveCount(0);
  await page.evaluate(state => window.playground.viewer!.restoreViewState(state), state); await settle(page);
  await geometry(page); await expect(page.locator(paths)).toHaveCount(3);
});

test('rapid replacement rejects old fold geometry and leaves thick insertion markers intact', async ({ page }) => {
  await open(page);
  for (const fixture of ['omission-repeated', 'omission-large', 'omission-counts', 'boundary-insert']) {
    await page.evaluate(id => window.playground.selectFixture(id), fixture);
  }
  await ready(page);
  const comparison = await page.evaluate(() => window.playground.viewer!.getComparison()!);
  const ids = deriveCollapsedRegions(comparison, { contextLines: 3, minimumHiddenLines: 6 }).map(region => region.id);
  for (const id of await page.locator(paths).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-region-id')))) expect(ids).toContain(id);
  const boundary = page.locator('.smart-diff-boundary').first();
  await expect(boundary).toBeVisible();
  const thickness = await boundary.evaluate(node => {
    const side = node.getAttribute('data-boundary-side');
    return Number(node.getAttribute(`data-${side}-paint-bottom`)) - Number(node.getAttribute(`data-${side}-paint-top`));
  }); expect(thickness).toBe(4);
  await page.evaluate(() => window.playground.selectFixture('omission-counts')); await ready(page);
  await geometry(page); await expect(page.locator(paths)).toHaveCount(3);
});

for (const dpr of [1, 2]) test(`omission wave remains thin, continuous and tangent through the central gutter at DPR ${dpr}`, async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 1400, height: 1300 }, deviceScaleFactor: dpr });
  try {
    const page = await context.newPage(); await open(page, 'unequal'); await geometry(page);
    const joins = await page.locator(paths).evaluateAll(nodes => nodes.map(node => {
      const path = node as SVGPathElement, total = path.getTotalLength();
      const sample = (x: number) => {
        let low = 0, high = total;
        for (let step = 0; step < 32; step++) { const middle = (low + high) / 2; if (path.getPointAtLength(middle).x < x) low = middle; else high = middle; }
        return path.getPointAtLength((low + high) / 2);
      };
      const wave = Array.from({ length: 49 }, (_, index) => sample(60 + index / 4).y);
      return { amplitude: (Math.max(...wave) - Math.min(...wave)) / 2, joins: (['original', 'modified'] as const).map(side => {
        const x = Number(path.getAttribute(side === 'original' ? 'data-center-left' : 'data-center-right'));
        const left = sample(x - .05), point = sample(x), right = sample(x + .05);
        return { y: point.y, expected: Number(path.getAttribute(`data-${side}-y`)), slope: (right.y - left.y) / (right.x - left.x) };
      }) };
    }));
    for (const pair of joins) {
      expect(pair.amplitude).toBeCloseTo(3, 1);
      for (const join of pair.joins) { expect(join.y).toBeCloseTo(join.expected, 2); expect(Math.abs(join.slope)).toBeLessThan(.02); }
    }
  } finally { await context.close(); }
});
