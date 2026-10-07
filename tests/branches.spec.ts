import { expect, test, type Page } from '@playwright/test';

const trigger = (page: Page) => page.getByRole('button', { name: 'Git branches', exact: true });
const popup = (page: Page) => page.getByRole('dialog', { name: 'Git branches and actions', exact: true });
const search = (page: Page) => popup(page).getByRole('textbox', { name: 'Search for branches and actions', exact: true });
const branch = (page: Page, name: string) => popup(page).getByRole('menuitem', { name, exact: true }).first();
async function open(page: Page, scenario?: string) {
  await page.goto(`/?view=project${scenario ? `&branchScenario=${scenario}` : ''}`);
  await trigger(page).click();
  await expect(popup(page)).toBeVisible();
}
async function ready(page: Page) {
  await expect(popup(page).getByRole('menuitem', { name: 'New Branch…', exact: true })).toBeEnabled();
  await expect(popup(page).getByText('Refreshing branches…', { exact: true })).toHaveCount(0);
}
async function branchAction(page: Page, name: string, action: string) {
  await search(page).fill(name);
  await branch(page, name).click();
  await page.getByRole('menu', { name: `Actions for ${name}`, exact: true }).getByRole('menuitem', { name: action, exact: true }).click();
}
async function globalAction(page: Page, action: string) {
  await search(page).fill('');
  await popup(page).getByRole('menuitem', { name: action, exact: true }).click();
}

test('branch shortcuts open the popup, copy a focused branch and review a commit with default tracking hints', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?view=project');
  await expect(trigger(page)).toContainText('main');
  await expect(trigger(page).locator('.branch-trigger-tracking')).toHaveAttribute('aria-label', '1 outgoing, 1 incoming');
  await page.keyboard.press('Alt+Backquote');
  await expect(popup(page)).toBeVisible(); await ready(page);
  await expect(popup(page).getByRole('button', { name: 'Remove main from favorites', exact: true })).toBeVisible();
  const primary = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Meta' : 'Control');
  const name = 'feature/keyboard-navigation';
  await search(page).fill(name); await branch(page, name).focus();
  await page.keyboard.press(`${primary}+c`);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(name);
  await page.keyboard.press(`${primary}+k`);
  const commit = page.getByRole('dialog', { name: 'Commit Staged Changes', exact: true });
  await expect(commit).toBeVisible(); await expect(commit).toContainText('5 staged files');
  await commit.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(commit).toHaveCount(0);
});

test('branch search filters full names and actions without losing the active branch', async ({ page }) => {
  await open(page); await ready(page);
  await expect(trigger(page)).toContainText('main');
  await expect(search(page)).toBeFocused();
  await expect(branch(page, 'main')).toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: 'test-results/branches-popup.png' });
  await search(page).fill('KEYBOARD');
  await expect(branch(page, 'feature/keyboard-navigation')).toBeVisible();
  await expect(branch(page, 'main')).toHaveCount(0);
  await search(page).fill('new branch');
  await expect(popup(page).getByRole('menuitem', { name: 'New Branch…', exact: true })).toBeVisible();
  await expect(branch(page, 'feature/keyboard-navigation')).toHaveCount(0);
  await search(page).fill('no-such-branch');
  await expect(popup(page).getByText('No matching branches or actions.', { exact: true })).toBeVisible();
  await popup(page).getByRole('button', { name: 'Clear branch search', exact: true }).click();
  await expect(branch(page, 'main')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0); await expect(trigger(page)).toBeFocused();
});

test('keyboard submenus, favorites and popup preferences survive dismissal and reopening', async ({ page }) => {
  await open(page); await ready(page);
  await page.keyboard.press('ArrowUp');
  await expect(popup(page).getByRole('menuitem', { name: 'Tags', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(popup(page).getByRole('menuitem', { name: 'Update Project…', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(popup(page).getByRole('menuitem', { name: 'Tags', exact: true })).toBeFocused();
  const local = popup(page).getByRole('menuitem', { name: 'Local', exact: true });
  await local.focus(); await page.keyboard.press('ArrowLeft');
  await expect(local).toHaveAttribute('aria-expanded', 'false'); await expect(local).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(local).toHaveAttribute('aria-expanded', 'true');
  const name = 'feature/keyboard-navigation';
  await search(page).fill(name);
  await branch(page, name).focus(); await page.keyboard.press('ArrowRight');
  const submenu = page.getByRole('menu', { name: `Actions for ${name}`, exact: true });
  await expect(submenu.getByRole('menuitem', { name: 'Checkout', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(submenu.getByRole('menuitem', { name: 'Add to Favorites', exact: true })).toBeFocused();
  await page.keyboard.press('Space'); await page.keyboard.press('Escape');
  await expect(branch(page, name)).toBeFocused();
  await expect(popup(page).getByRole('button', { name: `Remove ${name} from favorites`, exact: true })).toBeVisible();
  await search(page).fill('');
  await popup(page).getByRole('button', { name: 'Branch popup settings', exact: true }).click();
  for (const label of ['Group by Prefix', 'Show Recent Branches', 'Show Tags']) {
    const setting = popup(page).getByRole('menuitemcheckbox', { name: label, exact: true });
    await expect(setting).toHaveAttribute('aria-checked', 'true'); await setting.click();
  }
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await trigger(page).click(); await ready(page);
  await popup(page).getByRole('button', { name: 'Branch popup settings', exact: true }).click();
  for (const label of ['Group by Prefix', 'Show Recent Branches', 'Show Tags']) {
    await expect(popup(page).getByRole('menuitemcheckbox', { name: label, exact: true })).toHaveAttribute('aria-checked', 'false');
  }
  await expect(popup(page).getByRole('menuitem', { name: 'Recent', exact: true })).toHaveCount(0);
  await expect(popup(page).getByRole('menuitem', { name: 'Tags', exact: true })).toHaveCount(0);
  await expect(popup(page).getByRole('button', { name: `Remove ${name} from favorites`, exact: true })).toBeVisible();
});

test('creating, renaming, checking out and deleting a sample branch updates the live selector', async ({ page }) => {
  await open(page); await ready(page);
  await globalAction(page, 'New Branch…');
  const create = page.getByRole('dialog', { name: 'New Branch', exact: true });
  await expect(create.getByRole('textbox', { name: 'Branch name', exact: true })).toBeFocused();
  await create.getByRole('textbox', { name: 'Branch name', exact: true }).fill('bad name');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create.getByRole('alert')).toContainText('valid branch name');
  await create.getByRole('textbox', { name: 'Branch name', exact: true }).fill('feature/review-flow');
  await expect(create.getByRole('checkbox', { name: 'Checkout branch', exact: true })).toBeChecked();
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create).toHaveCount(0); await expect(trigger(page)).toContainText('feature/review-flow');
  await branchAction(page, 'feature/review-flow', 'Rename…');
  const rename = page.getByRole('dialog', { name: 'Rename Branch', exact: true });
  await rename.getByRole('textbox', { name: 'New branch name', exact: true }).fill('feature/review-finished');
  await rename.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(rename).toHaveCount(0); await expect(trigger(page)).toContainText('feature/review-finished');
  await branchAction(page, 'main', 'Checkout');
  const checkout = page.getByRole('dialog', { name: 'Checkout Branch', exact: true });
  await checkout.getByRole('button', { name: 'Checkout', exact: true }).click();
  await expect(checkout).toHaveCount(0); await expect(trigger(page)).toContainText('main');
  await branchAction(page, 'feature/review-finished', 'Delete…');
  const remove = page.getByRole('dialog', { name: 'Delete Branch', exact: true });
  await remove.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(remove).toHaveCount(0);
  await search(page).fill('feature/review-finished');
  await expect(branch(page, 'feature/review-finished')).toHaveCount(0);
  await expect(trigger(page)).toContainText('main');
});

test('branch comparisons display real diff contents, added files, commits and swapped endpoints', async ({ page }) => {
  await open(page); await ready(page);
  await branchAction(page, 'feature/compact-gutter', 'Compare with Current');
  const comparison = page.getByRole('region', { name: 'Branch comparison', exact: true });
  await expect(comparison).toBeVisible(); await expect(popup(page)).toHaveCount(0);
  await expect(comparison.locator('.smart-diff')).toHaveAttribute('data-status', 'ready');
  await expect(comparison.locator('.branch-comparison-heading')).toContainText('feature/compact-gutter');
  const addedPath = 'packages/monaco-smart-diff/src/scrolling/mapping.ts';
  await comparison.getByRole('button', { name: addedPath, exact: true }).click();
  await expect(comparison.locator('.file-surface[data-added="true"]')).toBeVisible();
  await expect(comparison.locator('.file-surface')).toContainText('interpolate');
  await comparison.getByRole('button', { name: 'Swap comparison', exact: true }).click();
  await expect(comparison.getByRole('button', { name: 'Swap comparison', exact: true })).toBeEnabled();
  await comparison.getByRole('button', { name: addedPath, exact: true }).click();
  await expect(comparison.locator('.smart-diff')).toHaveAttribute('data-status', 'ready');
  await expect(comparison.locator('.file-surface[data-added="true"]')).toHaveCount(0);
  await comparison.getByRole('tab', { name: /^Commits/ }).click();
  await expect(comparison.getByRole('list', { name: 'Commits unique to each side', exact: true }).getByRole('listitem')).toHaveCount(2);
  await expect(comparison.getByRole('heading', { name: 'Only in main', exact: true })).toBeVisible();
  await comparison.getByRole('tab', { name: /^Files/ }).click();
  await page.screenshot({ path: 'test-results/branch-comparison.png' });
  await comparison.getByRole('button', { name: 'Close branch comparison', exact: true }).click();
  await expect(comparison).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Editor group 1', exact: true })).toBeVisible();
});

test('remote checkout creates a tracking branch and preview fetch, update and push remain explicit', async ({ page }) => {
  await open(page); await ready(page);
  await branchAction(page, 'origin/feature/search', 'Checkout');
  const checkout = page.getByRole('dialog', { name: 'Checkout Branch', exact: true });
  await checkout.getByRole('button', { name: 'Checkout', exact: true }).click();
  await expect(checkout).toHaveCount(0); await expect(trigger(page)).toContainText('feature/search');
  await popup(page).getByRole('button', { name: 'Fetch all remotes', exact: true }).click();
  await expect(popup(page).getByRole('status').filter({ hasText: 'No network request was made' })).toBeVisible();
  await globalAction(page, 'Update Project…');
  const update = page.getByRole('dialog', { name: 'Update Project', exact: true });
  await update.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(update).toHaveCount(0);
  await globalAction(page, 'Push…');
  const push = page.getByRole('dialog', { name: 'Push Branch', exact: true });
  const remote = push.getByRole('combobox', { name: 'Remote', exact: true });
  await expect(remote).toHaveText('origin');
  await remote.click();
  await expect(page.getByRole('option', { name: 'origin', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(push).toBeVisible();
  await expect(remote).toBeFocused();
  await push.getByRole('button', { name: 'Push', exact: true }).click();
  await expect(push).toHaveCount(0);
  await expect(popup(page).getByRole('status').filter({ hasText: 'pushed feature/search' })).toBeVisible();
});

test('comparing the current branch with itself shows no differences and preserves the project view', async ({ page }) => {
  await open(page); await ready(page);
  await branchAction(page, 'main', 'Compare with Current');
  const comparison = page.getByRole('region', { name: 'Branch comparison', exact: true });
  await expect(comparison.getByRole('heading', { name: 'No differences', exact: true })).toBeVisible();
  await expect(comparison.getByText('No changed files', { exact: true })).toBeVisible();
  await expect(comparison.locator('.smart-diff')).toHaveCount(0);
  await comparison.getByRole('button', { name: 'Close branch comparison', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Editor group 1', exact: true }).locator('.file-surface')).toBeVisible();
});

test('stale branch operations show an actionable error and retry uses a fresh snapshot', async ({ page }) => {
  await open(page, 'stale'); await ready(page);
  await globalAction(page, 'New Branch…');
  const create = page.getByRole('dialog', { name: 'New Branch', exact: true });
  await create.getByRole('textbox', { name: 'Branch name', exact: true }).fill('feature/retry');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create.getByRole('alert')).toContainText('Branches changed');
  await expect(create.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  await create.getByRole('button', { name: 'Review Latest State', exact: true }).click();
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create).toHaveCount(0); await expect(trigger(page)).toContainText('feature/retry');
});

test('Commit panel commits checked changes and leaves unchecked staged entries intact', async ({ page }) => {
  await page.goto('/?view=commit');
  const panel = page.getByRole('region', { name: 'Commit changes', exact: true });
  await expect(panel.getByRole('treeitem', { name: 'Changes', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  const checked = panel.locator('[role="treeitem"][data-file-id="new-panel"]');
  await checked.getByRole('checkbox').check();
  const message = 'Commit the selected new source file in the sample repository';
  await panel.getByRole('textbox', { name: 'Commit message (local draft)', exact: true }).fill(message);
  await panel.getByRole('button', { name: 'Commit', exact: true }).click();
  const commit = page.getByRole('dialog', { name: 'Commit Selected Changes', exact: true });
  await expect(commit.getByRole('textbox', { name: 'Commit message', exact: true })).toHaveValue(message);
  await expect(commit).toContainText('1 selected');
  await commit.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(commit).toHaveCount(0);
  await expect(checked).toHaveCount(0);
  await expect(panel.locator('[role="treeitem"][data-file-id="readme-staged"]')).toBeVisible();
  await expect(panel.getByRole('treeitem', { name: 'Changes', exact: true })).toBeVisible();
  await expect(panel.getByRole('treeitem', { name: 'Untracked', exact: true })).toBeVisible();
  await expect(panel.getByRole('treeitem', { name: 'Staged', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('treeitem', { name: 'Unstaged', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
});

test('initial errors and loading states recover without leaving a stale popup', async ({ page }) => {
  await open(page, 'error');
  await expect(popup(page).getByRole('alert')).toContainText('Sample branch listing failed');
  await popup(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await ready(page); await expect(branch(page, 'main')).toHaveAttribute('aria-current', 'true');
  await page.goto('/?view=project&branchScenario=loading'); await trigger(page).click();
  await expect(popup(page).getByRole('status').filter({ hasText: 'Refreshing branches' })).toBeVisible();
  await ready(page); await expect(branch(page, 'main')).toBeVisible();
});

test('detached and unborn repositories show their state and support creating a branch or first commit', async ({ page }) => {
  await open(page, 'detached'); await ready(page);
  await expect(popup(page).getByText(/Detached HEAD at/)).toBeVisible();
  await globalAction(page, 'New Branch…');
  const create = page.getByRole('dialog', { name: 'New Branch', exact: true });
  await create.getByRole('textbox', { name: 'Branch name', exact: true }).fill('feature/keep-detached');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create).toHaveCount(0); await expect(trigger(page)).toContainText('feature/keep-detached');
  await page.goto('/?view=project&branchScenario=unborn'); await trigger(page).click(); await ready(page);
  await expect(popup(page).getByText(/No commits yet/)).toBeVisible();
  await globalAction(page, 'Commit…');
  const commit = page.getByRole('dialog', { name: 'Commit Staged Changes', exact: true });
  await expect(commit.getByRole('checkbox', { name: 'Amend the last commit', exact: true })).toBeDisabled();
  await commit.getByRole('textbox', { name: 'Commit message', exact: true }).fill('Create preview history');
  await commit.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(commit).toHaveCount(0);
  await search(page).fill('main'); await expect(branch(page, 'main')).toHaveAttribute('aria-current', 'true');
  await expect(popup(page).getByText(/No commits yet/)).toHaveCount(0);
});

test('popup and submenu stay inside a small viewport and dismiss when clicking outside', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 500 }); await open(page); await ready(page);
  await search(page).fill('feature/keyboard-navigation');
  await branch(page, 'feature/keyboard-navigation').click();
  const submenu = page.getByRole('menu', { name: 'Actions for feature/keyboard-navigation', exact: true });
  for (const element of [popup(page), submenu]) {
    const bounds = (await element.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(760);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(500);
  }
  await page.screenshot({ path: 'test-results/branches-small-viewport.png' });
  await page.mouse.click(2, 498);
  await expect(popup(page)).toHaveCount(0); await expect(submenu).toHaveCount(0);
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
});
