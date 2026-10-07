import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ViewState } from 'monaco-smart-diff';

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function open(page: Page, fixture = 'nearby') {
  await page.goto(`/?fixture=${fixture}`);
  await expect.poll(() => page.evaluate(() => window.playground?.viewer?.getState().status)).toBe('ready');
  await settle(page);
}
const separator = (page: Page) => page.getByRole('separator', { name: 'Resize diff panes', exact: true });
async function drag(page: Page, handle: Locator, distance: number) {
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(180, box.height / 2));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + distance, box.y + Math.min(180, box.height / 2), { steps: 8 });
  await page.mouse.up();
  await settle(page);
}
async function anchorsPreserved(page: Page, state: ViewState) {
  await expect.poll(() => page.evaluate(saved => {
    const editors = window.playground.viewer!.getEditors();
    return Math.max(...(['original', 'modified'] as const).map(side => {
      const editor = editors[side], anchor = saved[side].anchor;
      const line = Math.floor(anchor.line), top = editor.getTopForLineNumber(line);
      const target = top + (anchor.line - line) * (editor.getBottomForLineNumber(line) - top) - anchor.offset;
      const expected = Math.max(0, Math.min(editor.getScrollHeight() - editor.getLayoutInfo().height, target));
      return Math.abs(editor.getScrollTop() - expected);
    }));
  }, state)).toBeLessThan(2);
}
async function geometryCurrent(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    const panes = [...document.querySelectorAll<HTMLElement>('.smart-diff-pane')];
    return panes.every(pane => Math.abs(pane.getBoundingClientRect().width - editors[pane.dataset.side as 'original' | 'modified'].getLayoutInfo().width) < 1)
      && [...document.querySelectorAll<SVGTextElement>('.smart-diff-line-number')].every(node => {
        const editor = editors[node.dataset.numberSide as 'original' | 'modified'];
        const line = Number(node.dataset.lineNumber);
        const expected = editor.getTopForLineNumber(line) - editor.getScrollTop() + editor.getLineHeightForPosition({ lineNumber: line, column: 1 }) / 2;
        return Math.abs(Number(node.getAttribute('y')) - expected) < 1;
      })
      && [...document.querySelectorAll('.smart-diff-connectors path')].every(path => !/NaN|Infinity/.test(path.getAttribute('d') ?? ''));
  })).toBe(true);
}

test('dragging the center divider changes pane widths while retaining selections and reading positions', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.playground.setPreferences({ collapse: false, sync: false }));
  await settle(page);
  const before = await page.evaluate(() => {
    const viewer = window.playground.viewer!, editors = viewer.getEditors();
    editors.original.setSelection({ startLineNumber: 42, startColumn: 2, endLineNumber: 44, endColumn: 8 });
    editors.modified.setSelection({ startLineNumber: 60, startColumn: 3, endLineNumber: 60, endColumn: 12 });
    editors.original.setScrollTop(1000); editors.modified.setScrollTop(1300);
    return viewer.saveViewState();
  });
  const handle = separator(page);
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  expect((await handle.boundingBox())!.width).toBeLessThanOrEqual(10);
  const oldWidth = await page.evaluate(() => window.playground.viewer!.getEditors().original.getLayoutInfo().width);
  await drag(page, handle, 180);
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().original.getLayoutInfo().width)).toBeGreaterThan(oldWidth + 170);
  expect(await page.evaluate(() => window.playground.viewer!.saveViewState().splitRatio)).toBeGreaterThan(.6);
  await anchorsPreserved(page, before);
  const after = await page.evaluate(() => window.playground.viewer!.saveViewState());
  expect(after.original.selections).toEqual(before.original.selections);
  expect(after.modified.selections).toEqual(before.modified.selections);
  await geometryCurrent(page);
  await handle.dblclick();
  await expect(handle).toHaveAttribute('aria-valuenow', '50');
  await expect(page.locator('.smart-diff')).not.toHaveClass(/smart-diff-resizing/);
});

test('keyboard bounds, programmatic updates, and view-state restoration use the effective split', async ({ page }) => {
  await open(page);
  const handle = separator(page);
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '52');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '62');
  await page.keyboard.press('Home');
  expect(await handle.getAttribute('aria-valuenow')).toBe(await handle.getAttribute('aria-valuemin'));
  await page.keyboard.press('End');
  expect(await handle.getAttribute('aria-valuenow')).toBe(await handle.getAttribute('aria-valuemax'));
  await page.keyboard.press('Enter');
  await expect(handle).toHaveAttribute('aria-valuenow', '50');
  await page.evaluate(() => window.playground.viewer!.updateOptions({ splitRatio: .64 }));
  await expect(handle).toHaveAttribute('aria-valuenow', '64');
  const saved = await page.evaluate(() => window.playground.viewer!.saveViewState());
  await page.evaluate(() => window.playground.viewer!.updateOptions({ splitRatio: .35 }));
  await expect(handle).toHaveAttribute('aria-valuenow', '35');
  await page.evaluate(state => window.playground.viewer!.restoreViewState(state), saved);
  await expect(handle).toHaveAttribute('aria-valuenow', '64');
  await page.evaluate(state => {
    delete state.splitRatio;
    window.playground.viewer!.updateOptions({ splitRatio: .55 });
    window.playground.viewer!.restoreViewState(state);
  }, saved);
  await expect(handle).toHaveAttribute('aria-valuenow', '55');
  expect(await page.evaluate(() => {
    const changes: number[] = [];
    const viewer = window.playground.viewer!;
    viewer.updateOptions({ onSplitRatioChange: ratio => changes.push(ratio), splitRatio: .6 });
    viewer.updateOptions({ splitRatio: .6 });
    return changes;
  })).toEqual([.6]);
  await page.setViewportSize({ width: 470, height: 650 });
  await expect(handle).toHaveAttribute('aria-valuenow', '50');
  await geometryCurrent(page);
});

test('dragging recalculates wrapped aligned geometry and coordinated folded regions', async ({ page }) => {
  await open(page, 'wrapping');
  await page.evaluate(() => window.playground.setPreferences({ collapse: false, wrap: true, layout: 'aligned', sync: false }));
  await settle(page);
  await page.evaluate(() => { const editors = window.playground.viewer!.getEditors(); editors.original.setScrollTop(1100); editors.modified.setScrollTop(1100); });
  const saved = await page.evaluate(() => window.playground.viewer!.saveViewState());
  const before = await page.locator('.smart-diff-connectors').innerHTML();
  await drag(page, separator(page), -190);
  await expect.poll(() => page.locator('.smart-diff-connectors').innerHTML()).not.toBe(before);
  await anchorsPreserved(page, saved);
  await geometryCurrent(page);
  await page.setViewportSize({ width: 970, height: 690 });
  await geometryCurrent(page);

  await page.evaluate(() => { window.playground.selectFixture('folds'); window.playground.setPreferences({ collapse: true, wrap: false }); });
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getState().changeCount)).toBe(3);
  const omissions = await page.locator('[data-side="original"] .smart-diff-omission').count();
  expect(omissions).toBeGreaterThan(0);
  await drag(page, separator(page), 80);
  await expect(page.locator('[data-side="original"] .smart-diff-omission')).toHaveCount(omissions);
  await expect(page.locator('[data-side="modified"] .smart-diff-omission')).toHaveCount(omissions);
  await geometryCurrent(page);
  await page.screenshot({ path: 'test-results/divider-aligned-folded.png' });
});

test('two dividers remain independent and disposing during pointer capture cleans up the drag', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.playground.setSecondary(true));
  await expect(separator(page)).toHaveCount(2);
  const first = separator(page).first(), second = separator(page).last();
  await second.focus(); await page.keyboard.press('ArrowRight');
  await expect(second).toHaveAttribute('aria-valuenow', '52');
  await expect(first).toHaveAttribute('aria-valuenow', '50');
  await first.focus(); await page.keyboard.press('ArrowLeft');
  await expect(first).toHaveAttribute('aria-valuenow', '48');
  await expect(second).toHaveAttribute('aria-valuenow', '52');
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 90); await page.mouse.down();
  await expect(page.locator('.smart-diff').first()).toHaveClass(/smart-diff-resizing/);
  await page.evaluate(() => window.playground.setMounted(false));
  await page.mouse.move(box.x + 70, box.y + 90); await page.mouse.up();
  await expect(page.locator('.smart-diff-resizing')).toHaveCount(0);
  await expect(separator(page)).toHaveCount(1);
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '52');
  await page.evaluate(() => { window.playground.setSecondary(false); window.playground.setMounted(true); });
  await expect.poll(() => page.evaluate(() => window.playground.viewer?.getState().status)).toBe('ready');
  await settle(page);
  await expect(separator(page)).toHaveCount(1);
  await separator(page).focus(); await page.keyboard.press('Enter');
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '50');
});
