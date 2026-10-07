import { expect, test, type Page } from '@playwright/test';
const popup = (page: Page) => page.getByRole('dialog', { name: 'Git branches and actions', exact: true });
const search = (page: Page) => popup(page).getByRole('textbox', { name: 'Search for branches and actions', exact: true });
async function largeBranches(page: Page) {
  await page.goto('/?view=project');
  await page.waitForFunction(() => Boolean(window.branchPreview?.client));
  await page.evaluate(async () => {
    const client = window.branchPreview.client;
    const base = await client.listBranches('preview-project');
    const branches = Array.from({ length: 22000 }, (_, i) => ({ ref: `refs/remotes/origin/team/branch-${i}`, name: `origin/team/branch-${i}`, kind: 'remote' as const, oid: 'a'.repeat(40), current: false, ahead: 0, behind: 0 }));
    client.listBranches = async () => ({ ...base, branches: [...base.branches.filter(branch => branch.kind === 'local'), ...branches], recent: [] });
    window.branchPreview.refresh();
  });
  await page.getByRole('button', { name: 'Git branches', exact: true }).click();
  await expect(popup(page).getByText('Refreshing branches…', { exact: true })).toHaveCount(0);
}

test('22k branch rows stay bounded while searching, favoriting and navigating distant refs', async ({ page }) => {
  await largeBranches(page);
  await expect.poll(() => popup(page).locator('.branch-virtual-row').count()).toBeLessThan(60);
  await search(page).fill('branch-21999');
  const far = popup(page).getByRole('menuitem', { name: 'origin/team/branch-21999', exact: true });
  await expect(far).toBeVisible();
  await far.click();
  const submenu = page.getByRole('menu', { name: 'Actions for origin/team/branch-21999', exact: true });
  await expect(submenu).toBeVisible();
  await submenu.getByRole('menuitem', { name: 'Add to Favorites', exact: true }).click();
  await search(page).fill('');
  await popup(page).getByRole('menuitem', { name: 'Update Project…', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(popup(page).getByRole('menuitem', { name: 'origin/team/branch-21998', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menu', { name: 'Actions for origin/team/branch-21998', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Home');
  await expect(popup(page).getByRole('menuitem', { name: 'Update Project…', exact: true })).toBeFocused();
  await expect.poll(() => popup(page).locator('.branch-virtual-row').count()).toBeLessThan(60);
  await page.screenshot({ path: 'artifacts/monorepo-branches/large-branch-popup.png' });
});

test('scrolling and filtering a large grouped list preserves viewport coverage', async ({ page }) => {
  await largeBranches(page);
  const list = popup(page).getByRole('menu', { name: 'Branches and actions', exact: true });
  await list.evaluate(element => { element.scrollTop = element.scrollHeight * .6; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => popup(page).locator('.branch-virtual-row').count()).toBeLessThan(60);
  await expect.poll(async () => list.evaluate(element => [...element.querySelectorAll('.branch-row')].some(row => {
    const a = row.getBoundingClientRect(), b = element.getBoundingClientRect(); return a.top >= b.top && a.bottom <= b.bottom;
  }))).toBe(true);
  await search(page).fill('branch-12345');
  await expect(popup(page).getByRole('menuitem', { name: 'origin/team/branch-12345', exact: true })).toBeVisible();
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0);
});

test('mouse hover and scrolling preserve actual keyboard focus independently of selection', async ({ page }) => {
  await largeBranches(page);
  const list = popup(page).getByRole('menu', { name: 'Branches and actions', exact: true });
  const first = popup(page).getByRole('menuitem', { name: 'origin/team/branch-0', exact: true });
  const hovered = popup(page).getByRole('menuitem', { name: 'origin/team/branch-1', exact: true });
  await first.focus();
  await hovered.hover();
  await expect(hovered.locator('..')).toHaveClass(/is-selected/);
  await list.evaluate(element => { element.scrollTop = element.scrollHeight * .7; });
  await expect(first).toBeFocused();
  await expect.poll(() => popup(page).locator('.branch-virtual-row').count()).toBeLessThan(60);
  await expect.poll(() => list.evaluate(element => {
    const indices = [...element.querySelectorAll<HTMLElement>('[data-row-index]')].map(row => Number(row.dataset.rowIndex));
    return indices.every((value, index) => index === 0 || value > indices[index - 1]);
  })).toBe(true);
  await page.keyboard.press('ArrowDown');
  await expect(popup(page).getByRole('menuitem', { name: 'origin/team/branch-2', exact: true })).toBeFocused();

  const favorite = popup(page).getByRole('button', { name: 'Add origin/team/branch-2 to favorites', exact: true });
  await favorite.focus();
  await popup(page).getByRole('menuitem', { name: 'origin/team/branch-3', exact: true }).hover();
  await list.evaluate(element => { element.scrollTop = element.scrollHeight * .8; });
  await expect(favorite).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(popup(page).getByRole('menuitem', { name: 'origin/team/branch-3', exact: true })).toBeFocused();
  await list.evaluate(element => { element.scrollTop = element.scrollHeight * .8; });
  await search(page).focus();
  // Once focus leaves the menu, the distant former focused row may be reclaimed.
  await expect(favorite).toHaveCount(0);
});
