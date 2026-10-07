import { expect, test, type Page } from '@playwright/test';

const region = (page: Page) => page.getByRole('region', { name: 'Branch comparison', exact: true });
const filePath = 'packages/monaco-smart-diff/src/scrolling/mapping.ts';
interface Probe { calls: number; inFlight: number; maximum: number; staleReads: number }
async function probe(page: Page) {
  return page.evaluate(() => (window as unknown as { branchRefreshProbe: Probe }).branchRefreshProbe);
}
async function openComparison(page: Page, target: 'working' | 'head') {
  await page.getByRole('button', { name: 'Git branches', exact: true }).click();
  const popup = page.getByRole('dialog', { name: 'Git branches and actions', exact: true });
  await popup.getByRole('textbox', { name: 'Search for branches and actions', exact: true }).fill('feature/compact-gutter');
  await popup.getByRole('menuitem', { name: 'feature/compact-gutter', exact: true }).first().click();
  await page.getByRole('menu', { name: 'Actions for feature/compact-gutter', exact: true }).getByRole('menuitem', {
    name: target === 'working' ? 'Show Diff with Working Tree' : 'Compare with Current', exact: true,
  }).click();
  await expect(region(page)).toBeVisible();
  await region(page).getByRole('button', { name: filePath, exact: true }).click();
  await expect(region(page).locator('.file-surface')).toContainText('interpolate');
}
async function instrument(page: Page, staleReads = 0) {
  await page.evaluate(staleReads => {
    const state = { calls: 0, inFlight: 0, maximum: 0, staleReads };
    Object.assign(window, { branchRefreshProbe: state });
    const client = window.branchPreview.client;
    const compare = client.compareBranches.bind(client), read = client.readBranchComparison.bind(client);
    client.compareBranches = async (...args) => {
      state.calls++; state.inFlight++; state.maximum = Math.max(state.maximum, state.inFlight);
      try { await new Promise(resolve => setTimeout(resolve, 250)); return await compare(...args); }
      finally { state.inFlight--; }
    };
    client.readBranchComparison = async (...args) => {
      const value = await read(...args);
      if (state.staleReads > 0) { state.staleReads--; return { ...value, state: 'stale', message: 'Injected filesystem race' }; }
      return value.modified ? { ...value, modified: { ...value.modified, text: `${value.modified.text}\n// Automatically refreshed branch contents\n` } } : value;
    };
  }, staleReads);
}

test('working branch comparisons coalesce updates, recover stale reads, and preserve the selected editor', async ({ page }) => {
  await page.goto('/?view=project'); await openComparison(page, 'working');
  const editorId = await page.evaluate(() => {
    const editor = window.projectPreview.monaco.editor.getEditors().find(editor => editor.getDomNode()?.closest('.branch-comparison .file-surface'))!;
    editor.setPosition({ lineNumber: 2, column: 3 }); return editor.getId();
  });
  await instrument(page, 1);
  await page.evaluate(() => window.branchPreview.refresh());
  await expect.poll(async () => (await probe(page)).inFlight).toBe(1);
  await page.evaluate(() => { for (let index = 0; index < 20; index++) window.branchPreview.refresh(); });
  await expect(region(page).locator('.file-surface')).toContainText('Automatically refreshed branch contents');
  await expect(region(page).getByRole('button', { name: filePath, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(region(page).getByRole('button', { name: 'Refresh branch comparison', exact: true })).toBeEnabled();
  const state = await probe(page);
  expect(state.maximum).toBe(1); expect(state.calls).toBeGreaterThanOrEqual(2); expect(state.calls).toBeLessThanOrEqual(3);
  expect(state.staleReads).toBe(0);
  expect(await page.evaluate(() => {
    const editor = window.projectPreview.monaco.editor.getEditors().find(editor => editor.getDomNode()?.closest('.branch-comparison .file-surface'))!;
    return { id: editor.getId(), position: editor.getPosition() };
  })).toEqual({ id: editorId, position: { lineNumber: 2, column: 3 } });
  await expect(region(page).getByText('Comparison changed', { exact: true })).toHaveCount(0);
});

test('historical comparisons stay immutable and closing drops pending working-comparison results', async ({ page }) => {
  await page.goto('/?view=project'); await openComparison(page, 'head'); await instrument(page);
  await page.evaluate(() => window.branchPreview.refresh());
  // A notification must not schedule even a delayed historical recomparison.
  await page.waitForTimeout(500);
  expect((await probe(page)).calls).toBe(0);
  await region(page).getByRole('button', { name: 'Close branch comparison', exact: true }).click();
  await openComparison(page, 'working');
  await page.evaluate(() => window.branchPreview.refresh());
  await expect.poll(async () => (await probe(page)).inFlight).toBe(1);
  await region(page).getByRole('button', { name: 'Close branch comparison', exact: true }).click();
  await expect.poll(async () => (await probe(page)).inFlight).toBe(0);
  await expect(region(page)).toHaveCount(0);
});
