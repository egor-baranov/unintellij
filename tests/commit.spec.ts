import { expect, test, type Page } from '@playwright/test';

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    if (window.commitPreview?.editor) return window.commitPreview.getState().status === 'ready';
    const viewer = window.commitPreview?.viewer;
    if (!viewer || !/^(ready|empty)$/.test(viewer.getState().status)) return false;
    const comparison = viewer.getComparison(), editors = viewer.getEditors();
    return comparison?.originalVersion === editors.original.getModel()?.getVersionId()
      && comparison?.modifiedVersion === editors.modified.getModel()?.getVersionId();
  })).toBe(true);
  await settled(page);
}

async function open(page: Page): Promise<void> {
  await page.goto('/?view=commit');
  await expect(page.getByRole('tree', { name: 'Changed files' })).toBeVisible();
  await ready(page);
}

function file(page: Page, id: string) {
  return page.getByRole('tree', { name: 'Changed files' }).locator(`[role="treeitem"][data-file-id="${id}"]`);
}

function treeFolder(page: Page, name: string) {
  return page.getByRole('tree', { name: 'Changed files' }).locator(`[data-node-id="group:changes:directory:/${name}"]`);
}

async function choose(page: Page, id: string): Promise<void> {
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await file(page, id).click();
  await expect.poll(() => page.evaluate(() => window.commitPreview.getSelected())).toBe(id);
  await expect(file(page, id)).toHaveAttribute('aria-selected', 'true');
  await ready(page);
}

test('Changes merges staged and unstaged edits into one HEAD-to-working-file row', async ({ page }) => {
  await open(page);
  await expect(page.getByText('Preview', { exact: true })).toBeVisible();
  await choose(page, 'playground-main');
  const tree = page.getByRole('tree', { name: 'Changed files' });
  await expect(tree.getByRole('treeitem', { name: 'Staged', exact: true })).toHaveCount(0);
  await expect(tree.getByRole('treeitem', { name: 'Unstaged', exact: true })).toHaveCount(0);
  await expect(tree.locator('[data-path="apps/playground/src/main.tsx"]')).toHaveCount(1);
  await expect(file(page, 'playground-staged')).toHaveCount(0);
  const comparison = page.getByRole('main', { name: 'Selected file comparison' });
  await expect(comparison.locator('.source-headers')).toHaveCount(0);
  await expect(comparison).toHaveAttribute('data-original-label', 'HEAD');
  await expect(comparison).toHaveAttribute('data-modified-label', 'Working tree');
  const contents = await page.evaluate(() => {
    const editors = window.commitPreview.viewer!.getEditors();
    return { original: editors.original.getValue(), modified: editors.modified.getValue() };
  });
  expect(contents.original).toContain('<header>Changes</header>');
  expect(contents.modified).toContain('setFilter');
  await expect(comparison).toHaveAttribute('data-path', 'apps/playground/src/main.tsx');
  await file(page, 'playground-main').getByRole('checkbox').check();
  await page.getByRole('textbox', { name: 'Commit message (local draft)', exact: true }).fill('Commit the complete file');
  await page.locator('.commit-panel').getByRole('button', { name: 'Commit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Commit Selected Changes', exact: true });
  await expect(dialog).toContainText('1 selected');
});

test('review selection propagates through folders with real mixed checkbox states', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  const changes = page.getByRole('checkbox', { name: 'Include Changes in review', exact: true });
  await changes.check();
  const leaf = file(page, 'playground-main').getByRole('checkbox');
  await expect(leaf).toBeChecked();
  await leaf.uncheck();
  await expect(changes).toHaveAttribute('aria-checked', 'mixed');
  await expect.poll(() => changes.evaluate(node => (node as HTMLInputElement).indeterminate)).toBe(true);
  const apps = treeFolder(page, 'apps');
  await expect(apps.getByRole('checkbox')).toHaveAttribute('aria-checked', 'mixed');
  await changes.check();
  await expect(changes).toHaveAttribute('aria-checked', 'true');
  await expect(leaf).toBeChecked();
  await changes.uncheck();
  await expect(changes).toHaveAttribute('aria-checked', 'false');
  await expect(leaf).not.toBeChecked();
  // The checked list is review state: it must not replace the selected diff.
  expect(await page.evaluate(() => window.commitPreview.getSelected())).toBe('preferences');
  const commit = page.locator('.commit-panel').getByRole('button', { name: 'Commit', exact: true });
  await page.getByRole('textbox', { name: 'Commit message (local draft)', exact: true }).fill('Review selected source changes');
  await expect(commit).toBeDisabled();
  await file(page, 'readme-staged').getByRole('checkbox').check();
  await expect(commit).toBeEnabled();
  expect(await page.evaluate(() => window.commitPreview.getSelected())).toBe('preferences');
});

test('tree arrows, Enter, and Space operate folders, file selection, and review checks', async ({ page }) => {
  await open(page);
  const tree = page.getByRole('tree', { name: 'Changed files' });
  await page.getByRole('button', { name: 'Collapse all folders', exact: true }).click();
  const changes = tree.getByRole('treeitem', { name: 'Changes', exact: true });
  await expect(changes).toHaveAttribute('aria-expanded', 'false');
  await changes.focus();
  await page.keyboard.press('ArrowRight');
  await expect(changes).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(treeFolder(page, 'apps')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(changes).toBeFocused();
  await page.keyboard.press('End');
  await expect(tree.getByRole('treeitem').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(changes).toBeFocused();
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  const row = file(page, 'playground-main');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.commitPreview.getSelected())).toBe('playground-main');
  await ready(page);
  const checkbox = row.getByRole('checkbox');
  const wasChecked = await checkbox.isChecked();
  await row.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => checkbox.isChecked()).toBe(!wasChecked);
});

test('commit draft and checked files survive reload and open a selected commit review', async ({ page }) => {
  await open(page);
  const message = 'Review center gutters and preserve the current reading anchor.';
  const draft = page.getByRole('textbox', { name: 'Commit message (local draft)', exact: true });
  await draft.fill(message);
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await file(page, 'readme-staged').getByRole('checkbox').check();
  const originalModel = await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getModel()!.getValue());
  await page.locator('.commit-panel').getByRole('button', { name: 'Commit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Commit Selected Changes' });
  await expect(dialog.getByRole('textbox', { name: 'Commit message', exact: true })).toHaveValue(message);
  await expect(dialog).toContainText('1 selected');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  await ready(page);
  await expect(draft).toHaveValue(message);
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await expect(file(page, 'readme-staged').getByRole('checkbox')).toBeChecked();
  await expect(page.locator('.commit-panel').getByRole('button', { name: 'Commit', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getModel()!.getValue())).toBe(originalModel);
});

test('pointer and keyboard panel resizing relayout the live viewer', async ({ page }) => {
  await open(page);
  const separator = page.getByRole('separator', { name: 'Resize commit panel', exact: true });
  const comparison = page.getByRole('main', { name: 'Selected file comparison' });
  const originalWidth = (await comparison.boundingBox())!.width;
  const initial = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(initial + 20));
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
  await page.mouse.down();
  await page.mouse.move(handle.x + 62, handle.y + 80, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(initial + 60);
  await expect.poll(async () => (await comparison.boundingBox())!.width).toBeLessThan(originalWidth - 60);
  await ready(page);
  await expect.poll(() => page.evaluate(() => {
    const editor = window.commitPreview.viewer!.getEditors().original;
    const pane = document.querySelector('.smart-diff-pane[data-side="original"]')!;
    return Math.abs(editor.getLayoutInfo().width - pane.getBoundingClientRect().width);
  })).toBeLessThan(1);
  await expect(page.locator('.smart-diff-connectors path.connector')).not.toHaveCount(0);
});

test('commit preview keeps diff navigation, layout, and synchronization controls working', async ({ page }) => {
  await open(page);
  await expect.poll(() => page.evaluate(() => window.commitPreview.getState().changeCount)).toBeGreaterThan(1);
  const initial = await page.evaluate(() => window.commitPreview.getState().currentChange);
  await page.getByRole('button', { name: 'Next change', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.commitPreview.getState().currentChange)).toBe(initial + 1);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => page.evaluate(() => window.commitPreview.getState().currentChange)).toBe(initial);
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Aligned', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Layout', exact: true })).toHaveText('Aligned');
  await ready(page);
  const sync = page.getByRole('button', { name: 'Synchronize scrolling', exact: true });
  await sync.click();
  await expect(sync).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Compact', exact: true }).click();
  await sync.click();
  await expect(sync).toHaveAttribute('aria-pressed', 'true');
  await ready(page);
  await expect(page.locator('.smart-diff-connectors path.connector')).not.toHaveCount(0);
});

test('untracked text opens one added-file editor and binary selections recover to text', async ({ page }) => {
  await open(page);
  await choose(page, 'new-panel');
  const comparison = page.getByRole('main', { name: 'Selected file comparison' });
  await expect(comparison.locator('.source-headers')).toHaveCount(0);
  await expect(comparison.getByTestId('file-surface')).toHaveAttribute('data-path', 'apps/shared/commit/CommitPanel.tsx');
  await expect(comparison.locator('[data-added="true"]')).toBeVisible();
  expect(await page.evaluate(() => window.commitPreview.viewer)).toBeNull();
  expect(await page.evaluate(() => window.commitPreview.editor!.getModel()!.getValue())).toContain('CommitPanelProps');
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await file(page, 'binary').click();
  await expect(file(page, 'binary')).toHaveAttribute('title', /artifacts\/sample\.bin/);
  await expect(comparison.getByRole('heading', { name: 'Binary file', exact: true })).toBeVisible();
  await expect(page.locator('.smart-diff')).toHaveCount(0);
  await choose(page, 'colors');
  await expect(page.locator('.smart-diff')).toHaveCount(1);
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getModel()!.getValue())).toContain('--addition: #264b33');
});

const messageDivider = (page: Page) => page.getByRole('separator', { name: 'Resize commit message', exact: true });
const commitMessage = (page: Page) => page.getByRole('textbox', { name: 'Commit message (local draft)', exact: true });

async function messageLayout(page: Page) {
  const message = (await commitMessage(page).boundingBox())!;
  const tree = (await page.getByRole('tree', { name: 'Changed files', exact: true }).boundingBox())!;
  return { message: message.height, tree: tree.height };
}

async function dragMessage(page: Page, deltaY: number): Promise<void> {
  const bounds = (await messageDivider(page).boundingBox())!;
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + deltaY, { steps: 8 });
  await page.mouse.up();
  await settled(page);
}

async function toggleMessage(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Commit view options', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Show commit message', exact: true }).click();
}

test('commit message divider resizes the draft against the file tree without losing draft or selections', async ({ page }) => {
  await open(page);
  await choose(page, 'playground-main');
  const checked = file(page, 'playground-main').getByRole('checkbox');
  await checked.check();
  const text = 'Preserve the commit draft while reviewing changes.\nKeep selected files and the current diff.';
  await commitMessage(page).fill(text);
  await commitMessage(page).evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(9, 25));
  const before = await messageLayout(page);
  const model = await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getModel()!.uri.toString());
  await expect(commitMessage(page)).toHaveCSS('resize', 'none');
  await expect(messageDivider(page)).toHaveAttribute('aria-orientation', 'horizontal');

  await dragMessage(page, -55);
  await expect.poll(async () => (await messageLayout(page)).message).toBeCloseTo(before.message + 55, 0);
  const grown = await messageLayout(page);
  expect(grown.tree).toBeCloseTo(before.tree - (grown.message - before.message), 0);
  await dragMessage(page, 35);
  await expect.poll(async () => (await messageLayout(page)).message).toBeCloseTo(grown.message - 35, 0);
  const shrunk = await messageLayout(page);
  expect(shrunk.tree).toBeCloseTo(grown.tree + (grown.message - shrunk.message), 0);
  expect(Number(await messageDivider(page).getAttribute('aria-valuenow'))).toBeCloseTo(shrunk.message, 0);

  await expect(commitMessage(page)).toHaveValue(text);
  expect(await commitMessage(page).evaluate(node => ({ start: (node as HTMLTextAreaElement).selectionStart, end: (node as HTMLTextAreaElement).selectionEnd }))).toEqual({ start: 9, end: 25 });
  await expect(checked).toBeChecked();
  await expect(file(page, 'playground-main')).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => window.commitPreview.getSelected())).toBe('playground-main');
  expect(await page.evaluate(() => window.commitPreview.viewer!.getEditors().modified.getModel()!.uri.toString())).toBe(model);
});

test('commit message divider supports keyboard bounds and reset without submitting the draft', async ({ page }) => {
  await open(page);
  await commitMessage(page).fill('A draft that stays local during keyboard resizing.');
  const separator = messageDivider(page);
  const initial = (await messageLayout(page)).message;
  await separator.focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await messageLayout(page)).message).toBeGreaterThan(initial);
  const grown = (await messageLayout(page)).message;
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await messageLayout(page)).message).toBeLessThan(grown);
  await expect(separator).toBeFocused();

  await page.keyboard.press('Home');
  await expect.poll(async () => (await messageLayout(page)).message - Number(await separator.getAttribute('aria-valuemin'))).toBeCloseTo(0, 0);
  const minimum = (await messageLayout(page)).message;
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await messageLayout(page)).message).toBeCloseTo(minimum, 0);
  await page.keyboard.press('End');
  await expect.poll(async () => (await messageLayout(page)).message - Number(await separator.getAttribute('aria-valuemax'))).toBeCloseTo(0, 0);
  const maximum = (await messageLayout(page)).message;
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await messageLayout(page)).message).toBeCloseTo(maximum, 0);
  expect(maximum).toBeGreaterThan(minimum);

  await page.keyboard.press('Enter');
  await expect.poll(async () => (await messageLayout(page)).message).toBeCloseTo(initial, 0);
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await messageLayout(page)).message).toBeGreaterThan(initial);
  await separator.dblclick();
  await expect.poll(async () => (await messageLayout(page)).message).toBeCloseTo(initial, 0);
  await expect(commitMessage(page)).toHaveValue('A draft that stays local during keyboard resizing.');
  await expect(page.getByRole('dialog', { name: /^Commit .* Changes$/ })).toHaveCount(0);
});

test('commit message divider clamps pointer resizing and adapts to a short viewport', async ({ page }) => {
  await open(page);
  const separator = messageDivider(page);
  let bounds = (await separator.boundingBox())!;
  await dragMessage(page, 5 - (bounds.y + bounds.height / 2));
  await expect.poll(async () => (await messageLayout(page)).message - Number(await separator.getAttribute('aria-valuemax'))).toBeCloseTo(0, 0);
  const largeMaximum = Number(await separator.getAttribute('aria-valuemax'));
  bounds = (await separator.boundingBox())!;
  await dragMessage(page, page.viewportSize()!.height - 5 - (bounds.y + bounds.height / 2));
  await expect.poll(async () => (await messageLayout(page)).message - Number(await separator.getAttribute('aria-valuemin'))).toBeCloseTo(0, 0);

  await separator.focus();
  await page.keyboard.press('End');
  await page.setViewportSize({ width: 1000, height: 430 });
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuemax'))).toBeLessThan(largeMaximum);
  await expect.poll(async () => {
    const height = (await messageLayout(page)).message;
    return height >= Number(await separator.getAttribute('aria-valuemin')) - .5
      && height <= Number(await separator.getAttribute('aria-valuemax')) + .5;
  }).toBe(true);
  const short = await messageLayout(page);
  expect(short.tree).toBeGreaterThanOrEqual(80);
  await expect(separator).toBeInViewport();
  await expect(commitMessage(page)).toBeInViewport();
  await expect(page.locator('.commit-panel').getByRole('button', { name: 'Commit', exact: true })).toBeInViewport();
  const panel = (await page.locator('.commit-panel').boundingBox())!;
  const footer = (await page.locator('.commit-panel .commit-footer-actions').boundingBox())!;
  expect(footer.y + footer.height).toBeLessThanOrEqual(panel.y + panel.height + 1);
});

test('hiding and showing the commit message retains its size, draft and review selection', async ({ page }) => {
  await open(page);
  await choose(page, 'readme-staged');
  const checked = file(page, 'readme-staged').getByRole('checkbox');
  await checked.check();
  await commitMessage(page).fill('Retain this draft while the message panel is hidden.');
  await dragMessage(page, -45);
  const before = await messageLayout(page);
  await toggleMessage(page);
  await expect(commitMessage(page)).toHaveCount(0);
  await expect(messageDivider(page)).toHaveCount(0);
  await expect.poll(async () => (await page.getByRole('tree', { name: 'Changed files', exact: true }).boundingBox())!.height).toBeGreaterThan(before.tree + before.message);
  await expect(checked).toBeChecked();
  await expect(file(page, 'readme-staged')).toHaveAttribute('aria-selected', 'true');

  await toggleMessage(page);
  await expect(messageDivider(page)).toBeVisible();
  await expect.poll(async () => (await messageLayout(page)).message).toBeCloseTo(before.message, 0);
  await expect(commitMessage(page)).toHaveValue('Retain this draft while the message panel is hidden.');
  await expect(checked).toBeChecked();
  expect(await page.evaluate(() => window.commitPreview.getSelected())).toBe('readme-staged');
});
