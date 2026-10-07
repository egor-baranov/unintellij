import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { deriveCollapsedRegions } from '../packages/monaco-smart-diff/src/folding/regions';

async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => window.playground?.viewer?.getState().status)).toMatch(/^(ready|empty)$/);
}

for (const mode of ['Side by side', 'Inline'] as const) {
  test(`${mode}: toolbar expands every unchanged region and collapses manually expanded regions`, async ({ page }) => {
    await page.goto('/?fixture=folds'); await ready(page);
    if (mode === 'Inline') {
      await page.getByRole('button', { name: 'Diff view', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'Inline', exact: true }).click();
      await ready(page);
    }
    const toolbar = page.getByRole('toolbar', { name: 'Diff controls' });
    const expand = toolbar.getByRole('button', { name: 'Expand all unchanged regions', exact: true });
    const collapse = toolbar.getByRole('button', { name: 'Collapse all unchanged regions', exact: true });
    const comparison = await page.evaluate(() => window.playground.viewer!.getComparison()!);
    const regions = deriveCollapsedRegions(comparison, { contextLines: 3, minimumHiddenLines: 6 });
    expect(regions.length).toBeGreaterThan(1);
    const heights = () => page.evaluate(regions => {
      const editors = window.playground.viewer!.getEditors();
      return regions.flatMap(region => (['original', 'modified'] as const).map(side =>
        editors[side].getLineHeightForPosition({ lineNumber: region[side].start, column: 1 })));
    }, regions);
    const hidden = Array(regions.length * 2).fill(0);
    await expect.poll(heights).toEqual(hidden);
    const before = await page.evaluate(() => {
      const editors = window.playground.viewer!.getEditors();
      const line = window.playground.viewer!.getComparison()!.changes[0].modified.start;
      editors.modified.setSelection({ startLineNumber: line, endLineNumber: line, startColumn: 1, endColumn: 4 });
      return { text: editors.modified.getValue(), selection: editors.modified.getSelection(), uri: editors.modified.getModel()!.uri.toString() };
    });
    await expand.click();
    await expect.poll(async () => (await heights()).every(height => height > 0)).toBe(true);
    // Repeat actions to exercise idempotence and keyboard activation.
    await expand.focus(); await page.keyboard.press('Enter');
    await expect.poll(async () => (await heights()).every(height => height > 0)).toBe(true);
    await collapse.click();
    await expect.poll(heights).toEqual(hidden);
    await page.evaluate(id => window.playground.viewer!.expandRegion(id), regions[0].id);
    await expect.poll(async () => (await heights())[1]).toBeGreaterThan(0);
    await collapse.click();
    await expect.poll(heights).toEqual(hidden);
    // A global folding preference previously turned off must not make the
    // explicit Collapse All command silently do nothing.
    await page.evaluate(() => window.playground.setPreferences({ collapse: false, wrap: true }));
    await expect.poll(async () => (await heights()).every(height => height > 0)).toBe(true);
    await collapse.click();
    await expect.poll(heights).toEqual(hidden);
    expect(await page.evaluate(() => {
      const editor = window.playground.viewer!.getEditors().modified;
      return { text: editor.getValue(), selection: editor.getSelection(), uri: editor.getModel()!.uri.toString() };
    })).toEqual(before);
    await mkdir('artifacts/bulk-folding', { recursive: true });
    await page.screenshot({ path: `artifacts/bulk-folding/${mode === 'Inline' ? 'inline' : 'side-by-side'}.png` });
  });
}

test('bulk folding controls are disabled for a comparison with no changes', async ({ page }) => {
  await page.goto('/?fixture=empty'); await ready(page);
  await expect(page.getByRole('button', { name: 'Expand all unchanged regions', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Collapse all unchanged regions', exact: true })).toBeDisabled();
});
