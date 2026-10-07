import { expect, test, type Locator, type Page } from '@playwright/test';
import { workingCommitFiles } from '../apps/playground/src/commit-fixtures';
import { projectRepository } from '../apps/playground/src/project-fixtures';

// Context-menu close/save actions intentionally exercise persistent drafts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
});

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

type Group = 'primary' | 'secondary';
const group = (page: Page, id: Group = 'primary') => page.locator(`section[data-group="${id}"]`);
const tab = (page: Page, label: string, id: Group = 'primary') => group(page, id).getByRole('tab', { name: label, exact: true });
const projectRow = (page: Page, path: string) => page.getByRole('tree', { name: 'Project files', exact: true }).getByRole('treeitem', { name: path, exact: true });
const changedRow = (page: Page, id: string) => page.getByRole('tree', { name: 'Changed files', exact: true }).locator(`[role="treeitem"][data-file-id="${id}"]`);
const menu = (page: Page) => page.getByRole('menu', { name: 'File actions', exact: true });
const item = (page: Page, label: string) => menu(page).getByRole('menuitem', { name: label, exact: true });
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const fixture = (id: string) => workingCommitFiles.find(file => file.id === id)!;
const comparisonLabel = (id: string) => `Commit: ${fixture(id).path} — ${fixture(id).group}`;

async function openMenu(page: Page, target: Locator, key?: 'Shift+F10' | 'ContextMenu') {
  if (key) { await target.focus(); await page.keyboard.press(key); }
  else await target.click({ button: 'right' });
  await expect(menu(page)).toBeVisible();
  await expect(item(page, 'Copy Path')).toBeEnabled();
}
async function fileState(page: Page, id: Group = 'primary') {
  return page.evaluate(groupId => {
    const editor = window.projectPreview?.monaco.editor.getEditors().find(candidate => {
      const element = candidate.getDomNode();
      return element?.closest(`section[data-group="${groupId}"]`) && element.closest('.file-surface') && element.getBoundingClientRect().width > 0;
    });
    return editor?.getModel() ? {
      path: editor.getDomNode()!.closest('.file-surface')!.getAttribute('data-path'),
      text: editor.getModel()!.getValue(window.projectPreview.monaco.editor.EndOfLinePreference.LF),
      readOnly: editor.getOption(window.projectPreview.monaco.editor.EditorOption.readOnly),
    } : null;
  }, id);
}
async function readyFile(page: Page, path: string, id: Group = 'primary') {
  await expect.poll(async () => (await fileState(page, id))?.path).toBe(path);
  await expect(tab(page, path, id)).toHaveAttribute('aria-selected', 'true');
}
async function openProject(page: Page, path = 'README.md') {
  await page.goto(`/?view=project&path=${encodeURIComponent(path)}`);
  await readyFile(page, path);
}
async function openComparison(page: Page, id = 'playground-main') {
  await page.goto(`/?view=commit&file=${id}`);
  await expect(tab(page, comparisonLabel(id))).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => window.commitPreview?.getState().status)).toMatch(/^(ready|empty)$/);
}

test('inactive code tabs copy their own full and relative paths and expose a truthful Open In submenu', async ({ page }) => {
  await openProject(page);
  await projectRow(page, 'package.json').click(); await readyFile(page, 'package.json');
  await openMenu(page, tab(page, 'README.md'));
  await item(page, 'Copy Path').click();
  await expect.poll(() => clipboard(page)).toBe(`${projectRepository.path}/README.md`);
  await expect(menu(page)).toHaveCount(0);
  await openMenu(page, tab(page, 'README.md'));
  await item(page, 'Copy Relative Path').click();
  await expect.poll(() => clipboard(page)).toBe('README.md');
  await openMenu(page, tab(page, 'README.md'));
  await expect(item(page, 'Jump to Source')).toHaveCount(0);
  const openIn = item(page, 'Open In');
  await expect(openIn).toHaveAttribute('aria-haspopup', 'menu');
  await openIn.click();
  const unavailable = page.getByRole('menuitem', { name: 'Available in desktop app', exact: true });
  await expect(unavailable).toBeVisible(); await expect(unavailable).toBeDisabled();
});

test('Project sidebar file menus copy the clicked path and support both keyboard context-menu shortcuts', async ({ page }) => {
  await openProject(page);
  const target = projectRow(page, 'package.json');
  await openMenu(page, target);
  await item(page, 'Copy Path').click();
  await expect.poll(() => clipboard(page)).toBe(`${projectRepository.path}/package.json`);
  await openMenu(page, target, 'Shift+F10');
  await expect(item(page, 'Close')).toHaveCount(0);
  await expect(item(page, 'Split Right')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0); await expect(target).toBeFocused();
  await openMenu(page, target, 'ContextMenu');
  await item(page, 'Copy Relative Path').click();
  await expect.poll(() => clipboard(page)).toBe('package.json');
  await expect(menu(page)).toHaveCount(0);
});

test('Commit sidebar context actions preserve review checkboxes and copy the selected comparison path', async ({ page }) => {
  await openComparison(page);
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  const target = changedRow(page, 'playground-main');
  const check = target.getByRole('checkbox');
  const included = await check.isChecked();
  await openMenu(page, target);
  await item(page, 'Copy Path').click();
  await expect.poll(() => clipboard(page)).toBe(`${projectRepository.path}/${fixture('playground-main').path}`);
  expect(await check.isChecked()).toBe(included);
  await openMenu(page, target, 'Shift+F10');
  await item(page, 'Copy Relative Path').click();
  await expect.poll(() => clipboard(page)).toBe(fixture('playground-main').path);
  expect(await check.isChecked()).toBe(included);
  await openMenu(page, target, 'ContextMenu');
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0); await expect(target).toBeFocused();
});

test('Jump to Source opens an editable ordinary file sharing the diff draft and reuses its existing tab', async ({ page }) => {
  await openComparison(page);
  const path = fixture('playground-main').path;
  const original = await page.evaluate(() => {
    const editor = window.commitPreview.viewer!.getEditors().modified;
    editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus();
    return editor.getValue();
  });
  await page.keyboard.type('// context menu draft ');
  const edited = `// context menu draft ${original}`;
  await expect.poll(() => page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getValue())).toBe(edited);
  await openMenu(page, tab(page, comparisonLabel('playground-main')));
  await expect(item(page, 'Jump to Source')).toBeEnabled();
  await item(page, 'Jump to Source').click();
  await readyFile(page, path);
  expect((await fileState(page))!.readOnly).toBe(false);
  expect((await fileState(page))!.text).toBe(edited);
  await expect(tab(page, path).getByRole('img', { name: 'Unsaved changes', exact: true })).toBeVisible();
  await expect(tab(page, comparisonLabel('playground-main'))).toHaveCount(1);
  await expect(group(page).locator('.smart-diff')).toHaveCount(0);
  await openMenu(page, tab(page, comparisonLabel('playground-main')));
  await item(page, 'Jump to Source').click(); await readyFile(page, path);
  await expect(tab(page, path)).toHaveCount(1);
  expect((await fileState(page))!.text).toBe(edited);
});

test('deleted comparisons keep path copying available while Jump to Source is disabled', async ({ page }) => {
  await openComparison(page, 'removed-script');
  await openMenu(page, tab(page, comparisonLabel('removed-script')));
  await expect(item(page, 'Jump to Source')).toBeDisabled();
  await item(page, 'Copy Relative Path').click();
  await expect.poll(() => clipboard(page)).toBe(fixture('removed-script').path);
  await expect(tab(page, fixture('removed-script').path)).toHaveCount(0);
});

test('tab split actions operate on the context tab and retain each split orientation', async ({ page }) => {
  await openProject(page);
  await projectRow(page, 'package.json').click(); await readyFile(page, 'package.json');
  await openMenu(page, tab(page, 'README.md'));
  await item(page, 'Split Right').click();
  await readyFile(page, 'README.md', 'secondary');
  await expect(page.getByRole('separator', { name: 'Resize editor groups', exact: true })).toHaveAttribute('aria-orientation', 'vertical');
  await expect(tab(page, 'package.json')).toHaveCount(1);
  await openMenu(page, tab(page, 'README.md', 'secondary'));
  await item(page, 'Split Down').click();
  await expect(page.getByRole('separator', { name: 'Resize editor groups', exact: true })).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(page.locator('.workspace-group')).toHaveCount(2);
});

test('context Close honors unsaved confirmation and Close Other Tabs keeps the targeted tab', async ({ page }) => {
  await openProject(page);
  await page.evaluate(() => { const editor = window.projectPreview.editor!; editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus(); });
  await page.keyboard.type('contextDraft');
  await expect(tab(page, 'README.md').getByRole('img', { name: 'Unsaved changes', exact: true })).toBeVisible();
  await openMenu(page, tab(page, 'README.md'));
  await item(page, 'Close').click();
  const dialog = page.getByRole('dialog', { name: 'Save changes?', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tab(page, 'README.md')).toHaveCount(1);
  await projectRow(page, 'package.json').click(); await readyFile(page, 'package.json');
  await openMenu(page, tab(page, 'README.md'));
  await item(page, 'Close Other Tabs').click();
  await expect(group(page).getByRole('tab')).toHaveCount(1);
  await readyFile(page, 'README.md');
  await expect(dialog).toHaveCount(0);
  await expect(tab(page, 'README.md').getByRole('img', { name: 'Unsaved changes', exact: true })).toBeVisible();
  await openMenu(page, tab(page, 'README.md'));
  await item(page, 'Close').click(); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(group(page).getByRole('tab')).toHaveCount(0);
  await expect(page.locator('.monaco-editor')).toHaveCount(0);
});
