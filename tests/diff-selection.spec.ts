import { mkdir } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';

type Side = 'added' | 'original' | 'modified';
type Box = { x: number; y: number; width: number; height: number };
type Color = [number, number, number];
const pane = (page: Page, side: Side) => side === 'added'
  ? page.locator('.file-surface-added') : page.locator(`.smart-diff-pane[data-side="${side}"]`);

test.use({ deviceScaleFactor: 1 });

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const app = window.playground;
    if (app?.editor) return app.getState().status === 'ready' && Boolean(app.editor.getModel());
    const viewer = app?.viewer, comparison = viewer?.getComparison(), editors = viewer?.getEditors();
    return viewer?.getState().status === 'ready'
      && comparison?.originalVersion === editors?.original.getModel()?.getVersionId()
      && comparison?.modifiedVersion === editors?.modified.getModel()?.getVersionId();
  })).toBe(true);
  await settle(page);
}
async function open(page: Page, fixture: string) {
  await page.goto(`/?fixture=${fixture}`);
  await ready(page);
  if (fixture !== 'added') {
    await page.evaluate(() => window.playground.setPreferences({ collapse: false, sync: false }));
    await ready(page);
  }
}
async function capture(page: Page, name: string) {
  await mkdir('artifacts/selection', { recursive: true });
  await page.screenshot({ path: `artifacts/selection/${name}.png` });
}
async function paintedColor(locator: Locator, property: 'backgroundColor' | 'borderColor'): Promise<Color> {
  return locator.evaluate((element, property) => {
    const channels = getComputedStyle(element)[property].match(/[\d.]+/g)!.map(Number);
    return channels.slice(0, 3) as Color;
  }, property);
}

/** Inspect the rendered PNG, not only Monaco's selection DOM or CSS. The top
 * band is clear of glyphs; the body separately checks that syntax is visible. */
async function raster(page: Page, box: Box, color: Color) {
  const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) };
  const screenshot = await page.screenshot({ clip });
  return page.evaluate(async ({ png, color }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let matching = 0, bandMatching = 0, bandPixels = 0, bright = 0, chromaticGlyphs = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const offset = (y * canvas.width + x) * 4;
      const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      const matches = rgb.every((channel, index) => Math.abs(channel - color[index]) <= 2);
      if (matches) matching++;
      if (y >= 2 && y <= 3 && x >= 3 && x < canvas.width - 3) {
        bandPixels++; if (matches) bandMatching++;
      }
      if (y >= 4 && y < canvas.height - 3 && x >= 3 && x < canvas.width - 3 && Math.max(...rgb) > 145) {
        bright++;
        if (Math.max(...rgb) - Math.min(...rgb) > 45) chromaticGlyphs++;
      }
    }
    return { matching, bandRatio: bandMatching / bandPixels, bright, chromaticGlyphs };
  }, { png: screenshot.toString('base64'), color });
}

async function mouseSelection(page: Page, side: Side, start: number, end: number, sampledLine: number, name: string) {
  const geometry = await page.evaluate(({ side, start, end, sampledLine }) => {
    const editor = side === 'added' ? window.playground.editor! : window.playground.viewer!.getEditors()[side];
    editor.focus(); editor.setPosition({ lineNumber: start, column: 1 });
    editor.revealLineInCenter(sampledLine); editor.render(true);
    const rect = editor.getDomNode()!.getBoundingClientRect(), model = editor.getModel()!;
    const point = (lineNumber: number, column: number) => {
      const position = editor.getScrolledVisiblePosition({ lineNumber, column })!;
      return { x: rect.left + position.left, y: rect.top + position.top, height: position.height };
    };
    const first = point(start, 1), last = point(end, 1), sample = point(sampledLine, 1);
    const sampleEnd = point(sampledLine, model.getLineMaxColumn(sampledLine));
    return { first, last, box: { x: sample.x + 1, y: sample.y, width: sampleEnd.x - sample.x - 2, height: sample.height } };
  }, { side, start, end, sampledLine });
  await settle(page);
  const baseline = await raster(page, geometry.box, [0, 0, 0]);
  expect(baseline.chromaticGlyphs).toBeGreaterThan(30);

  await page.mouse.move(geometry.first.x + 2, geometry.first.y + geometry.first.height / 2);
  await page.mouse.down();
  await page.mouse.move(geometry.last.x + 2, geometry.last.y + geometry.last.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(side => {
    const editor = side === 'added' ? window.playground.editor! : window.playground.viewer!.getEditors()[side];
    const selection = editor.getSelection()!;
    return { focused: editor.hasTextFocus(), first: selection.startLineNumber, last: selection.endLineNumber };
  }, side)).toEqual({ focused: true, first: start, last: end });
  await settle(page);
  const selected = await raster(page, geometry.box, await paintedColor(pane(page, side).locator('.selected-text').first(), 'backgroundColor'));
  expect(selected.bandRatio, `${name}: focused selection must paint over line and inline diff fills`).toBeGreaterThan(.9);
  expect(selected.chromaticGlyphs, `${name}: selection must leave syntax glyphs visible`).toBeGreaterThan(baseline.chromaticGlyphs * .65);
  if (side === 'added') {
    const corner = pane(page, side).locator('.view-overlays > div:has(> .added-file-line) > .cslr.monaco-editor-background').first();
    await expect(corner).toBeVisible();
    const fill = await paintedColor(pane(page, side).locator('.added-file-line').first(), 'backgroundColor');
    const box = await corner.boundingBox(); expect(box).not.toBeNull();
    expect((await raster(page, box!, fill)).matching, 'Inverse rounded corner must show the green row, without a dark box').toBeGreaterThan(0);
  }
  await capture(page, `${name}-focused`);

  await page.getByRole('button', { name: 'Playground tools', exact: true }).focus();
  await expect.poll(() => page.evaluate(side => (side === 'added' ? window.playground.editor! : window.playground.viewer!.getEditors()[side]).hasTextFocus(), side)).toBe(false);
  await settle(page);
  const blurred = await raster(page, geometry.box, await paintedColor(pane(page, side).locator('.selected-text').first(), 'backgroundColor'));
  expect(blurred.bandRatio, `${name}: selection must remain painted after focus moves`).toBeGreaterThan(.9);
  expect(blurred.chromaticGlyphs).toBeGreaterThan(baseline.chromaticGlyphs * .65);
  await capture(page, `${name}-unfocused`);
}

test('added-file mouse selections remain visible over green lines when focused and unfocused', async ({ page }) => {
  await open(page, 'added');
  await expect(pane(page, 'added').locator('.added-file-line').first()).toBeVisible();
  await mouseSelection(page, 'added', 1, 5, 3, 'added');
});

for (const kind of ['insert', 'delete', 'replace'] as const) {
  test(`${kind} diff mouse selections cover line and inline fills without hiding syntax`, async ({ page }) => {
    await open(page, kind === 'replace' ? 'boundary-nearby' : `boundary-${kind}`);
    const sides: Side[] = kind === 'replace' ? ['original', 'modified'] : [kind === 'delete' ? 'original' : 'modified'];
    for (const side of sides) {
      const range = await page.evaluate(({ kind, side }) => {
        const change = window.playground.viewer!.getComparison()!.changes.find(change => change.kind === kind)!;
        return change[side as 'original' | 'modified'];
      }, { kind, side });
      await expect(pane(page, side).locator(`.smart-diff-line-${kind}`).first()).toBeVisible();
      await expect(pane(page, side).locator(`.smart-diff-inner-${kind}`).first()).toBeVisible();
      await mouseSelection(page, side, range.start - 1, range.end + 1, range.start, `${kind}-${side}`);
    }
  });
}

test('the current find match remains painted above added and diff backgrounds', async ({ page }) => {
  for (const entry of [
    { fixture: 'added', side: 'added', word: 'greeting' },
    { fixture: 'boundary-insert', side: 'modified', word: 'enabled' },
    { fixture: 'boundary-delete', side: 'original', word: 'enabled' },
    { fixture: 'boundary-nearby', side: 'modified', word: 'replacement' },
  ] as const) {
    await open(page, entry.fixture);
    await page.evaluate(async side => {
      const editor = side === 'added' ? window.playground.editor! : window.playground.viewer!.getEditors()[side];
      editor.focus(); editor.setPosition({ lineNumber: 1, column: 1 });
      await editor.getAction('actions.find')!.run();
    }, entry.side);
    const find = pane(page, entry.side).locator('.find-widget').getByRole('textbox', { name: 'Find', exact: true });
    await expect(find).toBeVisible();
    await find.fill(entry.word);
    await page.keyboard.press('Enter');
    const match = pane(page, entry.side).locator('.currentFindMatch');
    await expect(match).toHaveCount(1);
    await settle(page);
    const box = await match.boundingBox(); expect(box).not.toBeNull();
    const rendered = await raster(page, box!, await paintedColor(match, 'borderColor'));
    expect(rendered.matching, `${entry.fixture}: current match border must be visible in the rendered editor`).toBeGreaterThan((box!.width + box!.height) * .8);
    expect(rendered.bright, `${entry.fixture}: matched text must remain readable`).toBeGreaterThan(20);
    await capture(page, `find-${entry.fixture}-${entry.side}`);
  }
});
