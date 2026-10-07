import { expect, test, type Page } from '@playwright/test';
import { workingCommitFiles } from '../apps/playground/src/commit-fixtures';
import { fixtures } from '../apps/playground/src/fixtures';

const fixture = (id: string) => workingCommitFiles.find(file => file.id === id)!;
const surface = (page: Page) => page.getByTestId('file-surface');
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function chooseAdded(page: Page, id = 'new-panel') {
  await page.evaluate(selected => window.commitPreview.selectFile(selected), id);
  await expect.poll(() => page.evaluate(selected => {
    const preview = window.commitPreview;
    return preview.getSelected() === selected && preview.getState().status === 'ready' && !!preview.editor?.getModel() && preview.viewer === null;
  }, id)).toBe(true);
  await expect(surface(page)).toHaveAttribute('data-added', 'true');
  await expect(page.locator('.source-headers')).toHaveCount(0);
  await settle(page);
}
async function openAdded(page: Page, id = 'new-panel') {
  await page.goto('/?view=commit');
  await expect.poll(() => page.evaluate(() => Boolean(window.commitPreview))).toBe(true);
  await chooseAdded(page, id);
}
async function chooseModified(page: Page, id = 'preferences') {
  await page.evaluate(selected => window.commitPreview.selectFile(selected), id);
  await expect.poll(() => page.evaluate(selected => window.commitPreview.getSelected() === selected && window.commitPreview.viewer?.getState().status === 'ready', id)).toBe(true);
  await settle(page);
}

test('new untracked and tracked files use one full-width editor with their complete contents', async ({ page }) => {
  await openAdded(page);
  for (const id of ['new-panel', 'mapping-staged']) {
    await chooseAdded(page, id);
    expect(await page.evaluate(() => window.commitPreview.editor!.getModel()!.getValue())).toBe(fixture(id).modified);
    await expect(surface(page)).toHaveAttribute('data-path', fixture(id).path);
    await expect(page.locator('.monaco-editor')).toHaveCount(1);
    await expect(page.locator('.smart-diff, .smart-diff-gutter')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Previous change', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next change', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Layout', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Synchronize scrolling', exact: true })).toHaveCount(0);
    const dimensions = await page.evaluate(() => ({
      editor: window.commitPreview.editor!.getLayoutInfo().width,
      main: document.querySelector('main')!.getBoundingClientRect().width,
    }));
    expect(Math.abs(dimensions.editor - dimensions.main)).toBeLessThan(2);
  }
  await page.screenshot({ path: 'test-results/added-file-staged.png' });
});

test('direct addition routes start only the single-file editor without requesting a diff worker', async ({ page }) => {
  const diffWorkerUrls: string[] = [];
  const record = (url: string) => {
    if (/\/(?:worker(?:-[^/?]+)?\.js|diff\/worker\.ts)(?:\?|$)/.test(url)) diffWorkerUrls.push(url);
  };
  page.on('request', request => record(request.url()));
  page.on('worker', worker => record(worker.url()));
  await page.goto('/?fixture=added');
  await expect.poll(() => page.evaluate(() => Boolean(window.playground?.editor?.getModel()) && window.playground.getState().status === 'ready')).toBe(true);
  expect(await page.evaluate(() => window.playground.viewer)).toBeNull();
  expect(await page.evaluate(() => window.playground.editor!.getModel()!.getValue())).toBe(fixtures.find(item => item.id === 'added')!.modified);
  await expect(surface(page)).toHaveAttribute('data-added', 'true');
  await expect(page.locator('.source-headers')).toHaveCount(0);
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await expect(page.locator('.smart-diff')).toHaveCount(0);
  await page.goto('/?view=commit&file=new-panel');
  await expect.poll(() => page.evaluate(() => window.commitPreview?.getSelected() === 'new-panel' && Boolean(window.commitPreview.editor?.getModel()) && window.commitPreview.viewer === null)).toBe(true);
  await settle(page);
  await expect(surface(page)).toHaveAttribute('data-added', 'true');
  expect(diffWorkerUrls).toEqual([]);
});

test('read-only additions hide EOF display rows without changing content or real blank lines', async ({ page }) => {
  await page.goto('/?fixture=added&readOnly=1');
  await expect.poll(() => page.evaluate(() => Boolean(window.playground?.editor?.getModel()) && window.playground.getState().status === 'ready')).toBe(true);
  expect(await page.evaluate(() => window.playground.editor!.getOption(window.playground.monaco.editor.EditorOption.readOnly))).toBe(true);
  await settle(page);
  const initial = await page.evaluate(() => {
    const model = window.playground.editor!.getModel()!;
    const decoration = model.getAllDecorations().find(item => item.options.className === 'added-file-line');
    const line = document.querySelector('.added-file-line')!;
    const margin = document.querySelector('.added-file-margin')!;
    return { end: decoration?.range.endLineNumber, lines: model.getLineCount(), marginClass: decoration?.options.marginClassName,
      lineColor: getComputedStyle(line).backgroundColor, marginColor: getComputedStyle(margin).backgroundColor };
  });
  expect(initial.end).toBe(initial.lines - 1);
  expect(initial.marginClass).toBe('added-file-margin');
  expect(initial.lineColor).toBe('rgb(38, 75, 51)');
  expect(initial.marginColor).toBe(initial.lineColor);

  for (const text of ['', 'one\n', 'one\r\ntwo\r\n', 'one\n\n\n', '\n', '\n\n', '最后\n🙂']) {
    await page.evaluate(value => window.playground.editor!.getModel()!.setValue(value), text);
    await settle(page);
    const normalized = text.replace(/\r\n?|\n/g, '\n');
    const actualLines = normalized === '' ? 0 : normalized.split('\n').length - Number(normalized.endsWith('\n'));
    const decorations = await page.evaluate(() => window.playground.editor!.getModel()!.getAllDecorations()
      .filter(item => item.options.className === 'added-file-line')
      .map(item => ({ start: item.range.startLineNumber, end: item.range.endLineNumber, margin: item.options.marginClassName })));
    expect(decorations).toEqual(actualLines ? [{ start: 1, end: actualLines, margin: 'added-file-margin' }] : []);
    const display = await page.evaluate(() => {
      const editor = window.playground.editor!, model = editor.getModel()!;
      return { text: model.getValue(), heights: Array.from({ length: model.getLineCount() }, (_, index) => editor.getLineHeightForPosition({ lineNumber: index + 1, column: 1 })) };
    });
    expect(display.text).toBe(text);
    expect(display.heights.slice(0, actualLines).every(height => height > 0)).toBe(true);
    expect(display.heights.at(-1) === 0).toBe(normalized.endsWith('\n'));
    // Select All must still copy the complete source, including its final EOL.
    await page.evaluate(() => window.playground.editor!.trigger('test', 'editor.action.selectAll', null));
    expect(await page.evaluate(() => {
      const editor = window.playground.editor!;
      return editor.getModel()!.getValueInRange(editor.getSelection()!);
    })).toBe(text);
  }
});

test('the tracked added-file editor supports typing and normal Monaco find', async ({ page }) => {
  await openAdded(page, 'mapping-staged');
  expect(await page.evaluate(() => window.commitPreview.editor!.getOption(window.projectPreview.monaco.editor.EditorOption.readOnly))).toBe(false);
  await page.evaluate(() => { const editor = window.commitPreview.editor!; editor.focus(); editor.setPosition({ lineNumber: 1, column: 1 }); });
  await page.keyboard.type('// local change ');
  expect(await page.evaluate(() => window.commitPreview.editor!.getModel()!.getValue())).toBe(`// local change ${fixture('mapping-staged').modified}`);
  await page.evaluate(() => window.commitPreview.editor!.getAction('actions.find')!.run());
  const find = surface(page).locator('.find-widget').getByRole('textbox', { name: 'Find', exact: true });
  await expect(find).toBeVisible();
  await find.fill('interpolate');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => {
    const editor = window.commitPreview.editor!;
    return editor.getModel()!.getValueInRange(editor.getSelection()!);
  })).toBe('interpolate');
  await page.keyboard.press('Escape');
  await expect(find).toBeHidden();
  await expect(surface(page).locator('.view-line span[class^="mtk"]').first()).toBeVisible();
});

test('wrapping and resizing relayout the full-width added file and retain margin highlighting', async ({ page }) => {
  await openAdded(page);
  const before = await page.evaluate(() => window.commitPreview.editor!.getContentHeight());
  await page.evaluate(() => window.commitPreview.editor!.focus());
  await page.keyboard.press('Alt+z');
  await page.setViewportSize({ width: 860, height: 700 });
  await expect.poll(() => page.evaluate(() => window.commitPreview.editor!.getOption(window.projectPreview.monaco.editor.EditorOption.wordWrap))).toBe('on');
  await expect.poll(() => page.evaluate(() => window.commitPreview.editor!.getContentHeight())).toBeGreaterThan(before);
  await expect.poll(() => page.evaluate(() => Math.abs(window.commitPreview.editor!.getLayoutInfo().width - document.querySelector('[data-testid="file-surface"]')!.getBoundingClientRect().width))).toBeLessThan(1);
  await expect(surface(page).locator('.added-file-margin').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/added-file-wrapped.png' });
});

test('switching between additions, modified comparisons and Project restores selection and disposes retired models', async ({ page }) => {
  await openAdded(page);
  const initial = await page.evaluate(() => {
    const editor = window.commitPreview.editor!;
    editor.setSelection({ startLineNumber: 5, startColumn: 8, endLineNumber: 5, endColumn: 20 });
    return { selection: editor.getSelection(), uri: editor.getModel()!.uri.toString() };
  });
  await chooseModified(page);
  expect(await page.evaluate(uri => window.projectPreview.monaco.editor.getModels().some(model => model.uri.toString() === uri), initial.uri)).toBe(false);
  expect(await page.evaluate(() => window.commitPreview.editor)).toBeNull();
  await expect(page.locator('.smart-diff')).toHaveCount(1);
  await chooseAdded(page);
  expect(await page.evaluate(() => window.commitPreview.editor!.getSelection())).toEqual(initial.selection);

  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.projectPreview.editor?.getModel()))).toBe(true);
  await expect(surface(page)).not.toHaveAttribute('data-added', 'true');
  await expect(page.locator('.source-headers')).toHaveCount(0);
  await expect(page.locator('.added-file-line, .added-file-margin')).toHaveCount(0);
  expect(await page.evaluate(() => window.projectPreview.editor!.getModel()!.getAllDecorations().some(item => item.options.className === 'added-file-line'))).toBe(false);
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true }).click();
  await chooseAdded(page);
  expect(await page.evaluate(() => window.commitPreview.editor!.getSelection())).toEqual(initial.selection);
});

test('empty new files stay single-pane while modifications of an existing empty file stay comparisons', async ({ page }) => {
  await openAdded(page, 'empty-added');
  expect(await page.evaluate(() => window.commitPreview.editor!.getModel()!.getValue())).toBe('');
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await expect(page.locator('.added-file-line, .added-file-margin, .smart-diff')).toHaveCount(0);
  await chooseModified(page, 'empty-modified');
  await expect(page.locator('.smart-diff')).toHaveCount(1);
  await expect(page.locator('.monaco-editor')).toHaveCount(2);
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().original.getModel()!.getValue())).toBe('');
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getModel()!.getValue())).toBe(fixture('empty-modified').modified);
  await expect(page.getByRole('button', { name: 'Next change', exact: true })).toBeVisible();
});
