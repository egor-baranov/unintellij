import { expect, test, type Locator } from '@playwright/test';

async function highlighted(surface: Locator, count: number, enabled: boolean) {
  const tokens = surface.locator('.view-lines .view-line span span');
  await expect(tokens.filter({ hasText: /^"name"$/ }).first()).toHaveCSS('color', 'rgb(255, 203, 107)');
  await expect(tokens.filter({ hasText: /^"demo"$/ }).first()).toHaveCSS('color', 'rgb(195, 232, 141)');
  await expect(tokens.filter({ hasText: new RegExp(`^${enabled}$`) }).first()).toHaveCSS('color', 'rgb(192, 133, 255)');
  await expect(tokens.filter({ hasText: /^null$/ }).first()).toHaveCSS('color', 'rgb(192, 133, 255)');
  await expect(tokens.filter({ hasText: new RegExp(`^${count}$`) }).first()).toHaveCSS('color', 'rgb(255, 203, 107)');
}

test('Project JSON has syntax colors and a locally bundled working JSON worker', async ({ page }) => {
  const errors: string[] = [], workers: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('worker', worker => workers.push(worker.url()));
  await page.goto('/?view=project&path=package.json');
  await expect.poll(() => page.evaluate(() => window.projectPreview?.editor?.getModel()?.getLanguageId())).toBe('json');
  const sample = '{"name":"demo","enabled":true,"count":42,"fallback":null,"items":["one",2]}';
  await page.evaluate(sample => window.projectPreview.editor!.getModel()!.setValue(sample), sample);
  // Color assertions wait for Monaco's lazy JSON contribution to activate.
  await highlighted(page.getByTestId('file-surface'), 42, true);
  await expect.poll(() => workers.some(url => new URL(url).pathname.includes('json.worker'))).toBe(true);
  expect(workers.every(url => new URL(url).origin === 'http://127.0.0.1:4181')).toBe(true);
  await page.evaluate(async () => { await window.projectPreview.editor!.getAction('editor.action.formatDocument')!.run(); });
  const formatted = await page.evaluate(() => window.projectPreview.editor!.getValue());
  expect(formatted.split('\n').length).toBeGreaterThan(4);
  expect(JSON.parse(formatted)).toEqual(JSON.parse(sample));
  expect(errors).toEqual([]);
});

test('both JSON diff panes keep syntax colors alongside change decorations', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?fixture=json');
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
  expect(await page.evaluate(() => Object.values(window.playground.viewer!.getEditors()).map(editor => editor.getModel()!.getLanguageId()))).toEqual(['json', 'json']);
  await highlighted(page.locator('.smart-diff-pane[data-side="original"]'), 12, false);
  await highlighted(page.locator('.smart-diff-pane[data-side="modified"]'), 42, true);
  expect(errors).toEqual([]);
});
