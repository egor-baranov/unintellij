import { expect, test, type Locator, type Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const viewer = window.playground?.viewer;
    if (!viewer || !/^(ready|empty)$/.test(viewer.getState().status)) return false;
    const comparison = viewer.getComparison();
    const editors = viewer.getEditors();
    return comparison?.originalVersion === editors.original.getModel()?.getVersionId()
      && comparison?.modifiedVersion === editors.modified.getModel()?.getVersionId();
  })).toBe(true);
}

async function open(page: Page, fixture = 'reference'): Promise<void> {
  await page.goto(`/?fixture=${fixture}`);
  await ready(page);
}

async function openMenu(page: Page, label: string): Promise<Locator> {
  const trigger = page.getByRole('button', { name: label, exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('menu', { name: label, exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

async function withinViewport(page: Page, menu: Locator): Promise<void> {
  await expect.poll(async () => {
    const box = await menu.boundingBox();
    const viewport = page.viewportSize();
    return Boolean(box && viewport && box.x >= 0 && box.y >= 0
      && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
  }).toBe(true);
}

test('menu keyboard navigation supports arrows, Home, End, typeahead, and Escape focus restoration', async ({ page }) => {
  await open(page);
  const trigger = page.getByRole('button', { name: 'Diff options', exact: true });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Diff options', exact: true });
  const collapse = menu.getByRole('menuitemcheckbox', { name: 'Collapse unchanged', exact: true });
  const whitespace = menu.getByRole('menuitemcheckbox', { name: 'Ignore trim whitespace', exact: true });
  const wrap = menu.getByRole('menuitemcheckbox', { name: 'Wrap long lines', exact: true });
  const last = menu.getByRole('menuitemcheckbox').last();
  await expect(collapse).toBeFocused();
  await page.keyboard.press('End');
  await expect(last).toBeFocused();
  await page.keyboard.press('Home');
  await expect(collapse).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(last).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(collapse).toBeFocused();
  await page.keyboard.type('ignore');
  await expect(whitespace).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(last).toBeFocused();
  await page.keyboard.type('wrap');
  await expect(wrap).toBeFocused();
  await page.keyboard.press('Space');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await openMenu(page, 'Diff options');
  await expect(wrap).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => {
    const { monaco, viewer } = window.playground;
    return viewer!.getEditors().modified.getOption(monaco.editor.EditorOption.wordWrap);
  })).toBe('on');
});

test('layout radio items update the real viewer and Enter returns focus to the trigger', async ({ page }) => {
  await open(page, 'replacement');
  const trigger = page.getByRole('button', { name: 'Layout', exact: true });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Layout', exact: true });
  const compact = menu.getByRole('menuitemradio', { name: 'Compact', exact: true });
  const aligned = menu.getByRole('menuitemradio', { name: 'Aligned', exact: true });
  await expect(compact).toHaveAttribute('aria-checked', 'true');
  await expect(compact).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(aligned).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('Aligned');
  await expect(page.locator('.smart-diff-spacer')).not.toHaveCount(0);
  await openMenu(page, 'Layout');
  await expect(aligned).toHaveAttribute('aria-checked', 'true');
  await expect(compact).toHaveAttribute('aria-checked', 'false');
  await compact.click();
  await expect(trigger).toContainText('Compact');
  await expect(page.locator('.smart-diff-spacer')).toHaveCount(0);
});

test('option checkmarks change folding and whitespace comparison without rewriting source', async ({ page }) => {
  await open(page, 'folds');
  await expect(page.locator('.smart-diff-omission')).not.toHaveCount(0);
  let menu = await openMenu(page, 'Diff options');
  const collapse = menu.getByRole('menuitemcheckbox', { name: 'Collapse unchanged', exact: true });
  await expect(collapse).toHaveAttribute('aria-checked', 'true');
  await collapse.click();
  await expect(page.locator('.smart-diff-omission')).toHaveCount(0);
  menu = await openMenu(page, 'Diff options');
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Collapse unchanged', exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');

  await open(page, 'whitespace');
  expect(await page.evaluate(() => window.playground.getState().changeCount)).toBeGreaterThan(0);
  const before = await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    return [editors.original.getModel()!.getValue(), editors.modified.getModel()!.getValue()];
  });
  menu = await openMenu(page, 'Diff options');
  await menu.getByRole('menuitemcheckbox', { name: 'Ignore trim whitespace', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.playground.getState().changeCount)).toBe(0);
  await ready(page);
  expect(await page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    return [editors.original.getModel()!.getValue(), editors.modified.getModel()!.getValue()];
  })).toEqual(before);
  menu = await openMenu(page, 'Diff options');
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Ignore trim whitespace', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('outside clicks dismiss menus and opening another trigger leaves one active menu', async ({ page }) => {
  await open(page);
  const menu = await openMenu(page, 'Diff options');
  await page.locator('.editor-heading').click({ position: { x: 20, y: 12 } });
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Diff options', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await openMenu(page, 'Diff options');
  await openMenu(page, 'Layout');
  await expect(page.getByRole('menu')).toHaveCount(1);
  await expect(page.getByRole('menu', { name: 'Layout', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Diff options', exact: true })).toHaveAttribute('aria-expanded', 'false');
});

test('long fixture menus stay inside a narrow resized viewport and keyboard scrolling reveals the last choice', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 460 });
  await open(page);
  const menu = await openMenu(page, 'Choose fixture');
  await withinViewport(page, menu);
  await page.keyboard.press('End');
  const last = menu.getByRole('menuitemradio', { name: '20,000 lines · 299 changes', exact: true });
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await page.setViewportSize({ width: 640, height: 340 });
  await expect(menu).toBeVisible();
  await withinViewport(page, menu);
  await page.keyboard.press('Home');
  const first = menu.getByRole('menuitemradio', { name: 'Reference-style TSX fixture', exact: true });
  await expect(first).toBeFocused();
  await expect(first).toBeInViewport();
  await page.keyboard.press('End');
  await expect(last).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Choose fixture', exact: true })).toBeFocused();
});

test('fixture chooser typeahead and radio selection load the selected source models', async ({ page }) => {
  await open(page);
  const trigger = page.getByRole('button', { name: 'Choose fixture', exact: true });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Choose fixture', exact: true });
  await page.keyboard.type('unicode');
  const unicode = menu.getByRole('menuitemradio', { name: 'Unicode text', exact: true });
  await expect(unicode).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('Unicode text');
  await ready(page);
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getModel()!.getValue())).toContain('こんばんは 🌎');
  await expect(page.locator('.source-headers')).toHaveCount(0);
  await expect(page.locator('.editor-heading')).toContainText('unicode.ts');
  await openMenu(page, 'Choose fixture');
  await expect(unicode).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: 'Reference-style TSX fixture', exact: true })).toHaveAttribute('aria-checked', 'false');
});

test('project switcher uses compact IntelliJ project rows and keeps view controls in the toolbar', async ({ page }) => {
  await page.goto('/?view=project');
  await expect(page.getByRole('tree', { name: 'Project files', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Project switcher', exact: true });
  const menu = await openMenu(page, 'Project switcher');
  for (const name of ['New Project…', 'Open…', 'Clone Repository…']) await expect(menu.getByRole('menuitem', { name, exact: true })).toBeDisabled();
  await expect(menu.getByText('Open Projects', { exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^unintellij-example/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Commit changes', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Project files', exact: true })).toHaveCount(0);
  const geometry = await menu.evaluate(node => ({
    width: node.getBoundingClientRect().width,
    actionHeight: node.querySelector('.ui-menu-item')!.getBoundingClientRect().height,
    projectHeight: node.querySelector('.project-picker-entry')!.getBoundingClientRect().height,
    badgeSize: node.querySelector('.project-badge')!.getBoundingClientRect().width,
  }));
  expect(geometry).toEqual({ width: 230, actionHeight: 24, projectHeight: 52, badgeSize: 20 });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page).toHaveURL(/view=commit/);
  await expect(page.getByRole('main', { name: 'Selected file comparison', exact: true })).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Changed files', exact: true })).toBeVisible();
  await openMenu(page, 'Project switcher');
  await menu.getByRole('menuitem', { name: /^unintellij-example/ }).click();
  await expect(page).toHaveURL(/view=project/);
  await expect(page.getByRole('main', { name: 'Selected project file', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.projectPreview.editor?.getModel()?.getValue())).toContain('ReviewPreferencesPanel');
});

test('project and commit view menus apply presentation settings while preserving the draft', async ({ page }) => {
  await page.goto('/?view=project');
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  await expect(tree.getByText('~/Projects/unintellij-example', { exact: true })).toBeVisible();
  let menu = await openMenu(page, 'Project view options');
  const path = menu.getByRole('menuitemcheckbox', { name: 'Show repository path', exact: true });
  await expect(path).toHaveAttribute('aria-checked', 'true');
  await path.click();
  await expect(tree.getByText('~/Projects/unintellij-example', { exact: true })).toHaveCount(0);
  await openMenu(page, 'Project view options');
  await expect(path).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'Commit message (local draft)', exact: true });
  const message = 'Preserve my review draft while changing the panel presentation.';
  await draft.fill(message);
  menu = await openMenu(page, 'Commit view options');
  const draftOption = menu.getByRole('menuitemcheckbox', { name: 'Show commit message', exact: true });
  await expect(draftOption).toHaveAttribute('aria-checked', 'true');
  await draftOption.click();
  await expect(draft).toHaveCount(0);
  await openMenu(page, 'Commit view options');
  await expect(draftOption).toHaveAttribute('aria-checked', 'false');
  await draftOption.click();
  await expect(draft).toHaveValue(message);
});
