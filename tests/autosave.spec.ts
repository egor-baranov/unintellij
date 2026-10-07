import { expect, test, type Page } from '@playwright/test';
import { workingCommitFiles } from '../apps/playground/src/commit-fixtures';

const savingKey = 'smart-diff:file-saving:v1';
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const autoSave = (page: Page) => settings(page).getByRole('checkbox', { name: 'Save changes automatically', exact: true });
const group = (page: Page, id = 'primary') => page.locator(`section[data-group="${id}"]`);
const dirty = (page: Page) => page.getByRole('img', { name: 'Unsaved changes', exact: true });
const saved = (page: Page) => page.evaluate(() => window.projectPreview.getState()?.content);

async function readyFile(page: Page, path: string, id = 'primary') {
  await expect(group(page, id).getByTestId('file-surface')).toHaveAttribute('data-path', path);
  await expect.poll(() => fileText(page, id)).not.toBeNull();
}
async function openProject(page: Page) {
  await page.goto('/?view=project&path=README.md');
  await readyFile(page, 'README.md');
}
async function fileText(page: Page, id = 'primary') {
  return page.evaluate(groupId => {
    const { monaco } = window.projectPreview;
    const editor = monaco.editor.getEditors().find(candidate => {
      const element = candidate.getDomNode();
      return element?.closest(`section[data-group="${groupId}"]`) && element.closest('.file-surface') && element.getBoundingClientRect().width > 0;
    });
    return editor?.getModel()?.getValue(monaco.editor.EndOfLinePreference.LF) ?? null;
  }, id);
}
async function prefix(page: Page, text: string, id = 'primary') {
  await page.evaluate(groupId => {
    const editor = window.projectPreview.monaco.editor.getEditors().find(candidate => {
      const element = candidate.getDomNode();
      return element?.closest(`section[data-group="${groupId}"]`) && element.closest('.file-surface') && element.getBoundingClientRect().width > 0;
    })!;
    editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus();
  }, id);
  await page.keyboard.type(text);
}
async function openSavingSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('navigation', { name: 'Settings categories', exact: true }).getByRole('button', { name: 'Files', exact: true }).click();
}
async function setSaving(page: Page, enabled: boolean) {
  await openSavingSettings(page);
  await autoSave(page).setChecked(enabled);
  await settings(page).getByRole('button', { name: 'Save', exact: true }).click();
}
async function restoredSettingsFocus(page: Page) {
  await expect(settings(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  // Native <dialog> restores focus immediately; SettingsButton also restores it
  // in the next frame. Let both finish before programmatically focusing Monaco.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}

test('project autosave waits for a typing pause, writes once and persists across reopening the file', async ({ page }) => {
  await openProject(page);
  const original = (await saved(page))!;
  await prefix(page, 'First ');
  await page.waitForTimeout(400);
  await page.keyboard.type('second ');
  await page.waitForTimeout(400);
  await page.keyboard.type('third ');
  // Total editing time exceeds the delay, but no individual pause does.
  await page.waitForTimeout(400);
  expect((await saved(page))!.text).toBe(original.text);
  await expect(dirty(page)).toBeVisible();
  const edited = `First second third ${original.text}`;
  await expect.poll(async () => (await saved(page))?.text).toBe(edited);
  expect(Number((await saved(page))!.editable!.version)).toBe(Number(original.editable!.version) + 1);
  await expect(dirty(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
  await group(page).getByRole('button', { name: 'Close README.md', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save changes?', exact: true })).toHaveCount(0);
  await page.getByRole('tree', { name: 'Project files', exact: true }).getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await readyFile(page, 'README.md');
  expect(await fileText(page)).toBe(edited);
});

test('working-tree diff autosaves and the Project editor opens the saved text without changing HEAD', async ({ page }) => {
  const fixture = workingCommitFiles.find(file => file.id === 'playground-main')!;
  await page.goto('/?view=commit&file=playground-main');
  await expect.poll(() => page.evaluate(() => window.commitPreview?.viewer?.getState().status)).toBe('ready');
  const before = await page.evaluate(() => {
    const { original, modified } = window.commitPreview.viewer!.getEditors();
    modified.setPosition({ lineNumber: 1, column: 1 }); modified.focus();
    return { original: original.getModel()!.getValue(), modified: modified.getModel()!.getValue() };
  });
  await page.keyboard.type('// automatic diff save ');
  await expect(dirty(page)).toBeVisible();
  await expect(dirty(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().original.getModel()!.getValue())).toBe(before.original);
  const edited = `// automatic diff save ${before.modified}`;
  await page.evaluate(path => window.projectPreview.selectFile(path), fixture.path);
  await readyFile(page, fixture.path);
  expect((await saved(page))!.text).toBe(edited);
  expect(await fileText(page)).toBe(edited);
  await expect(dirty(page)).toHaveCount(0);
});

test('split editors share one autosave timer and preserve edits from both panes', async ({ page }) => {
  await openProject(page);
  const original = (await saved(page))!;
  await page.getByRole('button', { name: 'Editor group 1 options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Split right', exact: true }).click();
  await readyFile(page, 'README.md', 'secondary');
  await prefix(page, 'Primary ');
  await prefix(page, 'Secondary ', 'secondary');
  const edited = `Secondary Primary ${original.text}`;
  await expect.poll(() => fileText(page)).toBe(edited);
  await expect.poll(() => fileText(page, 'secondary')).toBe(edited);
  await expect.poll(async () => (await saved(page))?.text).toBe(edited);
  expect(Number((await saved(page))!.editable!.version)).toBe(Number(original.editable!.version) + 1);
  await expect(dirty(page)).toHaveCount(0);
});

test('disabling autosave persists across reload and keeps keyboard Save available', async ({ page }) => {
  await openProject(page);
  await setSaving(page, false);
  await page.reload();
  await readyFile(page, 'README.md');
  await openSavingSettings(page);
  await expect(autoSave(page)).not.toBeChecked();
  await settings(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await restoredSettingsFocus(page);
  const original = (await saved(page))!.text;
  await prefix(page, 'Manual only ');
  await page.waitForTimeout(1300);
  expect((await saved(page))!.text).toBe(original);
  await expect(dirty(page)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await saved(page))?.text).toBe(`Manual only ${original}`);
  await expect(dirty(page)).toHaveCount(0);
});

test('Cancel never enables autosave; Apply saves existing drafts and survives subsequent Cancel', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ autoSave: false })), savingKey);
  await openProject(page);
  const original = (await saved(page))!.text;
  await prefix(page, 'Pending draft ');
  await openSavingSettings(page);
  await autoSave(page).check();
  await page.waitForTimeout(1300);
  expect((await saved(page))!.text).toBe(original);
  await settings(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(1300);
  expect((await saved(page))!.text).toBe(original);
  await expect(dirty(page)).toBeVisible();
  await openSavingSettings(page);
  await expect(autoSave(page)).not.toBeChecked();
  await autoSave(page).check();
  await settings(page).getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await saved(page))?.text).toBe(`Pending draft ${original}`);
  await expect(dirty(page)).toHaveCount(0);
  await autoSave(page).uncheck();
  await settings(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await restoredSettingsFocus(page);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), savingKey)).toEqual({ autoSave: true });
  await prefix(page, 'Still automatic ');
  await expect.poll(async () => (await saved(page))?.text).toBe(`Still automatic Pending draft ${original}`);
});
