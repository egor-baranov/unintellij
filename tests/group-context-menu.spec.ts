import { expect, test, type Page } from '@playwright/test';

type Group = 'changes' | 'untracked';
const names = { changes: 'Changes', untracked: 'Unversioned Files' };
const tree = (page: Page) => page.getByRole('tree', { name: 'Changed files', exact: true });
const row = (page: Page, id: Group) => tree(page).locator(`[data-node-id="group:${id}"]`);
const menu = (page: Page, id: Group) => page.getByRole('menu', { name: `${names[id]} actions`, exact: true });
const check = (page: Page, id: Group) => row(page, id).getByRole('checkbox');

async function open(page: Page) {
  await page.goto('/?view=commit&file=playground-main');
  await expect(tree(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.commitPreview?.getState().status)).toMatch(/^(ready|empty)$/);
}

async function context(page: Page, id: Group, key?: 'Shift+F10' | 'ContextMenu') {
  if (key) { await row(page, id).focus(); await page.keyboard.press(key); }
  else await row(page, id).click({ button: 'right' });
  await expect(menu(page, id)).toBeVisible();
  return menu(page, id);
}

test('both group headers open compact menus without changing the active diff, checks, or expansion', async ({ page }) => {
  await open(page);
  await check(page, 'changes').check();
  const selected = await page.evaluate(() => window.commitPreview.getSelected());
  for (const id of ['changes', 'untracked'] as const) {
    const expanded = await row(page, id).getAttribute('aria-expanded');
    const checked = await check(page, id).getAttribute('aria-checked');
    const popup = await context(page, id);
    for (const name of ['Add to Git', 'Remove from Git…', 'Include All in Commit', 'Exclude All from Commit', 'Expand All', 'Collapse All']) {
      await expect(popup.getByRole('menuitem', { name, exact: true })).toBeVisible();
    }
    for (const name of ['New', 'Rename…', 'Copy Path', 'Copy Relative Path', 'Jump to Source', 'Open In']) {
      await expect(popup.getByRole('menuitem', { name, exact: true })).toHaveCount(0);
    }
    await expect(popup.getByRole('menuitem', { name: 'Add to Git', exact: true })).toBeDisabled();
    await expect(popup.getByRole('menuitem', { name: 'Remove from Git…', exact: true })).toBeDisabled();
    expect(await row(page, id).getAttribute('aria-expanded')).toBe(expanded);
    expect(await check(page, id).getAttribute('aria-checked')).toBe(checked);
    expect(await page.evaluate(() => window.commitPreview.getSelected())).toBe(selected);
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(row(page, id)).toBeFocused();
  }
});

test('group include and exclude apply only to that group and restore keyboard focus', async ({ page }) => {
  await open(page);
  let popup = await context(page, 'untracked', 'Shift+F10');
  await popup.getByRole('menuitem', { name: 'Include All in Commit', exact: true }).click();
  await expect(check(page, 'untracked')).toHaveAttribute('aria-checked', 'true');
  await expect(check(page, 'changes')).toHaveAttribute('aria-checked', 'false');
  await expect(row(page, 'untracked')).toBeFocused();
  popup = await context(page, 'changes', 'ContextMenu');
  await popup.getByRole('menuitem', { name: 'Include All in Commit', exact: true }).click();
  await expect(check(page, 'changes')).toHaveAttribute('aria-checked', 'true');
  popup = await context(page, 'untracked', 'ContextMenu');
  await popup.getByRole('menuitem', { name: 'Exclude All from Commit', exact: true }).click();
  await expect(check(page, 'untracked')).toHaveAttribute('aria-checked', 'false');
  await expect(check(page, 'changes')).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => window.commitPreview.getSelected())).toBe('playground-main');
});

test('group expansion actions leave the other group and active comparison alone', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  const otherRows = await tree(page).locator('[data-node-id^="group:untracked:"]').count();
  let popup = await context(page, 'changes');
  await popup.getByRole('menuitem', { name: 'Collapse All', exact: true }).click();
  await expect(row(page, 'changes')).toHaveAttribute('aria-expanded', 'false');
  await expect(tree(page).locator('[data-node-id^="group:changes:"]')).toHaveCount(0);
  await expect(tree(page).locator('[data-node-id^="group:untracked:"]')).toHaveCount(otherRows);
  popup = await context(page, 'changes', 'Shift+F10');
  await popup.getByRole('menuitem', { name: 'Expand All', exact: true }).click();
  await expect(row(page, 'changes')).toHaveAttribute('aria-expanded', 'true');
  await expect(tree(page).locator('[data-file-id="playground-main"]')).toBeVisible();
  await expect(tree(page).locator('[data-node-id^="group:untracked:"]')).toHaveCount(otherRows);
  expect(await page.evaluate(() => window.commitPreview.getSelected())).toBe('playground-main');
});
