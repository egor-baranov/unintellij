import { expect, test, type Page } from '@playwright/test';
declare global { interface Window { editableTrace: { flushes: number } } }

async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const viewer = window.playground?.viewer;
    const comparison = viewer?.getComparison();
    return comparison && comparison.modifiedVersion === viewer!.getEditors().modified.getModel()!.getVersionId() ? viewer!.getState().status : 'loading';
  })).toMatch(/^(ready|empty)$/);
}
async function editability(page: Page): Promise<boolean[]> {
  return page.evaluate(() => {
    const { original, modified } = window.playground.viewer!.getEditors();
    const options = window.playground.monaco.editor.EditorOption;
    return [original.getOption(options.readOnly), original.getOption(options.domReadOnly), modified.getOption(options.readOnly), modified.getOption(options.domReadOnly)];
  });
}

test('external diff reloads preserve both selections and independent reading positions', async ({ page }) => {
  await page.goto('/?fixture=tsx'); await ready(page);
  const original = Array.from({ length: 200 }, (_, index) => `export const row${index} = 'before';`).join('\n');
  const modified = original.replace('row80', 'changed80');
  await page.evaluate(({ original, modified }) => {
    window.playground.setPreferences({ collapse: false, sync: false });
    window.playground.setContents(original, modified);
  }, { original, modified });
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getModel()!.getLineCount())).toBe(200);
  await ready(page);
  const previous = await page.evaluate(() => {
    const { original, modified } = window.playground.viewer!.getEditors();
    original.setSelection({ startLineNumber: 70, startColumn: 3, endLineNumber: 70, endColumn: 6 });
    modified.setSelection({ startLineNumber: 90, startColumn: 3, endLineNumber: 90, endColumn: 7 });
    original.setScrollTop(900); modified.setScrollTop(1300);
    return [original, modified].map(editor => ({ selection: editor.getSelection(), scroll: editor.getScrollTop() }));
  });
  await page.evaluate(({ original, modified }) => window.playground.setContents(original.replaceAll('before', 'after'), modified.replaceAll('before', 'after')), { original, modified });
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getValue())).toContain("'after'");
  await ready(page);
  const next = await page.evaluate(() => Object.values(window.playground.viewer!.getEditors()).map(editor => ({ selection: editor.getSelection(), scroll: editor.getScrollTop() })));
  for (let side = 0; side < 2; side++) {
    expect(next[side].selection).toEqual(previous[side].selection);
    expect(Math.abs(next[side].scroll - previous[side].scroll)).toBeLessThan(2);
  }
});

test('library editing defaults to read-only and explicit host editing recomputes the diff without moving the caret', async ({ page }) => {
  await page.goto('/?fixture=tsx'); await ready(page);
  // The application explicitly enables editing. Construct the same viewer
  // class without modifiedEditable to verify the reusable library's default,
  // independent of the application's preferences and without dev-only imports.
  const defaults = await page.evaluate(() => {
    const { monaco, viewer } = window.playground;
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-2000px;width:800px;height:300px';
    document.body.append(container);
    const original = monaco.editor.createModel('original');
    const modified = monaco.editor.createModel('modified');
    const probe = Reflect.construct(viewer!.constructor, [container, { monaco, original, modified, editorOptions: { readOnly: false, domReadOnly: false } }]) as NonNullable<typeof viewer>;
    try {
      const editors = probe.getEditors(), options = monaco.editor.EditorOption;
      return [editors.original.getOption(options.readOnly), editors.original.getOption(options.domReadOnly), editors.modified.getOption(options.readOnly), editors.modified.getOption(options.domReadOnly)];
    } finally { probe.dispose(); original.dispose(); modified.dispose(); container.remove(); }
  });
  expect(defaults).toEqual([true, true, true, true]);
  expect(await editability(page)).toEqual([true, true, false, false]);
  await page.evaluate(() => window.playground.viewer!.updateOptions({ modifiedEditable: false, editorOptions: { readOnly: false, domReadOnly: false } }));
  expect(await editability(page)).toEqual([true, true, true, true]);
  const original = await page.evaluate(() => window.playground.viewer!.getEditors().original.getValue());
  await page.evaluate(() => {
    const viewer = window.playground.viewer!;
    viewer.updateOptions({ modifiedEditable: true, editorOptions: { readOnly: true, domReadOnly: true } });
    viewer.getEditors().modified.setPosition({ lineNumber: 1, column: 1 });
    viewer.getEditors().modified.focus();
  });
  expect(await editability(page)).toEqual([true, true, false, false]);
  await page.keyboard.type('// local change'); await page.keyboard.press('Enter');
  const cursor = await page.evaluate(() => window.playground.viewer!.getEditors().modified.getPosition());
  await ready(page);
  expect(await page.evaluate(() => window.playground.viewer!.getEditors().modified.getValue())).toMatch(/^\/\/ local change\r?\n/);
  expect(await page.evaluate(() => window.playground.viewer!.getEditors().modified.getPosition())).toEqual(cursor);
  expect(await page.evaluate(() => window.playground.viewer!.getComparison()!.changes.some(change => change.modified.start === 1))).toBe(true);
  await page.evaluate(() => {
    const editor = window.playground.viewer!.getEditors().original;
    editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus();
  });
  await page.keyboard.type('cannot modify baseline');
  expect(await page.evaluate(() => window.playground.viewer!.getEditors().original.getValue())).toBe(original);
  await page.evaluate(() => window.playground.viewer!.updateOptions({ modifiedEditable: false }));
  expect(await editability(page)).toEqual([true, true, true, true]);
  const modified = await page.evaluate(() => window.playground.viewer!.getEditors().modified.getValue());
  await page.evaluate(() => window.playground.viewer!.getEditors().modified.focus());
  await page.keyboard.type('locked again');
  expect(await page.evaluate(() => window.playground.viewer!.getEditors().modified.getValue())).toBe(modified);
});

test('preference updates and echoed source props preserve edited text and undo history', async ({ page }) => {
  await page.goto('/?fixture=tsx'); await ready(page);
  const baseline = await page.evaluate(() => {
    const viewer = window.playground.viewer!;
    viewer.updateOptions({ modifiedEditable: true });
    const editors = viewer.getEditors();
    editors.modified.setPosition({ lineNumber: 1, column: 1 }); editors.modified.focus();
    editors.modified.getModel()!.pushStackElement();
    window.editableTrace = { flushes: 0 };
    editors.modified.getModel()!.onDidChangeContent(event => { if (event.isFlush) window.editableTrace.flushes++; });
    return { original: editors.original.getValue(), modified: editors.modified.getValue() };
  });
  // A single word is one ordinary Monaco typing/undo group; whitespace and
  // punctuation intentionally introduce separate groups in multi-word typing.
  await page.keyboard.type('draftPrefix');
  await page.evaluate(() => window.playground.viewer!.getEditors().modified.getModel()!.pushStackElement());
  await ready(page);
  const edited = await page.evaluate(() => window.playground.viewer!.getEditors().modified.getValue());
  expect(edited).toBe(`draftPrefix${baseline.modified}`);
  expect(await page.evaluate(() => window.editableTrace.flushes)).toBe(0);
  // This host echoes onChange, so its unchanged modified prop is now `edited`.
  // Refreshing only the original must leave that model and its undo stack alone.
  await page.evaluate(({ original, modified }) => window.playground.setContents(`${original}\n// external baseline update`, modified), { original: baseline.original, modified: edited });
  await ready(page);
  expect(await page.evaluate(() => window.playground.viewer!.getEditors().modified.getValue())).toBe(edited);
  await page.evaluate(edited => {
    const viewer = window.playground.viewer!;
    window.playground.setContents(viewer.getEditors().original.getValue(), edited);
    window.playground.setPreferences({ wrap: true, layout: 'aligned', collapse: false });
  }, edited);
  await ready(page);
  expect(await editability(page)).toEqual([true, true, false, false]);
  expect(await page.evaluate(() => window.playground.viewer!.getEditors().modified.getValue())).toBe(edited);
  expect(await page.evaluate(() => window.playground.viewer!.getEditors().modified.getModel()!.canUndo())).toBe(true);
  expect(await page.evaluate(() => window.editableTrace.flushes)).toBe(0);
  await page.evaluate(() => window.playground.viewer!.getEditors().modified.focus());
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getValue())).toBe(baseline.modified);
  await ready(page);
  // Previously acknowledged strings are no longer pending echoes. A deliberate
  // external reset to one of them must still replace the current model.
  await page.evaluate(edited => window.playground.setContents(window.playground.viewer!.getEditors().original.getValue(), edited), edited);
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getValue())).toBe(edited);
  await ready(page);
  await page.evaluate(baseline => window.playground.setContents(window.playground.viewer!.getEditors().original.getValue(), baseline.modified), baseline);
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getValue())).toBe(baseline.modified);
  await ready(page);
});
