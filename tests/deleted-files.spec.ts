import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { workingCommitFiles } from '../apps/playground/src/commit-fixtures';

const fixture = (id: string) => workingCommitFiles.find(file => file.id === id)!;
const surface = (page: Page) => page.getByTestId('file-surface');
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function choose(page: Page, id: string, single = true) {
  await page.evaluate(selected => window.commitPreview.selectFile(selected), id);
  await expect.poll(() => page.evaluate(({ id, single }) => {
    const preview = window.commitPreview;
    return preview.getSelected() === id && preview.getState().status === 'ready'
      && (single ? !!preview.editor?.getModel() && !preview.viewer : !!preview.viewer?.getComparison() && !preview.editor);
  }, { id, single })).toBe(true);
  await settle(page);
}
async function open(page: Page, id = 'removed-yaml') {
  await page.goto(`/?view=commit&file=${id}`);
  await expect.poll(() => page.evaluate(() => Boolean(window.commitPreview))).toBe(true);
  await choose(page, id);
}
async function capture(page: Page, name: string) {
  await mkdir('artifacts/deleted-single-pane', { recursive: true });
  await page.screenshot({ path: `artifacts/deleted-single-pane/${name}.png` });
}

test('deleted tracked files open complete original contents in one full-width read-only editor', async ({ page }) => {
  const diffWorkers: string[] = [];
  const record = (url: string) => {
    if (/\/(?:worker(?:-[^/?]+)?\.js|diff\/worker\.ts)(?:\?|$)/.test(url)) diffWorkers.push(url);
  };
  page.on('request', request => record(request.url()));
  page.on('worker', worker => record(worker.url()));
  await open(page);
  for (const id of ['removed-yaml', 'removed-script']) {
    await choose(page, id);
    await expect(surface(page)).toHaveAttribute('data-deleted', 'true');
    await expect(surface(page)).toHaveAttribute('data-editable', 'false');
    await expect(surface(page)).toHaveAttribute('data-path', fixture(id).path);
    await expect(page.locator('.monaco-editor')).toHaveCount(1);
    await expect(page.locator('.smart-diff, .smart-diff-gutter, .source-headers, .editor-toolbar')).toHaveCount(0);
    const state = await page.evaluate(() => {
      const editor = window.commitPreview.editor!, model = editor.getModel()!;
      const decoration = model.getAllDecorations().find(item => item.options.className === 'deleted-file-line');
      return { text: model.getValue(), readOnly: editor.getOption(window.projectPreview.monaco.editor.EditorOption.readOnly),
        language: model.getLanguageId(), end: decoration?.range.endLineNumber, lines: model.getLineCount(),
        lastHeight: editor.getLineHeightForPosition({ lineNumber: model.getLineCount(), column: 1 }),
        width: editor.getLayoutInfo().width, mainWidth: document.querySelector('main')!.getBoundingClientRect().width };
    });
    expect(state.text).toBe(fixture(id).original);
    expect(state.readOnly).toBe(true);
    expect(state.language).toBe(id === 'removed-yaml' ? 'yaml' : 'typescript');
    expect(state.end).toBe(state.lines - 1);
    expect(state.lastHeight).toBe(0);
    expect(Math.abs(state.width - state.mainWidth)).toBeLessThan(2);
    await page.evaluate(() => { const editor = window.commitPreview.editor!; editor.focus(); editor.setPosition({ lineNumber: 1, column: 1 }); });
    await page.keyboard.type('do not edit');
    expect(await page.evaluate(() => window.commitPreview.editor!.getModel()!.getValue())).toBe(fixture(id).original);
  }
  expect(diffWorkers).toEqual([]);
  await choose(page, 'removed-yaml');
  const spans = surface(page).locator('.view-line span');
  for (const [text, color] of [['apiVersion', 'rgb(255, 203, 107)'], ['true', 'rgb(192, 133, 255)']]) {
    await expect.poll(() => spans.evaluateAll((nodes, word) => {
      const node = nodes.find(node => node.textContent?.trim() === word);
      return node && getComputedStyle(node).color;
    }, text)).toBe(color);
  }
  await expect(surface(page).locator('.deleted-file-line').first()).toHaveCSS('background-color', 'rgb(56, 35, 44)');
  await expect(surface(page).locator('.deleted-file-margin').first()).toHaveCSS('background-color', 'rgb(56, 35, 44)');
  await capture(page, 'deleted-yaml');
});

test('deleted-file selections paint above deletion shading and survive switching and resizing', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const editor = window.commitPreview.editor!;
    editor.focus(); editor.setSelection({ startLineNumber: 2, startColumn: 1, endLineNumber: 6, endColumn: 14 }); editor.render(true);
  });
  await settle(page);
  const selection = await page.evaluate(() => window.commitPreview.editor!.getSelection());
  const uri = await page.evaluate(() => window.commitPreview.editor!.getModel()!.uri.toString());
  const geometry = await page.evaluate(() => {
    const editor = window.commitPreview.editor!, rect = editor.getDomNode()!.getBoundingClientRect();
    const start = editor.getScrolledVisiblePosition({ lineNumber: 3, column: 1 })!;
    const end = editor.getScrolledVisiblePosition({ lineNumber: 3, column: editor.getModel()!.getLineMaxColumn(3) })!;
    const color = getComputedStyle(document.querySelector('.file-surface-deleted .selected-text')!).backgroundColor;
    return { clip: { x: Math.ceil(rect.left + start.left + 3), y: Math.ceil(rect.top + start.top + 2), width: Math.floor(end.left - start.left - 6), height: 2 }, color };
  });
  const png = await page.screenshot({ clip: geometry.clip });
  const selectedPixels = await page.evaluate(async ({ png, color }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    let matching = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) if (rgb.every((channel, i) => Math.abs(channel - pixels[offset + i]) <= 2)) matching++;
    return matching / (pixels.length / 4);
  }, { png: png.toString('base64'), color: geometry.color });
  expect(selectedPixels, 'Selection must be visibly painted over the deletion fill').toBeGreaterThan(.9);
  await capture(page, 'deleted-yaml-selection');
  await choose(page, 'preferences', false);
  await expect(page.locator('.monaco-editor')).toHaveCount(2);
  expect(await page.evaluate(uri => window.projectPreview.monaco.editor.getModels().some(model => model.uri.toString() === uri), uri)).toBe(false);
  await choose(page, 'removed-yaml');
  expect(await page.evaluate(() => window.commitPreview.editor!.getSelection())).toEqual(selection);
  await page.setViewportSize({ width: 860, height: 700 });
  await expect.poll(() => page.evaluate(() => Math.abs(window.commitPreview.editor!.getLayoutInfo().width - document.querySelector('main')!.getBoundingClientRect().width))).toBeLessThan(2);
  await expect(surface(page).locator('.deleted-file-margin').first()).toBeVisible();
});

test('deletion is determined by Git state, including empty files, while added and modified behavior is preserved', async ({ page }) => {
  await open(page, 'empty-deleted');
  await expect(surface(page)).toHaveAttribute('data-deleted', 'true');
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  expect(await page.evaluate(() => window.commitPreview.editor!.getModel()!.getValue())).toBe('');
  await expect(page.locator('.deleted-file-line, .deleted-file-margin')).toHaveCount(0);
  await choose(page, 'mapping-staged');
  await expect(surface(page)).toHaveAttribute('data-added', 'true');
  await expect(surface(page)).not.toHaveAttribute('data-deleted', 'true');
  await expect(surface(page)).toHaveAttribute('data-editable', 'true');
  await expect(surface(page).locator('.added-file-line').first()).toHaveCSS('background-color', 'rgb(38, 75, 51)');
  await page.evaluate(() => { const editor = window.commitPreview.editor!; editor.focus(); editor.setPosition({ lineNumber: 1, column: 1 }); });
  await page.keyboard.type('// edited ');
  expect(await page.evaluate(() => window.commitPreview.editor!.getModel()!.getValue())).toBe(`// edited ${fixture('mapping-staged').modified}`);
  await choose(page, 'emptied-modified', false);
  await expect(page.locator('.monaco-editor')).toHaveCount(2);
  await expect(page.locator('.smart-diff')).toHaveCount(1);
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().original.getModel()!.getValue())).toBe(fixture('emptied-modified').original);
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getModel()!.getValue())).toBe('');
  await expect(page.getByRole('button', { name: 'Next change', exact: true })).toBeVisible();
});
