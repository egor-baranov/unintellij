import { expect, test, type Page } from '@playwright/test';

const path = 'docs/preview.md';
const surface = (page: Page) => page.locator('.markdown-surface:visible');
const preview = (page: Page) => surface(page).locator('.markdown-preview');
const modeButton = (page: Page, name: 'Code' | 'Split' | 'Preview') => surface(page).getByRole('toolbar', { name: 'Markdown view', exact: true }).getByRole('button', { name, exact: true });
const tab = (page: Page, file: string) => page.getByRole('tab', { name: file, exact: true });
const dirty = (page: Page) => tab(page, path).getByRole('img', { name: 'Unsaved changes', exact: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('smart-diff:file-saving:v1', JSON.stringify({ autoSave: false })));
});

async function open(page: Page) {
  await page.goto(`/?view=project&path=${encodeURIComponent(path)}`);
  await expect(surface(page)).toHaveAttribute('data-mode', 'split');
  await expect(preview(page).getByRole('heading', { name: 'Project guide', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.projectPreview.editor?.getModel()?.getValue().startsWith('# Project guide'))).toBe(true);
}

test('Markdown opens as source and rich preview, and all three view modes retain the editor', async ({ page }) => {
  await open(page);
  const modelId = await page.evaluate(() => window.projectPreview.editor!.getModel()!.id);
  await expect(preview(page).locator('strong')).toHaveText('Markdown');
  await expect(preview(page).getByRole('table')).toBeVisible();
  await expect(preview(page).locator('pre code')).toContainText('interface Project');
  await expect.poll(() => preview(page).locator('pre code span[class^="mtk"]').count()).toBeGreaterThan(2);
  await expect(preview(page).getByRole('checkbox')).toHaveCount(3);
  await expect(preview(page).getByRole('checkbox').first()).toBeChecked();
  await expect(preview(page).getByRole('checkbox').first()).toBeDisabled();
  const fullWidth = (await surface(page).boundingBox())!.width;
  const splitWidth = (await surface(page).getByTestId('file-surface').boundingBox())!.width;
  expect(splitWidth).toBeGreaterThan(fullWidth * .4);
  expect(splitWidth).toBeLessThan(fullWidth * .6);

  await modeButton(page, 'Preview').click();
  await expect(surface(page)).toHaveAttribute('data-mode', 'preview');
  await expect(surface(page).getByTestId('file-surface')).toBeHidden();
  await expect(modeButton(page, 'Preview')).toHaveAttribute('aria-pressed', 'true');
  expect((await preview(page).boundingBox())!.width).toBeGreaterThan(fullWidth * .95);

  await modeButton(page, 'Code').click();
  await expect(surface(page)).toHaveAttribute('data-mode', 'code');
  await expect(preview(page)).toBeHidden();
  expect((await surface(page).getByTestId('file-surface').boundingBox())!.width).toBeGreaterThan(fullWidth * .95);
  await modeButton(page, 'Split').click();
  await expect(preview(page)).toBeVisible();
  expect(await page.evaluate(() => window.projectPreview.editor!.getModel()!.id)).toBe(modelId);
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
});

test('edits render live and undo survives switching modes; preview can save the shared draft', async ({ page }) => {
  await open(page);
  const original = await page.evaluate(() => window.projectPreview.editor!.getValue());
  await page.evaluate(() => {
    const editor = window.projectPreview.editor!;
    editor.setPosition({ lineNumber: 1, column: 3 }); editor.pushUndoStop(); editor.focus();
  });
  await page.keyboard.type('Revised ');
  await expect(preview(page).getByRole('heading', { name: 'Revised Project guide', exact: true })).toBeVisible();
  await expect(dirty(page)).toBeVisible();
  await modeButton(page, 'Preview').click();
  await expect(preview(page).getByRole('heading', { name: 'Revised Project guide', exact: true })).toBeVisible();
  await modeButton(page, 'Code').click();
  await page.evaluate(() => window.projectPreview.editor!.focus());
  let undoSteps = 0;
  while (await page.evaluate(() => window.projectPreview.editor!.getValue()) !== original && undoSteps < 8) {
    await page.keyboard.press('ControlOrMeta+z'); undoSteps++;
  }
  expect(await page.evaluate(() => window.projectPreview.editor!.getValue())).toBe(original);
  await expect(dirty(page)).toHaveCount(0);
  for (let i = 0; i < undoSteps; i++) await page.keyboard.press('ControlOrMeta+Shift+z');
  await modeButton(page, 'Preview').click();
  await expect(preview(page).getByRole('heading', { name: 'Revised Project guide', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(dirty(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.projectPreview.getState()?.content?.text.startsWith('# Revised Project guide'))).toBe(true);
  await page.getByRole('button', { name: `Close ${path}`, exact: true }).click();
  await page.evaluate(file => window.projectPreview.selectFile(file), path);
  await expect(preview(page).getByRole('heading', { name: 'Revised Project guide', exact: true })).toBeVisible();
});

test('view mode, preview scroll and split width survive switching tabs', async ({ page }) => {
  await open(page);
  const divider = surface(page).getByRole('separator', { name: 'Resize Markdown split', exact: true });
  await divider.focus(); await page.keyboard.press('Shift+ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '60');
  await modeButton(page, 'Preview').click();
  await preview(page).evaluate(element => { element.scrollTop = 320; element.dispatchEvent(new Event('scroll')); });
  const scrollTop = await preview(page).evaluate(element => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await page.evaluate(() => window.projectPreview.selectFile('docs/architecture.md'));
  await expect(preview(page).getByRole('heading', { name: 'Architecture', exact: true })).toBeVisible();
  await expect(surface(page)).toHaveAttribute('data-mode', 'split');
  await tab(page, path).click();
  await expect(surface(page)).toHaveAttribute('data-mode', 'preview');
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(scrollTop);
  await modeButton(page, 'Split').click();
  await expect(divider).toHaveAttribute('aria-valuenow', '60');
  await divider.focus(); await page.keyboard.press('Enter');
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  await page.setViewportSize({ width: 1000, height: 680 });
  await expect.poll(() => page.evaluate(() => {
    const element = document.querySelector('.markdown-surface .file-surface')!;
    const editor = window.projectPreview.editor;
    return editor ? Math.abs(editor.getLayoutInfo().width - element.getBoundingClientRect().width) : Infinity;
  })).toBeLessThan(1);
  await expect(preview(page)).toBeVisible();
});

test('project images resolve locally, anchors scroll inside preview, and document links open a tab', async ({ page }) => {
  await open(page);
  const illustration = preview(page).getByRole('img', { name: 'Project illustration', exact: true });
  await expect(illustration).toHaveAttribute('src', /^(?:blob:|data:image\/svg\+xml)/);
  await illustration.scrollIntoViewIfNeeded();
  await expect.poll(() => illustration.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
  await preview(page).getByRole('link', { name: 'Jump to checklist', exact: true }).click();
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await expect(preview(page).getByRole('heading', { name: 'Release checklist', exact: true })).toBeInViewport();
  await preview(page).getByRole('link', { name: 'project guide', exact: true }).click();
  await expect(preview(page).getByRole('heading', { name: 'Project guide', exact: true })).toBeInViewport();
  await preview(page).getByRole('link', { name: 'Architecture', exact: true }).click();
  await expect(tab(page, 'docs/architecture.md')).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).getByRole('heading', { name: 'Architecture', exact: true })).toBeVisible();
});

test('split scrolling follows the document and can be made independent', async ({ page }) => {
  await open(page);
  const toggle = surface(page).getByRole('button', { name: 'Synchronize Markdown scrolling', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await preview(page).hover(); await page.mouse.wheel(0, 420);
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBeGreaterThan(200);
  await expect.poll(() => page.evaluate(() => window.projectPreview.editor!.getScrollTop())).toBeGreaterThan(0);
  await page.evaluate(() => { const editor = window.projectPreview.editor!; editor.focus(); editor.setScrollTop(0); });
  await expect.poll(() => page.evaluate(() => window.projectPreview.editor!.getScrollTop())).toBe(0);
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(0);
  await preview(page).hover(); await page.mouse.wheel(0, 420);
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBeGreaterThan(200);
  await expect.poll(() => page.evaluate(() => window.projectPreview.editor!.getScrollTop())).toBeGreaterThan(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const sourceScroll = await page.evaluate(() => window.projectPreview.editor!.getScrollTop());
  await preview(page).hover(); await page.mouse.wheel(0, -1000);
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.projectPreview.editor!.getScrollTop())).toBe(sourceScroll);
});

test('entering split mode and enabling sync immediately reconcile diverged scroll positions', async ({ page }) => {
  await open(page);
  await modeButton(page, 'Code').click();
  await page.evaluate(() => { const editor = window.projectPreview.editor!; editor.focus(); editor.setScrollTop(220); });
  await expect.poll(() => page.evaluate(() => window.projectPreview.editor!.getScrollTop())).toBeGreaterThan(100);
  await modeButton(page, 'Split').click();
  // No additional wheel or caret event should be needed to align the preview.
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  const toggle = surface(page).getByRole('button', { name: 'Synchronize Markdown scrolling', exact: true });
  await toggle.click();
  await preview(page).evaluate(element => { (element as HTMLElement).focus(); element.scrollTop = 0; });
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.projectPreview.editor!.getScrollTop())).toBeGreaterThan(100);
  await toggle.click();
  await expect.poll(() => page.evaluate(() => window.projectPreview.editor!.getScrollTop())).toBe(0);
});

test('restoring a preview waits for delayed local image dimensions before restoring its reading position', async ({ page }) => {
  await open(page);
  await modeButton(page, 'Preview').click();
  const image = preview(page).getByRole('img', { name: 'Project illustration', exact: true });
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
  await preview(page).evaluate(element => { (element as HTMLElement).focus(); element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
  const readingPosition = await preview(page).evaluate(element => element.scrollTop);
  expect(readingPosition).toBeGreaterThan(180);
  await page.evaluate(() => window.projectPreview.selectFile('docs/architecture.md'));
  await expect(preview(page).getByRole('heading', { name: 'Architecture', exact: true })).toBeVisible();
  await page.evaluate(() => window.projectPreview.markdownImages.hold());
  await tab(page, path).click();
  await expect(surface(page)).toHaveAttribute('data-mode', 'preview');
  await expect.poll(() => page.evaluate(() => window.projectPreview.markdownImages.pending())).toBe(1);
  await expect(image).not.toHaveAttribute('src');
  await page.evaluate(() => window.projectPreview.markdownImages.release());
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(320);
  await expect.poll(() => preview(page).evaluate(element => element.scrollTop)).toBe(readingPosition);
});

test('fenced code follows syntax theme changes without flattening its lines', async ({ page }) => {
  await open(page);
  const fence = preview(page).locator('pre code');
  const keyword = fence.locator('span[class^="mtk"]').filter({ hasText: /^interface$/ });
  await expect(keyword).toHaveCSS('color', 'rgb(192, 133, 255)');
  const before = await fence.innerText();
  const lineBreaks = await fence.locator('br').count();
  expect(lineBreaks).toBeGreaterThan(4);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Syntax Colors', exact: true }).click();
  await settings.getByRole('textbox', { name: 'Keywords color', exact: true }).fill('#be127e');
  await expect(keyword).toHaveCSS('color', 'rgb(190, 18, 126)');
  await expect(fence.locator('br')).toHaveCount(lineBreaks);
  expect(await fence.innerText()).toBe(before);
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(keyword).toHaveCSS('color', 'rgb(192, 133, 255)');
  await expect(fence.locator('br')).toHaveCount(lineBreaks);
  expect(await fence.innerText()).toBe(before);
});

test('preview content cannot execute raw HTML, script URLs or image event handlers', async ({ page }) => {
  await open(page);
  const dialogs: string[] = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.evaluate(() => window.projectPreview.editor!.setValue([
    '# Untrusted documentation',
    '<script>window.markdownInjected = true; alert("script")</script>',
    '<img src="bad" onerror="window.markdownInjected = true; alert(\'image\')">',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '[Unsafe link](javascript:alert%281%29)',
    '![Unsafe image](javascript:alert%282%29)',
    '<svg onload="window.markdownInjected = true"></svg>',
  ].join('\n\n')));
  await expect(preview(page).getByRole('heading', { name: 'Untrusted documentation', exact: true })).toBeVisible();
  await expect(preview(page).locator('script, iframe, [onerror], [onload], [onclick], a[href^="javascript:"], img[src^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { markdownInjected?: boolean }).markdownInjected)).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test('ordinary code and Markdown comparisons keep their existing editor presentation', async ({ page }) => {
  await page.goto('/?view=project&path=apps/shared/monaco.ts');
  await expect(page.getByTestId('file-surface')).toBeVisible();
  await expect(surface(page)).toHaveCount(0);
  await page.goto('/?view=commit&file=readme-staged');
  await expect.poll(() => page.evaluate(() => window.commitPreview.viewer?.getState().status)).toBe('ready');
  await expect(page.locator('.smart-diff')).toBeVisible();
  await expect(surface(page)).toHaveCount(0);
});
