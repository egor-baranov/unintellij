import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { workingCommitFiles } from '../apps/playground/src/commit-fixtures';

async function ready(page: Page, commit = false) {
  await expect.poll(() => page.evaluate(commit => {
    const viewer = commit ? window.commitPreview?.viewer : window.playground?.viewer;
    const comparison = viewer?.getComparison();
    return !!comparison && comparison.modifiedVersion === viewer!.getEditors().modified.getModel()!.getVersionId()
      && /^(ready|empty)$/.test(viewer!.getState().status);
  }, commit)).toBe(true);
}
async function switchMode(page: Page, mode: 'Inline' | 'Side by side', commit = false) {
  await page.getByRole('button', { name: 'Diff view', exact: true }).click();
  await page.getByRole('menuitemradio', { name: mode, exact: true }).click();
  await ready(page, commit);
  await expect(page.locator('.smart-diff')).toHaveAttribute('data-view-mode', mode === 'Inline' ? 'inline' : 'side-by-side');
}
async function capture(page: Page, name: string) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.smart-diff')).toHaveAttribute('data-status', /^(ready|empty)$/);
  await mkdir('artifacts/inline-view', { recursive: true });
  await page.screenshot({ path: `artifacts/inline-view/${name}.png` });
}
async function option(page: Page, name: string) {
  await page.getByRole('button', { name: 'Diff options', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name, exact: true }).click();
}

test('the toolbar switches between real inline changes and the existing side-by-side comparison', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?fixture=tsx'); await ready(page);
  await page.evaluate(() => {
    window.playground.setPreferences({ collapse: false });
    window.playground.setContents('export const originalOnly = "before";\nexport const shared = 1;\n', 'export const modifiedOnly = "after";\nexport const shared = 1;\n');
  });
  await ready(page);
  const count = await page.evaluate(() => window.playground.viewer!.getComparison()!.changes.length);
  await expect(page.locator('.smart-diff-gutter')).toBeVisible();
  await switchMode(page, 'Inline');
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Synchronize scrolling', exact: true })).toHaveCount(0);
  await expect(page.locator('.smart-diff-gutter')).toBeHidden();
  // Inline must display the removed source as well as the replacement, not just
  // hide the original half of the existing two-pane viewer.
  await expect(page.locator('.smart-diff')).toContainText('originalOnly');
  await expect(page.locator('.smart-diff')).toContainText('modifiedOnly');
  expect(await page.evaluate(() => window.playground.viewer!.getComparison()!.changes.length)).toBe(count);
  const dimensions = await page.evaluate(() => {
    const viewer = document.querySelector('.smart-diff')!.getBoundingClientRect();
    const editor = window.playground.viewer!.getEditors().modified.getDomNode()!.getBoundingClientRect();
    return { viewer: viewer.width, editor: editor.width };
  });
  expect(dimensions.editor).toBeGreaterThan(dimensions.viewer * .95);
  await capture(page, 'inline');
  await page.evaluate(() => {
    const editor = window.playground.viewer!.getEditors().modified; editor.focus();
    editor.setSelection({ startLineNumber: 1, startColumn: 14, endLineNumber: 1, endColumn: 26 });
  });
  await expect(page.locator('.smart-diff .selected-text').first()).toBeVisible();
  const selectedStrip = await page.evaluate(() => {
    const editor = window.playground.viewer!.getEditors().modified;
    const rect = editor.getDomNode()!.getBoundingClientRect();
    const start = editor.getScrolledVisiblePosition({ lineNumber: 1, column: 14 })!;
    const end = editor.getScrolledVisiblePosition({ lineNumber: 1, column: 26 })!;
    return { color: getComputedStyle(editor.getDomNode()!.querySelector('.selected-text')!).backgroundColor,
      clip: { x: Math.ceil(rect.left + start.left + 4), y: Math.ceil(rect.top + start.top + 2), width: Math.floor(end.left - start.left - 8), height: 2 } };
  });
  const selectedPng = await page.screenshot({ clip: selectedStrip.clip });
  const selectedFraction = await page.evaluate(async ({ png, color }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    let matching = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) if (rgb.every((channel, i) => Math.abs(channel - pixels[offset + i]) <= 2)) matching++;
    return matching / (pixels.length / 4);
  }, { png: selectedPng.toString('base64'), color: selectedStrip.color });
  expect(selectedFraction, 'Selection must paint above inline insertion and character highlighting').toBeGreaterThan(.9);
  await capture(page, 'inline-selection');
  await switchMode(page, 'Side by side');
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Synchronize scrolling', exact: true })).toBeVisible();
  await expect(page.locator('.smart-diff-gutter')).toBeVisible();
  expect(await page.evaluate(() => window.playground.viewer!.getComparison()!.changes.length)).toBe(count);
  await capture(page, 'side-by-side');
  expect(errors).toEqual([]);
});

test('switching modes preserves editable drafts, undo history, read-only originals and the save action', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
  await page.goto('/?view=commit&file=playground-main'); await ready(page, true);
  const fixture = workingCommitFiles.find(file => file.id === 'playground-main')!;
  const label = `Commit: ${fixture.path} — working`;
  const tab = page.getByRole('tab', { name: label, exact: true });
  const dirty = tab.getByRole('img', { name: 'Unsaved changes', exact: true });
  const before = await page.evaluate(() => {
    const { original, modified } = window.commitPreview.viewer!.getEditors();
    modified.setPosition({ lineNumber: 1, column: 1 }); modified.focus(); modified.pushUndoStop();
    return { baseline: original.getValue(), modified: modified.getValue(), uri: modified.getModel()!.uri.toString() };
  });
  await page.keyboard.type('draftPrefix');
  await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.pushUndoStop());
  await expect(dirty).toBeVisible();
  await switchMode(page, 'Inline', true);
  const inline = await page.evaluate(() => {
    const { original, modified } = window.commitPreview.viewer!.getEditors();
    const option = window.projectPreview.monaco.editor.EditorOption;
    return { original: original.getValue(), text: modified.getValue(), uri: modified.getModel()!.uri.toString(), canUndo: modified.getModel()!.canUndo(), readonly: original.getOption(option.readOnly) };
  });
  expect(inline).toEqual({ original: before.baseline, text: `draftPrefix${before.modified}`, uri: before.uri, canUndo: true, readonly: true });
  await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.focus());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getValue())).toBe(before.modified);
  await expect(dirty).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(dirty).toBeVisible();
  await switchMode(page, 'Side by side', true);
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getValue())).toBe(`draftPrefix${before.modified}`);
  await switchMode(page, 'Inline', true);
  await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.focus());
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dirty).toHaveCount(0);
  await page.getByRole('button', { name: `Close ${label}`, exact: true }).click();
  await expect(tab).toHaveCount(0);
  await page.evaluate(() => window.commitPreview.selectFile('playground-main')); await ready(page, true);
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getValue())).toBe(`draftPrefix${before.modified}`);
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().original.getValue())).toBe(before.baseline);
});

test('navigation, folding, wrapping and resizing remain available in inline mode', async ({ page }) => {
  await page.goto('/?fixture=folds'); await ready(page);
  await switchMode(page, 'Inline');
  const count = await page.evaluate(() => window.playground.getState().changeCount);
  const before = await page.evaluate(() => window.playground.getState().currentChange);
  await page.getByRole('button', { name: 'Next change', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.playground.getState().currentChange)).toBe((before + 1) % count);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => page.evaluate(() => window.playground.getState().currentChange)).toBe(before);
  await expect(page.locator('.diff-hidden-lines-widget:visible').first()).toBeVisible();
  const collapsedHeight = await page.evaluate(() => window.playground.viewer!.getEditors().modified.getScrollHeight());
  await option(page, 'Collapse unchanged');
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getScrollHeight())).toBeGreaterThan(collapsedHeight + 1000);
  await option(page, 'Collapse unchanged');
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getScrollHeight())).toBeLessThan(collapsedHeight + 100);
  await page.evaluate(() => { window.playground.selectFixture('wrapping'); window.playground.setPreferences({ collapse: false, wrap: false }); });
  await ready(page);
  const plainHeight = await page.evaluate(() => window.playground.viewer!.getEditors().modified.getScrollHeight());
  await option(page, 'Wrap long lines');
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getScrollHeight())).toBeGreaterThan(plainHeight + 100);
  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(() => page.evaluate(() => {
    const editor = window.playground.viewer!.getEditors().modified.getDomNode()!.getBoundingClientRect();
    const root = document.querySelector('.smart-diff')!.getBoundingClientRect();
    // Native inline keeps a narrow original-line-number gutter to the left.
    return Math.abs(editor.right - root.right);
  })).toBeLessThan(4);
  await capture(page, 'inline-wrapped-narrow');
  await switchMode(page, 'Side by side');
  expect(await page.evaluate(() => window.playground.viewer!.getEditors().modified.getOption(window.playground.monaco.editor.EditorOption.wordWrap))).toBe('on');
});

test('each comparison tab remembers its mode without changing added or deleted single-file views', async ({ page }) => {
  await page.goto('/?view=commit&file=preferences'); await ready(page, true);
  await switchMode(page, 'Inline', true);
  await page.evaluate(() => window.commitPreview.selectFile('playground-main')); await ready(page, true);
  await switchMode(page, 'Side by side', true);
  await page.evaluate(() => window.commitPreview.selectFile('preferences')); await ready(page, true);
  await expect(page.locator('.smart-diff')).toHaveAttribute('data-view-mode', 'inline');
  await page.evaluate(() => window.commitPreview.selectFile('playground-main')); await ready(page, true);
  await expect(page.locator('.smart-diff')).toHaveAttribute('data-view-mode', 'side-by-side');
  for (const id of ['removed-yaml', 'mapping-staged']) {
    await page.evaluate(id => window.commitPreview.selectFile(id), id);
    await expect(page.getByTestId('file-surface')).toBeVisible();
    await expect(page.locator('.smart-diff')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Diff view', exact: true })).toHaveCount(0);
  }
  await page.evaluate(() => window.commitPreview.selectFile('preferences')); await ready(page, true);
  await expect(page.locator('.smart-diff')).toHaveAttribute('data-view-mode', 'inline');
  await capture(page, 'commit-inline');
});

test('rapid switching and unmounting release inline editor state and reject stale comparisons', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?fixture=tsx'); await ready(page);
  for (let cycle = 0; cycle < 3; cycle++) {
    await switchMode(page, 'Inline');
    await page.evaluate(() => { window.playground.selectFixture('large'); window.playground.selectFixture('empty'); });
    await ready(page);
    expect(await page.evaluate(() => window.playground.viewer!.getComparison()!.changes.length)).toBe(0);
    await page.evaluate(() => window.playground.setMounted(false));
    await expect(page.locator('.smart-diff')).toHaveCount(0);
    expect(await page.evaluate(() => window.playground.monaco.editor.getModels().length)).toBe(0);
    await page.evaluate(() => { window.playground.selectFixture('tsx'); window.playground.setMounted(true); }); await ready(page);
    await switchMode(page, 'Side by side');
    expect(await page.evaluate(() => window.playground.monaco.editor.getModels().length)).toBe(2);
  }
  expect(errors).toEqual([]);
});


test('change navigation reveals tall deleted ranges at the beginning, middle and end', async ({ page }) => {
  await page.goto('/?fixture=tsx'); await ready(page);
  await page.evaluate(() => window.playground.setPreferences({ collapse: false }));
  await switchMode(page, 'Inline');
  const lines = Array.from({ length: 220 }, (_, index) => `const source${index} = ${index};`);
  for (const start of [0, 75, 150]) {
    await page.evaluate(({ original, modified }) => window.playground.setContents(original, modified), {
      original: lines.join('\n'), modified: [...lines.slice(0, start), ...lines.slice(start + 70)].join('\n'),
    });
    await ready(page);
    expect(await page.evaluate(() => window.playground.viewer!.getComparison()!.changes.map(change => change.kind))).toEqual(['delete']);
    await page.getByRole('button', { name: 'Next change', exact: true }).click();
    const firstRemovedLine = page.locator('.monaco-editor .view-zones .view-line').filter({ hasText: `const source${start} = ${start};` }).first();
    await expect(firstRemovedLine).toBeInViewport();
    await expect(page.locator('.smart-diff')).toHaveAttribute('data-status', 'ready');
    await capture(page, `inline-deletion-${start === 0 ? 'start' : start === 75 ? 'middle' : 'end'}`);
  }
});
