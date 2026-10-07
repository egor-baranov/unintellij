import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const category = (page: Page, name: string) => settings(page).getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name, exact: true }).click();
async function choose(page: Page, label: string, option: string) {
  await settings(page).getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function open(page: Page, query = 'view=project') {
  await page.goto(`/?${query}`);
  await expect.poll(() => page.evaluate(() => (window.projectPreview?.editor ?? window.commitPreview?.editor ?? window.playground?.viewer?.getEditors().modified)?.getModel()?.getValueLength() ?? 0)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings(page)).toBeVisible();
}
async function font(page: Page) {
  return page.evaluate(() => {
    const editor = window.projectPreview?.editor ?? window.commitPreview?.editor ?? window.playground?.viewer?.getEditors().modified;
    const monaco = window.projectPreview?.monaco ?? window.playground?.monaco;
    return editor && monaco ? { size: editor.getOption(monaco.editor.EditorOption.fontSize), family: editor.getOption(monaco.editor.EditorOption.fontFamily),
      lineHeight: editor.getOption(monaco.editor.EditorOption.lineHeight), model: editor.getModel()?.uri.toString(), position: editor.getPosition() } : null;
  });
}
async function importText(page: Page, name: string, text: string) {
  await category(page, 'Schemes');
  await settings(page).getByLabel('Import scheme file').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
}

test('settings live-preview fonts and scale, cancel restores editors without replacing models', async ({ page }) => {
  await open(page);
  const before = await font(page);
  const toolbar = page.locator('.topbar');
  const height = (await toolbar.boundingBox())!.height;
  await settings(page).getByRole('spinbutton', { name: 'UI scale', exact: true }).fill('125');
  await expect.poll(async () => (await toolbar.boundingBox())!.height).toBeCloseTo(height * 1.25, 0);
  await category(page, 'Editor Font');
  await settings(page).getByRole('spinbutton', { name: 'Editor font size', exact: true }).fill('24');
  await settings(page).getByRole('textbox', { name: 'Editor font family', exact: true }).fill('monospace');
  await expect.poll(async () => (await font(page))?.size).toBe(30);
  await expect.poll(async () => (await font(page))?.family).toBe('monospace');
  await settings(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settings(page)).toHaveCount(0);
  expect(await font(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

test('Apply and Save persist fonts and scaling for current and newly opened files', async ({ page }) => {
  await open(page);
  await settings(page).getByRole('textbox', { name: 'UI font family', exact: true }).fill('Arial, sans-serif');
  await settings(page).getByRole('spinbutton', { name: 'UI font size', exact: true }).fill('15');
  await settings(page).getByRole('spinbutton', { name: 'UI scale', exact: true }).fill('110');
  await category(page, 'Editor Font');
  await settings(page).getByRole('spinbutton', { name: 'Editor font size', exact: true }).fill('20');
  await settings(page).getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(settings(page)).toBeVisible();
  await settings(page).getByRole('spinbutton', { name: 'Editor font size', exact: true }).fill('12');
  await settings(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(async () => (await font(page))?.size).toBe(22);
  await page.reload();
  await expect.poll(async () => (await font(page))?.size).toBe(22);
  await expect(page.locator('.project-panel')).toHaveCSS('font-family', 'Arial, sans-serif');
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await expect(page.locator('.file-surface')).toHaveAttribute('data-path', 'README.md');
  await expect.poll(async () => (await font(page))?.size).toBe(22);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('button', { name: 'Restore defaults', exact: true }).click();
  await settings(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await font(page))?.size).toBe(16);
});

test('component themes and syntax styles update independently in the real editor', async ({ page }) => {
  await open(page);
  await choose(page, 'Theme preset', 'Light');
  await expect(page.locator('.file-surface .monaco-editor')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.project-panel')).toHaveCSS('background-color', 'rgb(247, 248, 250)');
  await category(page, 'Component Themes');
  await choose(page, 'Component', 'Project tree');
  await settings(page).getByRole('textbox', { name: 'Background', exact: true }).fill('#e8eaf0');
  await expect(page.locator('.project-panel')).toHaveCSS('background-color', 'rgb(232, 234, 240)');
  await expect(page.locator('.file-surface .monaco-editor')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await category(page, 'Syntax Colors');
  await settings(page).getByRole('textbox', { name: 'Keywords color', exact: true }).fill('#be127e');
  await settings(page).getByRole('button', { name: 'Keywords bold', exact: true }).click();
  const keyword = page.locator('.file-surface .view-lines span').filter({ hasText: /^import\s*$/ }).first();
  await expect(keyword).toHaveCSS('color', 'rgb(190, 18, 126)');
  await expect(keyword).toHaveCSS('font-weight', '700');
  await settings(page).getByRole('checkbox', { name: 'Syntax highlighting', exact: true }).uncheck();
  await expect(page.locator('.file-surface .view-lines .view-line').first().locator('span span').first()).toHaveCSS('color', 'rgb(32, 33, 36)');
  await settings(page).getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await expect(page.locator('.project-panel')).toHaveCSS('background-color', 'rgb(232, 234, 240)');
});

test('IntelliJ editor schemes import real colors and styles, and exports round-trip', async ({ page }) => {
  await open(page);
  const xml = `<scheme name="Imported Test" version="142" parent_scheme="Darcula"><option name="EDITOR_FONT_NAME" value="Menlo"/><option name="EDITOR_FONT_SIZE" value="19"/><colors><option name="CARET_COLOR" value="00ff00"/></colors><attributes><option name="TEXT"><value><option name="FOREGROUND" value="abcdef"/><option name="BACKGROUND" value="161b22"/></value></option><option name="DEFAULT_KEYWORD"><value><option name="FOREGROUND" value="ff7788"/><option name="FONT_TYPE" value="3"/></value></option></attributes></scheme>`;
  await importText(page, 'test.icls', xml);
  await expect(settings(page).getByRole('status')).toContainText('Imported test.icls');
  await expect.poll(async () => (await font(page))?.size).toBe(19);
  await expect(page.locator('.file-surface .monaco-editor')).toHaveCSS('background-color', 'rgb(22, 27, 34)');
  const keyword = page.locator('.file-surface .view-lines span').filter({ hasText: /^import\s*$/ }).first();
  await expect(keyword).toHaveCSS('color', 'rgb(255, 119, 136)');
  await expect(keyword).toHaveCSS('font-style', 'italic');
  const downloadEvent = page.waitForEvent('download');
  await settings(page).getByRole('button', { name: 'unintellij JSON', exact: true }).click();
  const download = await downloadEvent;
  const contents = await readFile((await download.path())!, 'utf8');
  expect(JSON.parse(contents).editor.fontSize).toBe(19);
  await settings(page).getByRole('button', { name: 'Restore defaults', exact: true }).click();
  await importText(page, download.suggestedFilename(), contents);
  await expect.poll(async () => (await font(page))?.size).toBe(19);
  const iclsEvent = page.waitForEvent('download');
  await settings(page).getByRole('button', { name: 'IntelliJ .icls', exact: true }).click();
  const icls = await iclsEvent;
  const output = await readFile((await icls.path())!, 'utf8');
  expect(output).toContain('DEFAULT_KEYWORD');
  expect(output.toLowerCase()).toContain('ff7788');
  await importText(page, 'roundtrip.icls', output);
  await expect.poll(async () => (await font(page))?.size).toBe(19);
});

test('IntelliJ UI themes support named/nested colors and reject unsafe or malformed schemes', async ({ page }) => {
  await open(page);
  await importText(page, 'sample.theme.json', JSON.stringify({ name: 'Custom UI', dark: true, colors: { panel: '#222b38', selected: '#355577' }, ui: { Panel: { background: 'panel' }, EditorTabs: { selectedBackground: 'selected' } }, editorScheme: '/not-loaded.xml' }));
  await expect(settings(page).getByRole('status')).toContainText('Imported sample.theme.json');
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(34, 43, 56)');
  await expect(page.locator('.workspace-tab-shell.is-selected')).toHaveCSS('background-color', 'rgb(53, 85, 119)');
  const themeEvent = page.waitForEvent('download');
  await settings(page).getByRole('button', { name: 'IntelliJ .theme.json', exact: true }).click();
  const output = await themeEvent;
  expect(JSON.parse(await readFile((await output.path())!, 'utf8')).ui).toBeTruthy();
  await importText(page, 'bad.icls', '<!DOCTYPE scheme [<!ENTITY external SYSTEM "file:///etc/passwd">]><scheme name="Bad">&external;</scheme>');
  await expect(settings(page).getByRole('alert')).toBeVisible();
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(34, 43, 56)');
  await importText(page, 'bad.json', '{ invalid');
  await expect(settings(page).getByRole('alert')).toBeVisible();
  await settings(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(37, 39, 42)');
});

test('settings search, shortcuts and scaled modal remain usable without altering the workspace', async ({ page }) => {
  await page.setViewportSize({ width: 950, height: 640 });
  await open(page);
  await settings(page).getByRole('spinbutton', { name: 'UI scale', exact: true }).fill('150');
  const bounds = (await settings(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(950); expect(bounds.y + bounds.height).toBeLessThanOrEqual(640);
  await expect(settings(page).getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  await settings(page).getByRole('searchbox', { name: 'Search settings' }).fill('ligatures');
  await expect(settings(page).getByRole('heading', { name: 'Editor Font' })).toBeVisible();
  await expect(settings(page).getByRole('checkbox', { name: 'Font ligatures' })).toBeVisible();
  await page.keyboard.press('Control+b');
  await expect(page.getByRole('group', { name: 'Workspace view' }).getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(settings(page)).toHaveCount(0);
  await page.keyboard.press('Control+Alt+s');
  await expect(settings(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

test('appearance changes preserve diff state and update connector geometry and colors', async ({ page }) => {
  await page.goto('/?fixture=reference');
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  const before = await page.evaluate(async () => {
    const viewer = window.playground.viewer!;
    viewer.nextChange(); viewer.nextChange();
    const id = document.querySelector<HTMLElement>('.smart-diff-omission')?.dataset.regionId;
    if (id) viewer.expandRegion(id);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return { view: viewer.saveViewState(), comparison: viewer.getComparison(), model: viewer.getEditors().modified.getModel()!.uri.toString() };
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await category(page, 'Editor Font');
  await settings(page).getByRole('spinbutton', { name: 'Editor font size', exact: true }).fill('22');
  await settings(page).getByRole('spinbutton', { name: 'Line height', exact: true }).fill('32');
  await category(page, 'Component Themes');
  await choose(page, 'Component', 'Diff highlights');
  await settings(page).getByRole('textbox', { name: 'Modified lines', exact: true }).fill('#204966');
  await settings(page).getByRole('button', { name: 'Save', exact: true }).click();
  const after = await page.evaluate(() => {
    const viewer = window.playground.viewer!;
    return { view: viewer.saveViewState(), comparison: viewer.getComparison(), model: viewer.getEditors().modified.getModel()!.uri.toString() };
  });
  expect(after.model).toBe(before.model);
  expect(after.comparison).toEqual(before.comparison);
  expect(after.view.currentChangeId).toBe(before.view.currentChangeId);
  expect(after.view.expandedRegions).toEqual(before.view.expandedRegions);
  expect(Math.abs(after.view.modified.anchor.line - before.view.modified.anchor.line)).toBeLessThan(1);
  await expect(page.locator('.connector-replace').first()).toHaveCSS('fill', 'rgb(32, 73, 102)');
  await expect(page.locator('.smart-diff-line-replace').first()).toHaveCSS('background-color', 'rgb(32, 73, 102)');
  await expect.poll(() => page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    const nodes = [...document.querySelectorAll<SVGTextElement>('.smart-diff-line-number')];
    return nodes.length > 0 && nodes.every(node => {
      const editor = editors[node.dataset.numberSide as 'original' | 'modified'], line = Number(node.dataset.lineNumber);
      return Math.abs(Number(node.getAttribute('y')) - (editor.getTopForLineNumber(line) - editor.getScrollTop() + editor.getLineHeightForPosition({ lineNumber: line, column: 1 }) / 2)) < .6;
    });
  })).toBe(true);
});

test('settings changes reach both split groups and scaled menus and resizing use viewport coordinates', async ({ page }) => {
  await open(page);
  await settings(page).getByRole('spinbutton', { name: 'UI scale', exact: true }).fill('125');
  await category(page, 'Editor Font');
  await settings(page).getByRole('spinbutton', { name: 'Editor font size', exact: true }).fill('18');
  await settings(page).getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Editor group 1 options', exact: true }).click();
  const split = page.getByRole('menuitem', { name: 'Split right', exact: true });
  await expect(split).toBeInViewport();
  await split.click();
  const first = page.getByRole('region', { name: 'Editor group 1', exact: true });
  const second = page.getByRole('region', { name: 'Editor group 2', exact: true });
  await expect(second.locator('.file-surface .view-lines')).toHaveCSS('font-size', '22.5px');
  await expect(first.locator('.file-surface .view-lines')).toHaveCSS('font-size', '22.5px');
  const divider = page.getByRole('separator', { name: 'Resize editor groups', exact: true });
  const box = (await divider.boundingBox())!;
  const width = (await first.boundingBox())!.width;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await first.boundingBox())!.width).toBeCloseTo(width + 60, 0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('button', { name: 'Restore defaults', exact: true }).click();
  await settings(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(second.locator('.file-surface .view-lines')).toHaveCSS('font-size', '16px');
  await expect(first.locator('.file-surface .view-lines')).toHaveCSS('font-size', '16px');
});

test('settings selectors are custom controls with editable font fields and working suggestions', async ({ page }) => {
  await open(page);
  for (const name of ['Appearance', 'Editor Font', 'Component Themes', 'Syntax Colors', 'Schemes']) {
    await category(page, name);
    await expect(settings(page).locator('select, datalist')).toHaveCount(0);
  }
  await category(page, 'Appearance');
  const theme = settings(page).getByRole('combobox', { name: 'Theme preset', exact: true });
  await expect(theme).toHaveJSProperty('tagName', 'BUTTON');
  await expect(theme).toContainText('Reference');
  await choose(page, 'UI font suggestions', 'Arial, sans-serif');
  await expect(settings(page).getByRole('textbox', { name: 'UI font family', exact: true })).toHaveValue('Arial, sans-serif');
  await category(page, 'Editor Font');
  await choose(page, 'Editor font suggestions', 'Menlo, monospace');
  const family = settings(page).getByRole('textbox', { name: 'Editor font family', exact: true });
  await expect(family).toHaveValue('Menlo, monospace');
  await expect.poll(async () => (await font(page))?.family).toBe('Menlo, monospace');
  await family.fill('Consolas, monospace');
  await expect.poll(async () => (await font(page))?.family).toBe('Consolas, monospace');
});

test('dropdown keyboard navigation supports arrows, Home, End and typeahead within Settings', async ({ page }) => {
  await open(page);
  const theme = settings(page).getByRole('combobox', { name: 'Theme preset', exact: true });
  await theme.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(theme).toContainText('Darcula');
  await expect(theme).toBeFocused();

  await theme.click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(theme).toContainText('Reference');

  await theme.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(theme).toContainText('High Contrast');

  await theme.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(theme).toContainText('Reference'); // Home skips disabled Custom.

  await theme.click();
  await page.keyboard.type('li');
  await page.keyboard.press('Enter');
  await expect(theme).toContainText('Light');
  await expect(settings(page)).toBeVisible();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.locator('.file-surface .monaco-editor')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  // Home/End should also work directly from a closed control.
  await theme.press('End');
  await page.keyboard.press('Enter');
  await expect(theme).toContainText('High Contrast');
  await theme.press('Home');
  await page.keyboard.press('Enter');
  await expect(theme).toContainText('Reference');
});

test('selected and disabled dropdown values remain distinct and cannot activate disabled Custom', async ({ page }) => {
  await open(page);
  const theme = settings(page).getByRole('combobox', { name: 'Theme preset', exact: true });
  await theme.click();
  await expect(page.getByRole('option', { name: 'Reference', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('option', { selected: true })).toHaveCount(1);
  const custom = page.getByRole('option', { name: 'Custom', exact: true });
  await expect(custom).toBeDisabled();
  const bounds = (await custom.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(theme).toContainText('Reference');
  await page.keyboard.press('Escape');

  await settings(page).getByRole('spinbutton', { name: 'UI font size', exact: true }).fill('14');
  await expect(theme).toContainText('Custom');
  await theme.click();
  await expect(custom).toHaveAttribute('aria-selected', 'true');
  await expect(custom).toBeDisabled();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(theme).toContainText('Reference');
});

test('Escape, Tab and outside clicks dismiss only the dropdown and preserve modal focus', async ({ page }) => {
  await open(page);
  const theme = settings(page).getByRole('combobox', { name: 'Theme preset', exact: true });
  await theme.click();
  await expect(theme).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(theme).toHaveAttribute('aria-expanded', 'false');
  await expect(theme).toBeFocused();
  await expect(settings(page)).toBeVisible();

  await theme.click();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(settings(page).getByRole('textbox', { name: 'UI font family', exact: true })).toBeFocused();
  await expect(settings(page)).toBeVisible();

  await theme.click();
  await settings(page).getByRole('heading', { name: 'Appearance', exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(theme).toHaveAttribute('aria-expanded', 'false');
  await expect(theme).toContainText('Reference');
  await expect(settings(page)).toBeVisible();
});

test('dropdown popups fit narrow viewports at 150 percent UI scale and remain clickable above the modal', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 640 });
  await open(page);
  await settings(page).getByRole('spinbutton', { name: 'UI scale', exact: true }).fill('150');
  const checkPopup = async () => {
    const panel = page.getByRole('listbox');
    await expect(panel).toBeVisible();
    const bounds = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + .5);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + .5);
    const option = panel.getByRole('option').filter({ hasText: 'Arial, sans-serif' });
    await expect(option).toBeInViewport();
    await option.click();
    await expect(settings(page).getByRole('textbox', { name: 'UI font family', exact: true })).toHaveValue('Arial, sans-serif');
  };
  await settings(page).getByRole('combobox', { name: 'UI font suggestions', exact: true }).click();
  await checkPopup();
  await page.setViewportSize({ width: 950, height: 640 });
  await settings(page).getByRole('combobox', { name: 'UI font suggestions', exact: true }).click();
  await checkPopup();
  await expect(settings(page).getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
});
