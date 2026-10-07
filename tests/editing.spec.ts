import { expect, test, type Page } from '@playwright/test';
import { commitFiles, workingCommitFiles } from '../apps/playground/src/commit-fixtures';

// This suite exercises explicit-save and unsaved-change decisions. Autosave has
// its own integration coverage; keep these drafts under the user's control.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
});

type Group = 'primary' | 'secondary';
const referencePath = 'apps/playground/src/ReviewPreferencesPanel.tsx';
const group = (page: Page, id: Group = 'primary') => page.locator(`section[data-group="${id}"]`);
const tab = (page: Page, label: string, id: Group = 'primary') => group(page, id).getByRole('tab', { name: label, exact: true });
const dirty = (page: Page, label: string, id: Group = 'primary') => tab(page, label, id).getByRole('img', { name: 'Unsaved changes', exact: true });
const projectRow = (page: Page, path: string) => page.getByRole('tree', { name: 'Project files', exact: true }).getByRole('treeitem', { name: path, exact: true });
const fixture = (id: string) => workingCommitFiles.find(file => file.id === id)!;

async function fileState(page: Page, id: Group = 'primary') {
  return page.evaluate(groupId => {
    const editor = window.projectPreview?.monaco.editor.getEditors().find(candidate => {
      const element = candidate.getDomNode();
      return element?.closest(`section[data-group="${groupId}"]`) && element.closest('.file-surface') && element.getBoundingClientRect().width > 0;
    });
    // Empty Monaco models initially use the platform's default EOL. Compare
    // normalized editor text, matching the editing store's source convention.
    return editor?.getModel() ? { text: editor.getModel()!.getValue(window.projectPreview.monaco.editor.EndOfLinePreference.LF), path: editor.getDomNode()!.closest('.file-surface')!.getAttribute('data-path'),
      readOnly: editor.getOption(window.projectPreview.monaco.editor.EditorOption.readOnly) } : null;
  }, id);
}
async function readyFile(page: Page, path: string, id: Group = 'primary') {
  await expect.poll(async () => (await fileState(page, id))?.path).toBe(path);
}
async function openProject(page: Page, path = 'README.md') {
  await page.goto(`/?view=project&path=${encodeURIComponent(path)}`);
  await readyFile(page, path);
  await expect(group(page).getByRole('main')).toHaveAttribute('data-editable', 'true');
}
async function typePrefix(page: Page, prefix: string, id: Group = 'primary') {
  await page.evaluate(groupId => {
    const editor = window.projectPreview.monaco.editor.getEditors().find(candidate => {
      const element = candidate.getDomNode();
      return element?.closest(`section[data-group="${groupId}"]`) && element.closest('.file-surface') && element.getBoundingClientRect().width > 0;
    })!;
    editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus(); editor.pushUndoStop();
  }, id);
  await page.keyboard.type(prefix);
}
async function groupAction(page: Page, label: string, id: Group = 'primary') {
  await page.getByRole('button', { name: `Editor group ${id === 'primary' ? 1 : 2} options`, exact: true }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}
async function canUnload(page: Page) {
  // Exercise the real guard without navigating away from the in-memory repository.
  return page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
}

test('project typing, undo and redo update dirty state; keyboard save persists across reopening', async ({ page }) => {
  await openProject(page);
  const original = (await fileState(page))!.text;
  expect((await fileState(page))!.readOnly).toBe(false);
  expect(await canUnload(page)).toBe(true);
  await typePrefix(page, 'Local draft: ');
  const edited = `Local draft: ${original}`;
  await expect.poll(async () => (await fileState(page))?.text).toBe(edited);
  await expect(dirty(page, 'README.md')).toBeVisible();
  expect(await canUnload(page)).toBe(false);
  // Monaco may separate words and spaces into individual typing undo groups.
  // Undo each real group, then replay exactly that many keyboard redo actions.
  let undoSteps = 0;
  while ((await fileState(page))!.text !== original && undoSteps < 16) {
    const previous = (await fileState(page))!.text;
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await fileState(page))?.text).not.toBe(previous);
    undoSteps++;
  }
  expect(undoSteps).toBeGreaterThan(0);
  expect((await fileState(page))!.text).toBe(original);
  await expect(dirty(page, 'README.md')).toHaveCount(0);
  for (let step = 0; step < undoSteps; step++) {
    const previous = (await fileState(page))!.text;
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(async () => (await fileState(page))?.text).not.toBe(previous);
  }
  await expect.poll(async () => (await fileState(page))?.text).toBe(edited);
  await expect(dirty(page, 'README.md')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dirty(page, 'README.md')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.projectPreview.getState()?.content?.text)).toBe(edited);
  expect(await canUnload(page)).toBe(true);
  await group(page).getByRole('button', { name: 'Close README.md', exact: true }).click();
  await expect(tab(page, 'README.md')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Save changes?', exact: true })).toHaveCount(0);
  await projectRow(page, 'README.md').click(); await readyFile(page, 'README.md');
  await expect.poll(async () => (await fileState(page))?.text).toBe(edited);
  await expect(dirty(page, 'README.md')).toHaveCount(0);
});

test('drafts survive tab switches and refresh, and split editors share changes and saves', async ({ page }) => {
  await openProject(page, referencePath);
  const original = (await fileState(page))!.text;
  await typePrefix(page, '// first draft ');
  await expect(dirty(page, referencePath)).toBeVisible();
  await projectRow(page, 'README.md').click(); await readyFile(page, 'README.md');
  await expect(dirty(page, referencePath)).toBeVisible();
  await tab(page, referencePath).click(); await readyFile(page, referencePath);
  await expect.poll(async () => (await fileState(page))?.text).toBe(`// first draft ${original}`);
  await groupAction(page, 'Split right');
  await readyFile(page, referencePath, 'secondary');
  await expect(dirty(page, referencePath, 'secondary')).toBeVisible();
  await typePrefix(page, '// split draft ', 'secondary');
  const edited = `// split draft // first draft ${original}`;
  for (const id of ['primary', 'secondary'] as const) {
    await expect.poll(async () => (await fileState(page, id))?.text).toBe(edited);
    await expect(dirty(page, referencePath, id)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Refresh project', exact: true }).click();
  for (const id of ['primary', 'secondary'] as const) {
    await expect.poll(async () => (await fileState(page, id))?.text).toBe(edited);
    await expect(dirty(page, referencePath, id)).toBeVisible();
  }
  await groupAction(page, 'Save', 'secondary');
  for (const id of ['primary', 'secondary'] as const) {
    await expect(dirty(page, referencePath, id)).toHaveCount(0);
    await expect.poll(async () => (await fileState(page, id))?.text).toBe(edited);
  }
  await expect.poll(() => page.evaluate(() => window.projectPreview.getState()?.content?.text)).toBe(edited);
});

test('closing a dirty tab supports Cancel, Discard and Save without losing the wrong version', async ({ page }) => {
  await openProject(page);
  const original = (await fileState(page))!.text;
  const close = () => group(page).getByRole('button', { name: 'Close README.md', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save changes?', exact: true });
  await typePrefix(page, 'Discard this: ');
  await close(); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tab(page, 'README.md')).toBeVisible();
  await expect(dirty(page, 'README.md')).toBeVisible();
  await expect.poll(async () => (await fileState(page))?.text).toBe(`Discard this: ${original}`);
  await close(); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(tab(page, 'README.md')).toHaveCount(0);
  await projectRow(page, 'README.md').click(); await readyFile(page, 'README.md');
  await expect.poll(async () => (await fileState(page))?.text).toBe(original);
  await expect(dirty(page, 'README.md')).toHaveCount(0);
  await typePrefix(page, 'Keep this: ');
  await close(); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tab(page, 'README.md')).toHaveCount(0);
  await projectRow(page, 'README.md').click(); await readyFile(page, 'README.md');
  await expect.poll(async () => (await fileState(page))?.text).toBe(`Keep this: ${original}`);
  await expect(dirty(page, 'README.md')).toHaveCount(0);
});

test('editing the unified working-tree diff preserves HEAD and shares one draft across Project and legacy selections', async ({ page }) => {
  await page.goto('/?view=commit&file=playground-main');
  await expect.poll(() => page.evaluate(() => window.commitPreview?.viewer?.getState().status)).toBe('ready');
  const before = await page.evaluate(() => {
    const viewer = window.commitPreview.viewer!, editors = viewer.getEditors();
    const option = window.projectPreview.monaco.editor.EditorOption.readOnly;
    return { request: viewer.getComparison()!.requestId, original: editors.original.getModel()!.getValue(), modified: editors.modified.getModel()!.getValue(),
      originalReadOnly: editors.original.getOption(option), modifiedReadOnly: editors.modified.getOption(option) };
  });
  expect(before.originalReadOnly).toBe(true); expect(before.modifiedReadOnly).toBe(false);
  expect(before.original).toBe(commitFiles.find(file => file.id === 'playground-staged')!.original);
  expect(before.modified).toBe(fixture('playground-main').modified);
  await page.evaluate(() => { const editor = window.commitPreview.viewer!.getEditors().original; editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus(); });
  await page.keyboard.type('BLOCKED');
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().original.getModel()!.getValue())).toBe(before.original);
  await page.evaluate(() => { const editor = window.commitPreview.viewer!.getEditors().modified; editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus(); });
  await page.keyboard.type('// changed working tree ');
  const edited = `// changed working tree ${before.modified}`;
  await expect.poll(() => page.evaluate(request => {
    const viewer = window.commitPreview.viewer!, comparison = viewer.getComparison();
    return viewer.getState().status === 'ready' && !!comparison && comparison.requestId > request
      && comparison.modifiedVersion === viewer.getEditors().modified.getModel()!.getVersionId();
  }, before.request)).toBe(true);
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().original.getModel()!.getValue())).toBe(before.original);
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getModel()!.getValue())).toBe(edited);
  await expect(dirty(page, `Commit: ${fixture('playground-main').path} — working`)).toBeVisible();
  await page.evaluate(path => window.projectPreview.selectFile(path), fixture('playground-main').path);
  await readyFile(page, fixture('playground-main').path);
  await expect.poll(async () => (await fileState(page))?.text).toBe(edited);
  await expect(dirty(page, fixture('playground-main').path)).toBeVisible();
  await page.evaluate(() => window.commitPreview.selectFile('playground-staged'));
  await expect.poll(() => page.evaluate(() => window.commitPreview.viewer?.getState().status)).toBe('ready');
  const reopened = await page.evaluate(() => {
    const editors = window.commitPreview.viewer!.getEditors(), option = window.projectPreview.monaco.editor.EditorOption.readOnly;
    return { original: editors.original.getOption(option), modified: editors.modified.getOption(option),
      baseline: editors.original.getModel()!.getValue(), text: editors.modified.getModel()!.getValue(), selected: window.commitPreview.getSelected() };
  });
  expect(reopened).toEqual({ original: true, modified: false, baseline: before.original, text: edited, selected: 'playground-main' });
  await expect(dirty(page, `Commit: ${fixture('playground-main').path} — working`)).toBeVisible();
  await expect(tab(page, `Commit: ${fixture('playground-main').path} — working`)).toHaveCount(1);
  await expect(group(page).getByRole('tab')).toHaveCount(2);
});

test('untracked and tracked additions edit the working tree and retain saved contents at EOF', async ({ page }) => {
  await page.goto('/?view=commit&file=empty-added');
  await readyFile(page, fixture('empty-added').path);
  await expect(group(page).getByTestId('file-surface')).toHaveAttribute('data-added', 'true');
  await typePrefix(page, 'First line');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await fileState(page))?.text).toBe('First line\n');
  expect(await page.evaluate(() => {
    const editor = window.commitPreview.editor!, model = editor.getModel()!;
    return editor.getLineHeightForPosition({ lineNumber: model.getLineCount(), column: 1 });
  })).toBeGreaterThan(0);
  await page.keyboard.type('Second line');
  await expect.poll(async () => (await fileState(page))?.text).toBe('First line\nSecond line');
  await expect(page.locator('.smart-diff')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dirty(page, `Commit: ${fixture('empty-added').path} — untracked`)).toHaveCount(0);
  await page.evaluate(() => window.commitPreview.selectFile('mapping-staged'));
  await readyFile(page, fixture('mapping-staged').path);
  expect((await fileState(page))!.readOnly).toBe(false);
  await typePrefix(page, '// tracked addition draft ');
  const trackedText = `// tracked addition draft ${fixture('mapping-staged').modified}`;
  await expect.poll(async () => (await fileState(page))?.text).toBe(trackedText);
  await expect(dirty(page, `Commit: ${fixture('mapping-staged').path} — working`)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dirty(page, `Commit: ${fixture('mapping-staged').path} — working`)).toHaveCount(0);
  await page.evaluate(() => window.commitPreview.selectFile('empty-added'));
  await readyFile(page, fixture('empty-added').path);
  await expect.poll(async () => (await fileState(page))?.text).toBe('First line\nSecond line');
  await page.evaluate(() => window.commitPreview.selectFile('mapping-staged'));
  await readyFile(page, fixture('mapping-staged').path);
  await expect.poll(async () => (await fileState(page))?.text).toBe(trackedText);
});

test('standalone fixture edits preserve their baseline and keep additions in one pane', async ({ page }) => {
  await page.goto('/?fixture=tsx');
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
  const before = await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    editors.modified.setPosition({ lineNumber: 1, column: 1 }); editors.modified.focus();
    return { original: editors.original.getModel()!.getValue(), modified: editors.modified.getModel()!.getValue() };
  });
  await page.keyboard.type('// fixture edit ');
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getModel()!.getValue())).toBe(`// fixture edit ${before.modified}`);
  expect(await page.evaluate(() => window.playground.viewer!.getEditors().original.getModel()!.getValue())).toBe(before.original);
  await page.evaluate(() => window.playground.selectFixture('added'));
  await expect.poll(() => page.evaluate(() => !!window.playground.editor?.getModel())).toBe(true);
  const added = await page.evaluate(() => {
    const editor = window.playground.editor!;
    editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus();
    return editor.getModel()!.getValue();
  });
  await page.keyboard.type('// added edit ');
  await expect.poll(() => page.evaluate(() => window.playground.editor!.getModel()!.getValue())).toBe(`// added edit ${added}`);
  await expect(page.getByTestId('file-surface')).toHaveAttribute('data-added', 'true');
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await expect(page.locator('.smart-diff')).toHaveCount(0);
});

test('external project reloads preserve selections and scroll with occurrence highlighting without Monaco errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(`${error.name}: ${error.message}`));
  await openProject(page, referencePath);
  const source = (revision: number) => `// External revision ${revision}\n${Array.from({ length: 240 }, (_, index) =>
    `export const value${index} = repeatedValue + repeatedValue; // ${'long line '.repeat(24)}`).join('\n')}\n`;
  const update = async (text: string) => {
    await page.evaluate(async text => {
      const file = window.projectPreview.getState()!, capability = file.content!.editable!;
      // Write the sample repository directly. This bypasses editor typing and
      // ModelEchoes, so refresh delivers a genuine external source-prop update.
      const result = await window.projectPreview.saveText(file.repositoryId, capability.id, capability.version, text);
      if (result.state !== 'saved') throw new Error(result.message ?? 'Sample write failed');
      window.branchPreview.refresh();
    }, text);
    await expect.poll(async () => (await fileState(page))?.text).toBe(text);
  };
  await update(source(0));
  const before = await page.evaluate(() => {
    const { monaco, editor } = window.projectPreview;
    const model = editor!.getModel()!;
    // Deterministic public language provider: no network/language-server timing.
    monaco.languages.registerDocumentHighlightProvider(model.getLanguageId(), {
      provideDocumentHighlights: model => model.findMatches('repeatedValue', false, false, true, null, false)
        .map(match => ({ range: match.range, kind: monaco.languages.DocumentHighlightKind.Read })),
    });
    editor!.updateOptions({ occurrencesHighlight: 'singleFile', occurrencesHighlightDelay: 0 });
    const column = model.getLineContent(120).indexOf('repeatedValue') + 1;
    editor!.focus();
    editor!.setSelection(new monaco.Selection(120, column, 120, column + 'repeatedValue'.length));
    editor!.setScrollPosition({ scrollTop: editor!.getTopForLineNumber(112) + 7, scrollLeft: 90 }, monaco.editor.ScrollType.Immediate);
    return { id: editor!.getId(), selections: editor!.getSelections(), top: editor!.getScrollTop(), left: editor!.getScrollLeft() };
  });
  expect(before.top).toBeGreaterThan(0); expect(before.left).toBeGreaterThan(0);
  for (let revision = 1; revision <= 4; revision++) {
    // Confirm real occurrence decorations exist before reloading; preserving a
    // full contribution view-state used to reject Monaco's highlight Delayer.
    await expect.poll(() => page.evaluate(() => window.projectPreview.editor!.getModel()!.getAllDecorations()
      .filter(decoration => ['wordHighlight', 'wordHighlightText', 'wordHighlightStrong'].includes(decoration.options.className ?? '')).length)).toBeGreaterThan(0);
    await update(source(revision));
    const after = await page.evaluate(() => {
      const editor = window.projectPreview.editor!;
      return { id: editor.getId(), selections: editor.getSelections(), top: editor.getScrollTop(), left: editor.getScrollLeft() };
    });
    expect(after.id).toBe(before.id); expect(after.selections).toEqual(before.selections);
    expect(after.top).toBeCloseTo(before.top, 0); expect(after.left).toBeCloseTo(before.left, 0);
    await expect(dirty(page, referencePath)).toHaveCount(0);
  }
  await expect.poll(() => page.evaluate(() => window.projectPreview.editor!.getModel()!.getAllDecorations()
    .filter(decoration => ['wordHighlight', 'wordHighlightText', 'wordHighlightStrong'].includes(decoration.options.className ?? '')).length)).toBeGreaterThan(0);
  // Inactive tabs dispose Monaco. Remount must restore durable reading state
  // without replaying the previous model's transient highlight contribution.
  await page.evaluate(() => window.projectPreview.selectFile('README.md'));
  await readyFile(page, 'README.md');
  await page.evaluate(path => window.projectPreview.selectFile(path), referencePath);
  await readyFile(page, referencePath);
  await expect.poll(async () => (await fileState(page))?.text).toBe(source(4));
  const remounted = await page.evaluate(() => {
    const editor = window.projectPreview.editor!;
    return { id: editor.getId(), selections: editor.getSelections(), top: editor.getScrollTop(), left: editor.getScrollLeft() };
  });
  expect(remounted.id).not.toBe(before.id); expect(remounted.selections).toEqual(before.selections);
  expect(remounted.top).toBeCloseTo(before.top, 0); expect(remounted.left).toBeCloseTo(before.left, 0);
  // Observe the delayed highlighter callbacks too, including unhandled rejections.
  await page.waitForTimeout(350);
  expect(errors).toEqual([]);
});
