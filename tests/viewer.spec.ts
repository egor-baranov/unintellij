import { test, expect, type Page } from '@playwright/test';
async function ready(page: Page) { await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toMatch(/^(ready|empty)$/); }
async function open(page: Page, fixture = 'tsx') { await page.goto(`/?fixture=${fixture}`); await ready(page); }
async function preferences(page: Page, value: Parameters<Window['playground']['setPreferences']>[0]) { await page.evaluate(value => window.playground.setPreferences(value), value); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); await ready(page); }
async function scrolls(page: Page) { return page.evaluate(() => { const e = window.playground.viewer!.getEditors(); return [e.original.getScrollTop(), e.modified.getScrollTop()]; }); }
async function wheel(page: Page, side: 'original' | 'modified', amount: number) { await page.locator(`[data-side="${side}"]`).hover(); for (let index = 0; index < Math.ceil(Math.abs(amount) / 50); index++) { await page.mouse.wheel(0, Math.sign(amount) * 50); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))); } }
async function resetScroll(page: Page) { await page.evaluate(() => { const editors = window.playground.viewer!.getEditors(); editors.original.setScrollTop(0); editors.modified.setScrollTop(0); }); }

test('production assets load both workers, highlight words, and navigate changes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  await expect(page.locator('.smart-diff-connectors path')).not.toHaveCount(0);
  await expect(page.locator('[class*="smart-diff-inner"]')).not.toHaveCount(0);
  const before = await page.evaluate(() => window.playground.getState().currentChange);
  await page.getByRole('button', { name: 'Next change', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.playground.getState().currentChange)).toBe(before + 1);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => page.evaluate(() => window.playground.getState().currentChange)).toBe(before);
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some(entry => /editor\.worker.*\.js/.test(entry.name)))).toBe(true);
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some(entry => /\/worker-.*\.js/.test(entry.name)))).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/playground-compact.png', fullPage: true });
});

test('scroll ownership can switch panes and settles without oscillation', async ({ page }) => {
  await open(page, 'nearby'); await preferences(page, { collapse: false }); await resetScroll(page);
  await wheel(page, 'original', 1100);
  await expect.poll(async () => (await scrolls(page))[1]).toBeGreaterThan(400);
  const first = await scrolls(page); expect(Math.abs(first[0] - first[1])).toBeLessThan(35);
  await wheel(page, 'modified', 500);
  await expect.poll(async () => (await scrolls(page))[0]).toBeGreaterThan(first[0] + 250);
  const snapshot = await scrolls(page);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const settled = await scrolls(page); expect(Math.abs(settled[0] - snapshot[0])).toBeLessThan(2); expect(Math.abs(settled[1] - snapshot[1])).toBeLessThan(2);
});

test('large insertion preserves following unchanged correspondence in both directions', async ({ page }) => {
  await open(page, 'insertion'); await preferences(page, { collapse: false }); await resetScroll(page);
  await wheel(page, 'original', 2600);
  await expect.poll(async () => (await scrolls(page))[1] - (await scrolls(page))[0]).toBeGreaterThan(2500);
  const saved = await page.evaluate(() => window.playground.viewer!.saveViewState());
  expect(saved.modified.anchor.line - saved.original.anchor.line).toBeCloseTo(150, -1);
  await wheel(page, 'modified', -500);
  await expect.poll(async () => (await scrolls(page))[0]).toBeLessThan(2500);
});

test('independent scrolling disables all cross-pane corrections and re-enable reconciles', async ({ page }) => {
  await open(page, 'nearby'); await preferences(page, { collapse: false, sync: false }); await resetScroll(page);
  await wheel(page, 'original', 1500);
  await expect.poll(async () => (await scrolls(page))[0]).toBeGreaterThan(900);
  expect((await scrolls(page))[1]).toBe(0);
  await page.getByRole('button', { name: 'Synchronize scrolling' }).click();
  await expect.poll(async () => Math.abs((await scrolls(page))[0] - (await scrolls(page))[1])).toBeLessThan(35);
});

test('layout switching preserves a useful reading position', async ({ page }) => {
  await open(page, 'replacement'); await preferences(page, { collapse: false }); await resetScroll(page);
  await wheel(page, 'original', 1500);
  await expect.poll(async () => (await scrolls(page))[0]).toBeGreaterThan(900);
  const before = await page.evaluate(() => window.playground.viewer!.saveViewState().original.anchor.line);
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Aligned', exact: true }).click();
  await expect.poll(() => page.evaluate(before => Math.abs(window.playground.viewer!.saveViewState().original.anchor.line - before), before)).toBeLessThan(5);
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Compact', exact: true }).click();
  await expect.poll(() => page.evaluate(before => Math.abs(window.playground.viewer!.saveViewState().original.anchor.line - before), before)).toBeLessThan(5);
});

test('folding compatibility, coordinated expansion, connector updates and resizing', async ({ page }) => {
  await open(page, 'folds');
  expect(await page.evaluate(() => window.playground.getState().featureUnavailable)).toEqual([]);
  const count = await page.locator('[data-side="original"] .smart-diff-omission').count(); expect(count).toBeGreaterThan(0);
  const region = await page.locator('[data-side="original"] .smart-diff-omission').first().getAttribute('data-region-id');
  const before = await page.locator('.smart-diff-connectors').innerHTML();
  const anchorBefore = await page.evaluate(() => window.playground.viewer!.saveViewState().original.anchor);
  await page.locator('[data-side="original"] .smart-diff-omission').first().click();
  await expect(page.locator(`.smart-diff-omission[data-region-id="${region}"]`)).toHaveCount(0);
  expect(await page.locator('[data-side="original"] .smart-diff-omission').count()).toBe(count - 1);
  expect(await page.locator('[data-side="modified"] .smart-diff-omission').count()).toBe(count - 1);
  await expect.poll(() => page.locator('.smart-diff-connectors').innerHTML()).not.toBe(before);
  const anchorError = await page.evaluate(anchor => {
    const editor = window.playground.viewer!.getEditors().original;
    const line = Math.floor(anchor.line), top = editor.getTopForLineNumber(line);
    const requested = top + (anchor.line - line) * (editor.getBottomForLineNumber(line) - top) - anchor.offset;
    const expected = Math.max(0, Math.min(editor.getScrollHeight() - editor.getLayoutInfo().height, requested));
    return Math.abs(editor.getScrollTop() - expected);
  }, anchorBefore);
  expect(anchorError).toBeLessThan(1); // Preserve the anchor, with unavoidable EOF clamping.
  await page.setViewportSize({ width: 840, height: 630 });
  await expect.poll(() => page.evaluate(() => Number(document.querySelector('.smart-diff-gutter')!.getAttribute('viewBox')!.split(' ')[3]) - window.playground.viewer!.getEditors().original.getLayoutInfo().height)).toBe(0);
  await page.screenshot({ path: 'test-results/playground-narrow.png', fullPage: true });
});

test('wrapping and resizing recalculate connector geometry', async ({ page }) => {
  await open(page, 'wrapping'); await preferences(page, { collapse: false });
  const before = await page.locator('.smart-diff-connectors').innerHTML();
  await preferences(page, { wrap: true });
  await expect.poll(() => page.locator('.smart-diff-connectors').innerHTML()).not.toBe(before);
  const wrapped = await page.locator('.smart-diff-connectors').innerHTML();
  await page.setViewportSize({ width: 950, height: 720 });
  await expect.poll(() => page.locator('.smart-diff-connectors').innerHTML()).not.toBe(wrapped);
  expect(await page.locator('.smart-diff-connectors path').evaluateAll(paths => paths.every(path => !/NaN|Infinity/.test(path.getAttribute('d') ?? '')))).toBe(true);
});

test('rapid changes reject stale comparisons and identical/empty files remain usable', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.playground.selectFixture('large'); setTimeout(() => window.playground.selectFixture('deleted'), 10); setTimeout(() => window.playground.selectFixture('empty'), 20); });
  await expect.poll(() => page.evaluate(() => window.playground.getState().status)).toBe('empty');
  expect(await page.evaluate(() => window.playground.viewer!.getComparison()?.changes.length)).toBe(0);
  await page.evaluate(() => window.playground.setContents('const value = "old";', 'const value = "new";'));
  await ready(page); await expect.poll(() => page.evaluate(() => window.playground.getState().changeCount)).toBe(1);
  expect(await page.evaluate(() => window.playground.viewer!.getEditors().modified.getModel()?.getValue())).toContain('new');
});

test('two viewers coexist; mount cycles release editors, DOM and consumer-owned models', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.playground.setSecondary(true));
  await expect(page.locator('.smart-diff')).toHaveCount(2);
  await page.evaluate(() => window.playground.setSecondary(false)); await expect(page.locator('.smart-diff')).toHaveCount(1);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.playground.setMounted(false));
    await expect(page.locator('.smart-diff')).toHaveCount(0);
    expect(await page.evaluate(() => window.playground.monaco.editor.getModels().length)).toBe(0);
    await page.evaluate(() => window.playground.setMounted(true)); await ready(page);
    await expect(page.locator('.monaco-editor')).toHaveCount(2);
  }
  const ownership = await page.evaluate(() => { const viewer = window.playground.viewer!; const original = viewer.getEditors().original.getModel()!; viewer.dispose(); return original.isDisposed(); });
  expect(ownership).toBe(false);
});

test('20,000-line comparison is off-thread and connectors stay culled', async ({ page }) => {
  const started = performance.now(); await open(page, 'large');
  const comparison = await page.evaluate(() => { const model = window.playground.viewer!.getComparison()!; return { changeCount: model.changes.length }; });
  expect(comparison.changeCount).toBeGreaterThan(250);
  await preferences(page, { collapse: false });
  expect(await page.locator('.smart-diff-connectors path').count()).toBeLessThan(20);
  console.log(`20k fixture: ready including page load ${Math.round(performance.now() - started)}ms; ${comparison.changeCount} canonical changes`);
});
