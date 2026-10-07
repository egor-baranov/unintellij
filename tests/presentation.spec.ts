import { expect, test, type Page } from '@playwright/test';

type Side = 'original' | 'modified';

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const viewer = window.playground?.viewer;
    if (!viewer) return false;
    const comparison = viewer.getComparison();
    const editors = viewer.getEditors();
    return /^(ready|empty)$/.test(viewer.getState().status)
      && comparison?.originalVersion === editors.original.getModel()?.getVersionId()
      && comparison?.modifiedVersion === editors.modified.getModel()?.getVersionId();
  })).toBe(true);
  await settled(page);
}

async function open(page: Page, fixture: string): Promise<void> {
  await page.goto(`/?fixture=${fixture}`);
  await ready(page);
}

async function preferences(page: Page, value: Parameters<Window['playground']['setPreferences']>[0]): Promise<void> {
  await page.evaluate(value => window.playground.setPreferences(value), value);
  await settled(page);
  await ready(page);
}

/** Assert against Monaco's rendered geometry, including its hidden areas and wrapping. */
async function expectNumberGeometry(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    const numbers = [...document.querySelectorAll<SVGTextElement>('.smart-diff-line-number')];
    if (!numbers.length) return false;
    const keys = new Set<string>();
    return numbers.every(node => {
      const side = node.dataset.numberSide as Side;
      const line = Number(node.dataset.lineNumber);
      const editor = editors[side];
      const key = `${side}:${line}`;
      if (!editor || keys.has(key) || node.textContent !== String(line)) return false;
      keys.add(key);
      const height = editor.getLineHeightForPosition({ lineNumber: line, column: 1 });
      const expected = editor.getTopForLineNumber(line) - editor.getScrollTop() + height / 2;
      return height > 0 && Math.abs(Number(node.getAttribute('y')) - expected) < 0.6;
    });
  })).toBe(true);
}

async function wheel(page: Page, side: Side, amount: number): Promise<void> {
  await page.locator(`.smart-diff-pane[data-side="${side}"]`).hover();
  for (let tick = 0; tick < Math.ceil(Math.abs(amount) / 50); tick++) {
    await page.mouse.wheel(0, Math.sign(amount) * 50);
    await settled(page);
  }
}

test('center-facing number columns use real visible model lines and fixed horizontal positions', async ({ page }) => {
  await open(page, 'wrapping');
  await preferences(page, { collapse: false, sync: false, wrap: false });
  await expectNumberGeometry(page);
  const presentation = await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    const gutter = document.querySelector('.smart-diff-gutter')!.getBoundingClientRect();
    return {
      width: gutter.width,
      nativeNumbers: [editors.original.getRawOptions().lineNumbers, editors.modified.getRawOptions().lineNumbers],
      leftEdge: document.querySelector('.smart-diff-pane[data-side="original"]')!.getBoundingClientRect().right,
      rightEdge: document.querySelector('.smart-diff-pane[data-side="modified"]')!.getBoundingClientRect().left,
      gutterLeft: gutter.left, gutterRight: gutter.right,
    };
  });
  expect(presentation.width).toBeGreaterThanOrEqual(140);
  expect(presentation.width).toBeLessThanOrEqual(160);
  expect(presentation.nativeNumbers).toEqual(['off', 'off']);
  expect(presentation.leftEdge).toBeCloseTo(presentation.gutterLeft, 0);
  expect(presentation.rightEdge).toBeCloseTo(presentation.gutterRight, 0);
  const first = page.locator('.smart-diff-line-number[data-number-side="original"][data-line-number="1"]');
  const before = await first.boundingBox();
  expect(before).not.toBeNull();
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().original.getScrollWidth())).toBeGreaterThan(1000);
  await page.evaluate(() => window.playground.viewer!.getEditors().original.setScrollLeft(320));
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().original.getScrollLeft())).toBeGreaterThan(200);
  await settled(page);
  const after = await first.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.x).toBeCloseTo(before!.x, 1);
  expect(after!.y).toBeCloseTo(before!.y, 1);
  await expectNumberGeometry(page);
});

test('wrapped logical lines receive one number, aligned to their first rendered row after resize', async ({ page }) => {
  await open(page, 'wrapping');
  await preferences(page, { collapse: false, wrap: true, sync: false });
  // Changing wrapping preserves the prior reading anchor, which can move the
  // first row offscreen. Place this assertion at a deliberate document boundary.
  await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    editors.original.setScrollTop(0); editors.modified.setScrollTop(0);
  });
  await settled(page);
  await expect.poll(() => page.evaluate(() => {
    const editor = window.playground.viewer!.getEditors().modified;
    return editor.getBottomForLineNumber(1) - editor.getTopForLineNumber(1);
  })).toBeGreaterThan(100);
  await expectNumberGeometry(page);
  await expect(page.locator('.smart-diff-line-number[data-number-side="modified"][data-line-number="1"]')).toHaveCount(1);
  const before = await page.locator('.smart-diff-connectors path.connector').first().getAttribute('d');
  await page.setViewportSize({ width: 900, height: 640 });
  await expect.poll(() => page.locator('.smart-diff-connectors path.connector').first().getAttribute('d')).not.toBe(before);
  await expectNumberGeometry(page);
  expect(await page.locator('.smart-diff-line-number').count()).toBeLessThan(100);
});

test('folded line-number jumps are real hidden ranges and keyboard expansion updates both panes', async ({ page }) => {
  await open(page, 'folds');
  await expectNumberGeometry(page);
  const jumps = await page.evaluate(() => {
    const values = [...document.querySelectorAll<SVGTextElement>('.smart-diff-line-number[data-number-side="original"]')]
      .map(node => Number(node.dataset.lineNumber)).sort((a, b) => a - b);
    return values.some((line, index) => index > 0 && line - values[index - 1] > 20);
  });
  expect(jumps).toBe(true);
  const separator = page.locator('.smart-diff-pane[data-side="original"] .smart-diff-omission').first();
  // Host button styles must not enlarge an omission beyond its Monaco zone.
  expect((await separator.boundingBox())!.height).toBe(18);
  const id = await separator.getAttribute('data-region-id');
  expect(id).toBeTruthy();
  const hidden = await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    return (['original', 'modified'] as const).map(side => {
      const editor = editors[side];
      for (let line = 1; line <= editor.getModel()!.getLineCount(); line++) {
        if (editor.getLineHeightForPosition({ lineNumber: line, column: 1 }) === 0) return line;
      }
      return -1;
    });
  });
  expect(hidden.every(line => line > 0)).toBe(true);
  await separator.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`.smart-diff-omission[data-region-id="${id}"]`)).toHaveCount(0);
  await expect.poll(() => page.evaluate(lines => {
    const editors = window.playground.viewer!.getEditors();
    return editors.original.getLineHeightForPosition({ lineNumber: lines[0], column: 1 }) > 0
      && editors.modified.getLineHeightForPosition({ lineNumber: lines[1], column: 1 }) > 0;
  }, hidden)).toBe(true);
  await expectNumberGeometry(page);
});

test('scrolling over large hidden regions keeps each number column attached to its pane', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 480 });
  await open(page, 'folds');
  await page.evaluate(() => {
    const lines = Array.from({ length: 1200 }, (_, index) => `const value${index + 1} = ${index + 1};`);
    const modified = lines.map((line, index) => [2, 300, 620, 900, 1197].includes(index) ? line.replace(';', ' + 10;') : line);
    window.playground.setContents(lines.join('\n'), modified.join('\n'));
  });
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().original.getModel()!.getLineCount())).toBe(1200);
  await ready(page);
  await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    editors.original.setScrollTop(0); editors.modified.setScrollTop(0);
  });
  await wheel(page, 'original', 300);
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getScrollTop())).toBeGreaterThan(150);
  await expectNumberGeometry(page);
  await expect.poll(() => page.evaluate(() => {
    const editor = window.playground.viewer!.getEditors().original;
    return editor.getVisibleRanges()[0].startLineNumber;
  })).toBeGreaterThan(250);
  const first = await page.evaluate(() => window.playground.viewer!.getEditors().original.getScrollTop());
  await wheel(page, 'modified', 200);
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().original.getScrollTop())).toBeGreaterThan(first + 100);
  await expectNumberGeometry(page);
  const before = await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    return [editors.original.getScrollTop(), editors.modified.getScrollTop()];
  });
  await settled(page);
  const after = await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    return [editors.original.getScrollTop(), editors.modified.getScrollTop()];
  });
  expect(Math.abs(after[0] - before[0])).toBeLessThan(1);
  expect(Math.abs(after[1] - before[1])).toBeLessThan(1);
});

for (const fixture of ['added', 'deleted']) {
  test(`${fixture} bands join the real empty boundary and complete rendered range`, async ({ page }) => {
    await page.goto(`/?fixture=${fixture}`);
    if (fixture === 'added') {
      await page.waitForFunction(() => window.playground?.editor);
      // Explicit model comparison exercises the library's empty boundary; the
      // host's added-file presentation intentionally has no empty pane.
      await page.evaluate(() => window.playground.setContents('', window.playground.editor!.getModel()!.getValue()));
    }
    await ready(page);
    const measured = await page.evaluate(() => {
      const viewer = window.playground.viewer!, editors = viewer.getEditors();
      const change = viewer.getComparison()!.changes[0];
      const path = document.querySelector<SVGPathElement>(`.smart-diff-connectors path[data-change-id="${change.id}"]`)!;
      const root = path.ownerSVGElement!, matrix = path.getScreenCTM()!, inverse = matrix.inverse();
      const gutter = document.querySelector<SVGSVGElement>('.smart-diff-gutter')!.getBoundingClientRect();
      const left = new DOMPoint(gutter.left, gutter.top).matrixTransform(inverse).x;
      const right = new DOMPoint(gutter.right, gutter.top).matrixTransform(inverse).x;
      const rootWidth = root.getBoundingClientRect().width / matrix.a;
      const originalX = change.original.start === change.original.end ? 0 : left;
      const modifiedX = change.modified.start === change.modified.end ? rootWidth : right;
      const total = path.getTotalLength();
      const edges: Record<Side, number[]> = { original: [], modified: [] };
      // Sample the actual SVG path's outer edges, including the vertical closing
      // edge. The full-width bands have horizontal sections that reach each edge.
      for (let step = 0; step <= 5000; step++) {
        const point = path.getPointAtLength(total * step / 5000);
        if (point.x < originalX + 2) edges.original.push(point.y);
        if (point.x > modifiedX - 2) edges.modified.push(point.y);
      }
      return (['original', 'modified'] as const).map(side => {
        const editor = editors[side], range = change[side], count = editor.getModel()!.getLineCount();
        const top = (range.start > count ? editor.getBottomForLineNumber(count) : editor.getTopForLineNumber(range.start)) - editor.getScrollTop();
        const bottom = range.end === range.start ? top : editor.getBottomForLineNumber(range.end - 1) - editor.getScrollTop();
        return { top, bottom, actualTop: Math.min(...edges[side]), actualBottom: Math.max(...edges[side]), empty: range.start === range.end,
          semanticTop: Number(path.getAttribute(`data-${side}-top`)), semanticBottom: Number(path.getAttribute(`data-${side}-bottom`)),
          paintTop: Number(path.getAttribute(`data-${side}-paint-top`)), paintBottom: Number(path.getAttribute(`data-${side}-paint-bottom`)) };
      });
    });
    expect(measured.some(side => side.empty)).toBe(true);
    for (const side of measured) {
      expect(side.semanticTop).toBeCloseTo(side.top, 4);
      expect(side.semanticBottom).toBeCloseTo(side.bottom, 4);
      expect(Math.abs(side.actualTop - side.paintTop)).toBeLessThan(0.25);
      expect(Math.abs(side.actualBottom - side.paintBottom)).toBeLessThan(0.25);
      if (side.empty) {
        expect(side.semanticBottom).toBe(side.semanticTop);
        // Empty-side markers retain their existing 4px paint thickness;
        // the separate omission wave keeps its own 1px stroke.
        expect(side.paintBottom - side.paintTop).toBeCloseTo(4, 4);
        expect(Math.abs((side.paintBottom + side.paintTop) / 2 - side.top)).toBeLessThanOrEqual(1);
      } else {
        expect(side.paintTop).toBeCloseTo(side.top, 4);
        expect(side.paintBottom).toBeCloseTo(side.bottom, 4);
      }
    }
    await expectNumberGeometry(page);
  });
}

test('multiline inner changes are split into nonempty single-line decorations without line fill', async ({ page }) => {
  await open(page, 'tsx');
  await preferences(page, { collapse: false });
  const result = await page.evaluate(() => {
    const viewer = window.playground.viewer!;
    const comparison = viewer.getComparison()!;
    const editors = viewer.getEditors();
    let multiLineCanonical = 0;
    let inlineCount = 0;
    const errors: string[] = [];
    for (const side of ['original', 'modified'] as const) {
      const model = editors[side].getModel()!;
      const inner = comparison.changes.flatMap(change => change.innerChanges.map(range => range[side]));
      multiLineCanonical += inner.filter(range => range.endLineNumber > range.startLineNumber).length;
      const decorations = model.getAllDecorations().filter(decoration => decoration.options.className?.includes('smart-diff-inner'));
      inlineCount += decorations.length;
      for (const { range, options } of decorations) {
        if (range.startLineNumber !== range.endLineNumber) errors.push('multiline decoration');
        if (range.startColumn >= range.endColumn) errors.push('empty decoration');
        if (range.endColumn > model.getLineMaxColumn(range.endLineNumber)) errors.push('extends past source text');
        if (options.shouldFillLineOnLineBreak) errors.push('fills line on break');
        const intervals = inner.filter(source => source.startLineNumber <= range.startLineNumber && source.endLineNumber >= range.endLineNumber)
          .map(source => ({
            start: source.startLineNumber === range.startLineNumber ? source.startColumn : 1,
            end: source.endLineNumber === range.endLineNumber ? source.endColumn : model.getLineMaxColumn(range.endLineNumber),
          })).sort((a, b) => a.start - b.start);
        let coveredThrough = range.startColumn;
        for (const interval of intervals) {
          if (interval.start > coveredThrough) break;
          coveredThrough = Math.max(coveredThrough, interval.end);
        }
        if (coveredThrough < range.endColumn) errors.push('highlights text outside canonical inner change');
      }
    }
    return { multiLineCanonical, inlineCount, errors };
  });
  expect(result.multiLineCanonical).toBeGreaterThan(0);
  expect(result.inlineCount).toBeGreaterThan(5);
  expect(result.errors).toEqual([]);
});

test('font metrics and compact/aligned switches preserve reading anchors and number geometry', async ({ page }) => {
  await open(page, 'replacement');
  await preferences(page, { collapse: false, sync: false });
  await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    editors.original.setScrollTop(1400); editors.modified.setScrollTop(1800);
  });
  await settled(page);
  const before = await page.evaluate(() => window.playground.viewer!.saveViewState().original.anchor.line);
  await page.evaluate(() => window.playground.viewer!.updateOptions({ editorOptions: { fontSize: 18, lineHeight: 27 } }));
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().original.getOption(window.playground.monaco.editor.EditorOption.lineHeight))).toBe(27);
  await expectNumberGeometry(page);
  await expect.poll(() => page.evaluate(line => Math.abs(window.playground.viewer!.saveViewState().original.anchor.line - line), before)).toBeLessThan(1);
  for (const layout of ['aligned', 'compact'] as const) {
    await page.evaluate(layout => window.playground.viewer!.updateOptions({ layout }), layout);
    await expectNumberGeometry(page);
    await expect.poll(() => page.evaluate(line => Math.abs(window.playground.viewer!.saveViewState().original.anchor.line - line), before)).toBeLessThan(1);
  }
});

test('native scrollbar dragging can lead from either pane beside the owned center gutter', async ({ page }) => {
  await open(page, 'nearby');
  await preferences(page, { collapse: false });
  let previous = 0;
  for (const side of ['original', 'modified'] as const) {
    await page.locator(`.smart-diff-pane[data-side="${side}"]`).hover();
    const thumb = page.locator(`.smart-diff-pane[data-side="${side}"] .editor-scrollable > .scrollbar.vertical > .slider`);
    const bounds = await thumb.boundingBox();
    expect(bounds).not.toBeNull();
    const x = bounds!.x + bounds!.width / 2, y = bounds!.y + bounds!.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, y + 50, { steps: 8 }); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().original.getScrollTop())).toBeGreaterThan(previous + 200);
    await expect.poll(() => page.evaluate(() => {
      const editors = window.playground.viewer!.getEditors();
      return Math.abs(editors.original.getScrollTop() - editors.modified.getScrollTop());
    })).toBeLessThan(35);
    await expectNumberGeometry(page);
    previous = await page.evaluate(() => window.playground.viewer!.getEditors().original.getScrollTop());
  }
});

test('large real line numbers fit inside both owned number cells', async ({ page }) => {
  await open(page, 'large');
  await preferences(page, { collapse: false, sync: false });
  await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    editors.original.revealLineInCenter(19000, 1);
    editors.modified.revealLineInCenter(19000, 1);
  });
  await expectNumberGeometry(page);
  await expect.poll(() => page.evaluate(() => {
    const cells = [...document.querySelectorAll<SVGTextElement>('.smart-diff-line-number[data-line-number="19000"]')];
    return cells.length === 2 && cells.every(node => {
      const rect = node.getBBox(), left = node.dataset.numberSide === 'original' ? 0 : 104;
      return rect.x >= left && rect.x + rect.width <= left + 48;
    });
  })).toBe(true);
});
