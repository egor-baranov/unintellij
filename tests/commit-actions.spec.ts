import { expect, test, type Page } from '@playwright/test';
import type { BranchOperation } from '../apps/shared/branches/types';

interface RecordedOperation { operation: BranchOperation; token: string }
type ObservedWindow = Window & { commitActionCalls: RecordedOperation[] };
const panel = (page: Page) => page.getByRole('region', { name: 'Commit changes', exact: true });
const draft = (page: Page) => panel(page).getByRole('textbox', { name: 'Commit message (local draft)', exact: true });
const commit = (page: Page) => panel(page).getByRole('button', { name: 'Commit', exact: true });
const commitAndPush = (page: Page) => panel(page).getByRole('button', { name: 'Commit and Push…', exact: true });
const gear = (page: Page) => panel(page).getByRole('button', { name: 'Commit settings', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Commit settings', exact: true });
const review = (page: Page) => page.getByRole('dialog', { name: 'Commit Selected Changes', exact: true });
const push = (page: Page) => page.getByRole('dialog', { name: 'Push Branch', exact: true });
const row = (page: Page, id: string) => panel(page).locator(`[role="treeitem"][data-file-id="${id}"]`);

async function recordOperations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const observed = window as unknown as ObservedWindow;
    observed.commitActionCalls = [];
    const client = window.branchPreview.client;
    const original = client.runBranchOperation.bind(client);
    client.runBranchOperation = async (repositoryId, token, operation) => {
      observed.commitActionCalls.push({ operation: structuredClone(operation), token });
      return original(repositoryId, token, operation);
    };
  });
}
async function operations(page: Page): Promise<RecordedOperation[]> {
  return page.evaluate(() => (window as unknown as ObservedWindow).commitActionCalls);
}
async function open(page: Page): Promise<void> {
  await page.goto('/?view=commit');
  await expect(panel(page).getByRole('tree', { name: 'Changed files', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Git branches', exact: true })).toContainText('main');
  await panel(page).getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await recordOperations(page);
}
async function selectFile(page: Page, id = 'readme-staged'): Promise<void> {
  await row(page, id).getByRole('checkbox').check();
  await draft(page).fill('Commit the checked source change');
}

test('Commit is blue only when checked files and a nonblank message are ready', async ({ page }) => {
  await open(page);
  await expect(commit(page)).toBeDisabled();
  await expect(commitAndPush(page)).toBeDisabled();
  await draft(page).fill('A message without selected files');
  await expect(commit(page)).toBeDisabled();
  await expect(row(page, 'playground-main')).toHaveCount(1);
  await expect(row(page, 'playground-staged')).toHaveCount(0);
  await row(page, 'playground-main').getByRole('checkbox').check();
  await draft(page).fill('  \n\t ');
  await expect(commit(page)).toBeDisabled();
  await expect(commitAndPush(page)).toBeDisabled();
  await draft(page).fill('Commit the checked file');
  await expect(commit(page)).toBeEnabled();
  await expect(commitAndPush(page)).toBeEnabled();
  await expect.poll(() => commit(page).evaluate(node => {
    const [red, green, blue] = getComputedStyle(node).backgroundColor.match(/\d+/g)!.map(Number);
    return blue > red + 40 && blue > green;
  })).toBe(true);
  await expect(panel(page).getByRole('button', { name: 'Review selected', exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Copy review summary', exact: true })).toHaveCount(0);
  await commit(page).click();
  await expect(review(page)).toBeVisible();
  expect(await operations(page)).toEqual([]);
  await review(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await row(page, 'playground-main').getByRole('checkbox').uncheck();
  await expect(commit(page)).toBeDisabled();
  await expect(commitAndPush(page)).toBeDisabled();
  expect(await operations(page)).toEqual([]);
});

test('Commit settings persist, dismiss accessibly, and reach the selected commit unchanged', async ({ page }) => {
  await open(page);
  await selectFile(page);
  await gear(page).click();
  const author = settings(page).getByRole('textbox', { name: /Author/ });
  await expect(author).toBeFocused();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(panel(page).getByRole('tree', { name: 'Changed files', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(settings(page)).toBeVisible();
  await expect(review(page)).toHaveCount(0);
  await author.fill('Code Reviewer <reviewer@example.test>');
  for (const name of ['Sign-off commit', 'Check whitespace', 'Check TODO']) {
    await settings(page).getByRole('checkbox', { name, exact: true }).check();
  }
  const bounds = (await settings(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.keyboard.press('Escape');
  await expect(settings(page)).toHaveCount(0);
  await expect(gear(page)).toBeFocused();
  expect(await operations(page)).toEqual([]);

  await gear(page).click();
  await expect(author).toHaveValue('Code Reviewer <reviewer@example.test>');
  const outsideButton = panel(page).getByRole('button', { name: 'Expand all folders', exact: true });
  await outsideButton.click();
  await expect(settings(page)).toHaveCount(0);
  await expect(outsideButton).toBeFocused();
  await page.reload();
  await expect(gear(page)).toBeVisible();
  await recordOperations(page);
  await gear(page).click();
  await expect(author).toHaveValue('Code Reviewer <reviewer@example.test>');
  for (const name of ['Sign-off commit', 'Check whitespace', 'Check TODO']) {
    await expect(settings(page).getByRole('checkbox', { name, exact: true })).toBeChecked();
  }
  await page.keyboard.press('Escape');
  await commit(page).click();
  await expect(review(page)).toContainText('1 selected');
  await review(page).getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(review(page)).toHaveCount(0);
  expect((await operations(page)).map(call => call.operation)).toEqual([{
    kind: 'commit', message: 'Commit the checked source change', amend: false,
    changeIds: ['readme-staged'],
    options: { author: 'Code Reviewer <reviewer@example.test>', signOff: true, checkWhitespace: true, checkTodo: true },
  }]);
  await expect(commit(page)).toBeDisabled();
});

test('Commit and Push reviews each operation and pushes the newly committed snapshot', async ({ page }) => {
  await open(page);
  // Bring the sample branch up to date using its existing explicit review flow.
  await page.getByRole('button', { name: 'Git branches', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Update Project…', exact: true }).click();
  const update = page.getByRole('dialog', { name: 'Update Project', exact: true });
  await update.getByRole('radio', { name: 'Merge incoming changes', exact: true }).check();
  await update.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(update).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as unknown as ObservedWindow).commitActionCalls = []; });
  await selectFile(page, 'new-panel');
  await commitAndPush(page).click();
  await expect(review(page)).toBeVisible();
  await expect(push(page)).toHaveCount(0);
  expect(await operations(page)).toEqual([]);
  await review(page).getByRole('button', { name: 'Commit and Continue to Push', exact: true }).click();
  await expect(review(page)).toHaveCount(0);
  await expect(push(page)).toBeVisible();
  expect((await operations(page)).map(call => call.operation.kind)).toEqual(['commit']);
  await push(page).getByRole('button', { name: 'Push', exact: true }).click();
  await expect(push(page)).toHaveCount(0);
  const calls = await operations(page);
  expect(calls.map(call => call.operation.kind)).toEqual(['commit', 'push']);
  expect(calls[1].token).not.toBe(calls[0].token);
  await expect(row(page, 'new-panel')).toHaveCount(0);
  await expect(row(page, 'readme-staged')).toBeVisible();
});

test('failed push retries never create a second commit and cancel leaves the commit intact', async ({ page }) => {
  await open(page);
  await selectFile(page);
  await commitAndPush(page).click();
  await review(page).getByRole('button', { name: 'Commit and Continue to Push', exact: true }).click();
  await expect(push(page)).toBeVisible();
  const head = await page.evaluate(async () => {
    const client = window.branchPreview.client;
    const calls = (window as unknown as ObservedWindow).commitActionCalls;
    const repositoryId = 'preview-project';
    // The operation under test must already have completed before push is reviewed.
    return { calls: calls.length, snapshot: await client.listBranches(repositoryId) };
  });
  expect(head.calls).toBe(1);
  await push(page).getByRole('button', { name: 'Push', exact: true }).click();
  await expect(push(page).getByRole('alert')).toContainText('behind its upstream');
  await expect(review(page)).toHaveCount(0);
  await push(page).getByRole('button', { name: 'Push', exact: true }).click();
  await expect(push(page).getByRole('alert')).toContainText('behind its upstream');
  expect((await operations(page)).map(call => call.operation.kind)).toEqual(['commit', 'push', 'push']);
  await push(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(push(page)).toHaveCount(0);
  const after = await page.evaluate(() => window.branchPreview.client.listBranches('preview-project'));
  expect(after.head).toBe(head.snapshot.head);
  await expect(row(page, 'readme-staged')).toHaveCount(0);
});

test('a hot-reloaded renderer cannot submit selected commits to an older desktop backend', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const client = window.branchPreview.client;
    const list = client.listBranches.bind(client);
    client.listBranches = async id => ({ ...await list(id), selectedCommitSupported: undefined });
  });
  await page.getByRole('button', { name: 'Git branches', exact: true }).click();
  await expect(page.getByPlaceholder('Search for branches and actions')).toBeVisible();
  await page.keyboard.press('Escape');
  await selectFile(page);
  await commit(page).click();
  await expect(review(page)).toContainText('Restart unintellij');
  await expect(review(page).getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  expect(await operations(page)).toEqual([]);
});
