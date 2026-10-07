/** Real Find in Files workflow in an isolated production Electron window. Build the app first. */
import { _electron as electron, expect as baseExpect, type Locator } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 15000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-find-in-files-'));
const repository = join(directory, 'repository');
const profile = join(directory, 'profile');
const artifacts = resolve('artifacts/find-in-files');
const query = 'Needle[1].*';
const sourcePath = 'src/unchanged café [1].ts';
const untrackedPath = 'src/nested/untracked note.ts';
const sourceLines = Array.from({ length: 90 }, (_, index) => `export const section${index + 1} = ${index + 1};`);
sourceLines[40] = 'export const café = "🧭 Needle[1].* needle[1].*";';
sourceLines[49] = 'export const previousSearch = "rapid-old";';
sourceLines[51] = 'export const currentSearch = "rapid-final";';
sourceLines[66] = 'export const fallback = "NEEDLE[1].*";';
const sourceContent = `${sourceLines.join('\r\n')}\r\n`;
const firstColumn = sourceLines[40].indexOf(query) + 1;
await Promise.all([
  mkdir(join(repository, 'src', 'nested'), { recursive: true }),
  mkdir(join(repository, 'other'), { recursive: true }),
  mkdir(profile, { recursive: true }),
  mkdir(artifacts, { recursive: true }),
]);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
await git('init', '-q', '-b', 'main');
await writeFile(join(repository, '.gitignore'), 'ignored/\n*.excluded\n');
await writeFile(join(repository, sourcePath), sourceContent);
await writeFile(join(repository, 'other', 'unchanged.ts'), `export const other = "${query}";\n`);
await git('add', '--', '.gitignore', sourcePath, 'other/unchanged.ts');
await git('-c', 'user.name=Find Smoke', '-c', 'user.email=find-smoke@example.invalid', 'commit', '-qm', 'Isolated search fixture');
await writeFile(join(repository, untrackedPath), `// Search includes untracked files.\n\nexport const nested = "${query}";\n`);
await writeFile(join(repository, '000-json-search-first.ts'), 'export const marker = "json-search";\n');
await writeFile(join(repository, 'z-colors.json'), '{"json-search-key": "json-search-value", "number": 42}\n');
await writeFile(join(repository, 'preview-stable.ts'), 'export const stable = "preview-failure";\n');
await writeFile(join(repository, 'preview-vanishing.ts'), 'export const temporary = "preview-failure";\n');
await writeFile(join(repository, 'binary.bin'), Buffer.from(`\u0000${query}\u0000`));
await writeFile(join(repository, 'ignored.excluded'), `${query}\n`);
await writeFile(join(repository, '.git', 'search-smoke-internals'), `${query}\n`);
for (const folder of ['ignored', 'node_modules', 'dist', 'release']) {
  await mkdir(join(repository, folder));
  await writeFile(join(repository, folder, 'hidden.ts'), `export const excluded = "${query}";\n`);
}
const executablePath = process.env.SMART_DIFF_PACKAGED_EXECUTABLE;
const application = await electron.launch({
  ...(executablePath ? { executablePath, args: [`--user-data-dir=${profile}`] }
    : { args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${profile}`] }),
  env: { ...process.env, SMART_DIFF_DEV_URL: '' },
});

try {
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, repository);
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const shortcut = `${mod}+Shift+f`;
  const dialog = page.getByRole('dialog', { name: 'Find in Files', exact: true });
  const input = dialog.getByRole('searchbox', { name: 'Search text', exact: true });
  const results = dialog.getByRole('listbox', { name: 'Search results', exact: true });
  const options = results.getByRole('option');
  const preview = dialog.locator('.find-preview-editor');
  const selected = () => results.locator('[role="option"][aria-selected="true"]');
  const result = (path: string, line: number) => results.getByRole('option', { name: new RegExp(`^${`${path}:${line} `.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
  const capture = async (name: string) => {
    await expect(preview).toHaveClass(/\bis-ready\b/);
    await expect(preview.locator('.view-lines')).toContainText(/needle\[1\]\.\*/i);
    await writeFile(join(artifacts, name), await captureWindow(application, page));
  };
  const waitForResults = async (count: number, occurrences: number, files: number) => {
    await expect(options).toHaveCount(count);
    await expect(dialog).toContainText(new RegExp(`${occurrences} match(?:es)? in ${files} files?`));
    await expect(dialog).not.toContainText('Searching…');
  };
  const expectSyntaxColors = async (row: Locator, previewHost: Locator) => {
    const keyword = row.locator('.find-snippet-token[data-token^="keyword"]').first();
    const string = row.locator('.find-snippet-token[data-token^="string"]').first();
    await expect(keyword).toBeVisible();
    await expect(string).toBeVisible();
    await expect(row.locator('.find-result-snippet')).toHaveText(sourceLines[40]);
    await expect(row.locator('mark')).toHaveText([query, query.toLowerCase()]);
    await expect(row).toHaveAttribute('aria-selected', 'true');
    const colors = await row.evaluate(node => {
      const keyword = node.querySelector<HTMLElement>('.find-snippet-token[data-token^="keyword"]')!;
      const string = node.querySelector<HTMLElement>('.find-snippet-token[data-token^="string"]')!;
      return { keyword: getComputedStyle(keyword).color, string: getComputedStyle(string).color, background: getComputedStyle(node).backgroundColor,
        marks: [...node.querySelectorAll('mark')].map(mark => ({
          color: getComputedStyle(mark).color, background: getComputedStyle(mark).backgroundColor,
          tokenCount: mark.querySelectorAll('.find-snippet-token').length,
        })) };
    });
    expect(colors.keyword).not.toBe(colors.string);
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors.marks).toHaveLength(2);
    for (const mark of colors.marks) {
      expect(mark.background).toBe('rgb(226, 182, 87)');
      expect(mark.color).toBe('rgb(37, 34, 27)');
      expect(mark.tokenCount).toBe(0);
      expect(mark.background).not.toBe(colors.background);
    }
    // Compare with the actual rendered Monaco preview using the same theme,
    // instead of treating colored classes or data attributes as verification.
    await expect.poll(() => previewHost.locator('.view-lines').evaluate(node => {
      const token = [...node.querySelectorAll('span')].find(span => !span.firstElementChild && /\bexport\b/.test(span.textContent ?? ''));
      return token ? getComputedStyle(token).color : undefined;
    }), { message: 'Search result keyword uses the existing Monaco theme color' }).toBe(colors.keyword);
  };
  const activateSource = async () => {
    const mode = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true });
    if (await mode.getAttribute('aria-pressed') !== 'true') await mode.click();
    const folder = page.getByRole('treeitem', { name: 'src', exact: true });
    if (await folder.getAttribute('aria-expanded') !== 'true') await folder.click();
    await page.getByRole('treeitem', { name: sourcePath, exact: true }).click();
    await expect(page.getByTestId('file-surface')).toHaveAttribute('data-path', sourcePath);
  };
  const expectNormalCursor = async (path: string, lineNumber: number, column: number) => {
    const tab = page.getByRole('tab', { name: path, exact: true });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('file-surface')).toHaveAttribute('data-path', path);
    // Read the existing user-visible session store, never a Monaco private API
    // or test-only production hook, to assert the exact UTF-16 cursor position.
    const instanceId = await tab.getAttribute('data-instance-id');
    await expect.poll(() => page.evaluate(async instance => {
      const repository = (await window.desktop.getLastRepository())!.repository;
      const session = await window.desktop.getWindowSessionId();
      const key = `smart-diff:editor-session:v1:${JSON.stringify([repository.path, session])}`;
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
      return instance ? saved.views?.[instance]?.file?.cursorState?.[0]?.position : undefined;
    }, instanceId), { message: `Open normal file at ${path}:${lineNumber}:${column}` }).toEqual({ lineNumber, column });
  };

  await activateSource();
  const editor = page.getByTestId('file-surface').locator('.monaco-editor');
  await editor.locator('.view-lines').click({ position: { x: 120, y: 12 } });
  await page.keyboard.press(`${mod}+f`);
  await expect(editor.locator('.find-widget')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press(shortcut);
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await expect(dialog).toContainText('Type to search');
  await expect(options).toHaveCount(0);

  await input.fill(query);
  await waitForResults(4, 5, 3);
  await expect(result(sourcePath, 41)).toHaveCount(1);
  await expect(result(sourcePath, 67)).toHaveCount(1);
  await expect(result(untrackedPath, 3)).toHaveCount(1);
  await expect(result('other/unchanged.ts', 1)).toHaveCount(1);
  await expect(results).not.toContainText(/hidden\.ts|binary\.bin|ignored\.excluded|search-smoke-internals/);
  await expect(result(sourcePath, 41).locator('mark')).toHaveCount(2);
  await capture('project-search.png');

  const divider = dialog.getByRole('separator', { name: 'Resize search results and preview', exact: true });
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  const handle = (await divider.boundingBox())!;
  const previewHeight = (await preview.boundingBox())!.height;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 65, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
  await expect.poll(async () => (await preview.boundingBox())!.height).toBeLessThan(previewHeight - 40);
  await divider.press('Enter');
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  await divider.press('ArrowUp');
  await expect(divider).toHaveAttribute('aria-valuenow', '48');
  await divider.press('Enter');
  await input.focus();

  // Result navigation never steals focus from the query, and streaming has a
  // stable selection rather than repeatedly returning to the first row.
  const initialSelection = await selected().getAttribute('aria-label');
  await input.press('ArrowDown');
  await expect(input).toBeFocused();
  await expect.poll(() => selected().getAttribute('aria-label')).not.toBe(initialSelection);
  await input.press('ArrowUp');
  await expect(input).toBeFocused();
  await expect(selected()).toHaveAttribute('aria-label', initialSelection!);
  await result(sourcePath, 41).click();
  await expect(dialog.locator('.find-preview-name')).toHaveText('unchanged café [1].ts');
  await expect(preview.locator('.view-lines')).toContainText('🧭');
  await expect(preview.locator('.view-lines')).toContainText('Needle[1].*');
  await expect(preview.locator('.line-numbers').filter({ hasText: /^41$/ })).toBeVisible();
  await expectSyntaxColors(result(sourcePath, 41), preview);
  // Existing cross-window settings notifications update row token colors and
  // font styles, and disabling syntax keeps literal yellow matches intact.
  const originalKeywordColor = await result(sourcePath, 41).locator('.find-snippet-token[data-token^="keyword"]').first().evaluate(node => getComputedStyle(node).color);
  const originalAppearance = await page.evaluate(() => localStorage.getItem('smart-diff:appearance:v1'));
  const customAppearance = {
    editor: { syntaxHighlight: true },
    colors: { syntax: { keyword: { foreground: '#12ABCD', bold: true, italic: true } } },
  };
  const updateAppearance = async (serialized: string | null) => page.evaluate(value => {
    const key = 'smart-diff:appearance:v1';
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
  }, serialized);
  try {
    await updateAppearance(JSON.stringify(customAppearance));
    const keyword = result(sourcePath, 41).locator('.find-snippet-token[data-token^="keyword"]').first();
    await expect(keyword).toHaveCSS('color', 'rgb(18, 171, 205)');
    await expect(keyword).toHaveCSS('font-weight', '700');
    await expect(keyword).toHaveCSS('font-style', 'italic');
    await expectSyntaxColors(result(sourcePath, 41), preview);
    await updateAppearance(JSON.stringify({ ...customAppearance, editor: { syntaxHighlight: false } }));
    await expect.poll(() => result(sourcePath, 41).locator('.find-snippet-token').evaluateAll(nodes =>
      new Set(nodes.filter(node => !node.closest('mark')).map(node => getComputedStyle(node).color)).size),
    { message: 'Disabling syntax highlighting removes varied token colors from result snippets' }).toBeLessThanOrEqual(1);
    await expect(result(sourcePath, 41).locator('mark')).toHaveText([query, query.toLowerCase()]);
    await expect(result(sourcePath, 41).locator('mark').first()).toHaveCSS('background-color', 'rgb(226, 182, 87)');
    await expect(result(sourcePath, 41)).toHaveAttribute('aria-selected', 'true');
    await waitForResults(4, 5, 3);
  } finally { await updateAppearance(originalAppearance); }
  await expect(result(sourcePath, 41).locator('.find-snippet-token[data-token^="keyword"]').first()).toHaveCSS('color', originalKeywordColor);
  await expectSyntaxColors(result(sourcePath, 41), preview);
  await capture('selected-preview.png');

  // Move and resize the real popup without replacing its query, selected
  // result, or preview model. These operations use native pointer routing.
  const movePopup = dialog.getByRole('button', { name: 'Move Find in Files', exact: true });
  const resizePopup = dialog.getByRole('button', { name: 'Resize Find in Files', exact: true });
  const northWest = dialog.locator('[data-resize-direction="nw"]');
  const bounds = async () => {
    const box = await dialog.boundingBox();
    if (!box) throw new Error('Find in Files has no visible bounds');
    return box;
  };
  const drag = async (target: Locator, dx: number, dy: number) => {
    const box = await target.boundingBox();
    if (!box) throw new Error('Find in Files drag handle has no bounds');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
  };
  const expectBounds = async (expected: Awaited<ReturnType<typeof bounds>>, label: string) => {
    await expect.poll(async () => {
      const actual = await bounds();
      return Math.max(...(['x', 'y', 'width', 'height'] as const).map(key => Math.abs(actual[key] - expected[key])));
    }, { message: label }).toBeLessThanOrEqual(1);
  };
  const centeredBounds = await bounds();
  const originalPreviewBounds = (await preview.boundingBox())!;
  await drag(movePopup, 32, 24);
  await expectBounds({ ...centeredBounds, x: centeredBounds.x + 32, y: centeredBounds.y + 24 }, 'Dragging the title moves the popup without resizing it');
  const movedBounds = await bounds();
  await drag(resizePopup, 40, 28);
  await expectBounds({ ...movedBounds, width: movedBounds.width + 40, height: movedBounds.height + 28 }, 'Bottom-right resize keeps the top-left corner fixed');
  const expandedBounds = await bounds();
  await drag(northWest, 24, 20);
  await expectBounds({ x: expandedBounds.x + 24, y: expandedBounds.y + 20, width: expandedBounds.width - 24, height: expandedBounds.height - 20 }, 'Top-left resize keeps the opposite corner fixed');
  await expect(input).toHaveValue(query);
  await expect(result(sourcePath, 41)).toHaveAttribute('aria-selected', 'true');
  await expect(preview).toHaveClass(/\bis-ready\b/);
  await expect(preview.locator('.view-lines')).toContainText('🧭');
  await expect.poll(async () => (await preview.boundingBox())!.width).toBeGreaterThan(originalPreviewBounds.width + 10);
  await expect.poll(() => preview.evaluate(node => {
    const editor = node.querySelector<HTMLElement>('.monaco-editor');
    return editor ? Math.abs(editor.getBoundingClientRect().width - node.getBoundingClientRect().width) : Infinity;
  }), { message: 'Monaco lays out to the resized preview surface' }).toBeLessThanOrEqual(1);
  await capture('moved-resized-search.png');
  const rememberedBounds = await bounds();
  await dialog.getByRole('button', { name: 'Close Find in Files', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Find in Files', exact: true }).click();
  await expectBounds(rememberedBounds, 'Closing and reopening remembers popup bounds within the application session');
  await expect(input).toHaveValue(query);
  await waitForResults(4, 5, 3);
  await result(sourcePath, 41).click();
  await expect(preview).toHaveClass(/\bis-ready\b/);

  // Captured pointers may leave the viewport, but the resulting rectangle must
  // stay reachable and never become smaller than the supported content size.
  await drag(movePopup, -2000, -2000);
  await expectBounds({ ...rememberedBounds, x: 10, y: 10 }, 'Extreme title drag clamps the popup within the viewport');
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await drag(resizePopup, 2000, 2000);
  await expectBounds({ x: 10, y: 10, width: viewport.width - 20, height: viewport.height - 20 }, 'Extreme bottom-right resize respects all viewport insets');
  await drag(northWest, 2000, 2000);
  await expectBounds({ x: viewport.width - 570, y: viewport.height - 370, width: 560, height: 360 }, 'Top-left resize enforces the minimum size while preserving bottom-right');
  await movePopup.dblclick();
  await expectBounds(centeredBounds, 'Double-clicking the title restores the centered default bounds');
  await movePopup.press('ArrowLeft');
  await movePopup.press('Shift+ArrowUp');
  await expectBounds({ ...centeredBounds, x: centeredBounds.x - 10, y: centeredBounds.y - 40 }, 'Keyboard popup movement uses ten-pixel and shifted forty-pixel steps');
  await resizePopup.press('ArrowRight');
  await resizePopup.press('Shift+ArrowDown');
  await expectBounds({ x: centeredBounds.x - 10, y: centeredBounds.y - 40, width: centeredBounds.width + 10, height: centeredBounds.height + 40 }, 'Keyboard popup resizing preserves the top-left corner');
  await movePopup.dblclick();
  await expectBounds(centeredBounds, 'Popup reset restores the original geometry before further search checks');
  await expect(input).toHaveValue(query);
  await expect(result(sourcePath, 41)).toHaveAttribute('aria-selected', 'true');
  await expect(preview).toHaveClass(/\bis-ready\b/);
  await expect(preview.locator('.view-lines')).toContainText('🧭');

  // Enter belongs to the focused preview. It must neither open a result nor
  // change this read-only model; ordinary Find remains an editor command.
  await preview.locator('.monaco-editor').click({ position: { x: 100, y: 25 } });
  const beforePreview = await preview.locator('.view-lines').textContent();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  expect(await preview.locator('.view-lines').textContent()).toBe(beforePreview);
  await page.keyboard.press(`${mod}+f`);
  await expect(preview.locator('.find-widget')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await input.focus();
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expectNormalCursor(sourcePath, 41, firstColumn);
  await expect(editor.locator('.view-lines')).toContainText('🧭');
  expect(await readFile(join(repository, sourcePath), 'utf8')).toBe(sourceContent);

  await page.keyboard.press(shortcut);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(query);
  expect(await input.evaluate(node => {
    const element = node as HTMLInputElement;
    return [element.selectionStart, element.selectionEnd];
  })).toEqual([0, query.length]);
  await waitForResults(4, 5, 3);
  await dialog.getByRole('radio', { name: 'Directory', exact: true }).click();
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, join(repository, 'src'));
  await dialog.getByRole('button', { name: 'Choose search directory', exact: true }).click();
  await waitForResults(3, 4, 2);
  await expect(result('unchanged café [1].ts', 41)).toHaveCount(1);
  await expect(result('nested/untracked note.ts', 3)).toHaveCount(1);
  await expect(results).not.toContainText('other/unchanged.ts');
  await capture('directory-search.png');

  await input.fill('no-such-token-in-this-project');
  await expect(options).toHaveCount(0);
  await expect(dialog).toContainText(/No (matches|results)/i);
  await input.fill('');
  await expect(dialog).toContainText('Type to search');
  await expect(options).toHaveCount(0);
  await input.fill('🧭');
  await waitForResults(1, 1, 1);
  await expect(result('unchanged café [1].ts', 41)).toHaveCount(1);

  // JSON rows must tokenize correctly before selecting or previewing that
  // file, including differently themed keys and values outside yellow marks.
  await dialog.getByRole('radio', { name: 'Project', exact: true }).click();
  await input.fill('json-search');
  await waitForResults(2, 3, 2);
  await expect(dialog.locator('.find-preview-name')).toHaveText('000-json-search-first.ts');
  const jsonRow = result('z-colors.json', 1);
  await expect(jsonRow).toHaveAttribute('aria-selected', 'false');
  await expect(jsonRow.locator('mark')).toHaveText(['json-search', 'json-search']);
  const jsonKey = jsonRow.locator('.find-snippet-token[data-token="string.key.json"]').first();
  const jsonValue = jsonRow.locator('.find-snippet-token[data-token="string.value.json"]').first();
  await expect(jsonKey).toBeVisible();
  await expect(jsonValue).toBeVisible();
  expect(await jsonKey.evaluate(node => getComputedStyle(node).color)).not.toBe(await jsonValue.evaluate(node => getComputedStyle(node).color));
  await expect(jsonRow.locator('.find-result-snippet')).toHaveText('{"json-search-key": "json-search-value", "number": 42}');
  await writeFile(join(artifacts, 'json-result-syntax.png'), await captureWindow(application, page));
  await dialog.getByRole('radio', { name: 'Directory', exact: true }).click();

  // Change queries and scope while the 200 ms debounce and backend reads can
  // overlap. Once the new result arrives, no older snippet may reappear.
  await input.fill('rapid-old');
  await page.waitForTimeout(220);
  await input.fill('rapid-');
  await dialog.getByRole('radio', { name: 'Project', exact: true }).click();
  await input.fill('rapid-final');
  await waitForResults(1, 1, 1);
  await expect(results).toContainText('currentSearch');
  await expect(results).not.toContainText('previousSearch');
  await expect(preview.locator('.view-lines')).toContainText('currentSearch');
  await page.waitForTimeout(350);
  await expect(options).toHaveCount(1);
  await expect(results).not.toContainText('previousSearch');

  // Quick preview changes end on the last real file, not on a late response.
  await input.fill(query);
  await waitForResults(4, 5, 3);
  await result(sourcePath, 41).click();
  await result('other/unchanged.ts', 1).click();
  await result(untrackedPath, 3).click();
  await expect(dialog.locator('.find-preview-name')).toHaveText('untracked note.ts');
  await expect(preview.locator('.view-lines')).toContainText('nested');
  await expect(preview.locator('.view-lines')).not.toContainText('export const other');
  await result(untrackedPath, 3).dblclick();
  await expect(dialog).toHaveCount(0);
  await expectNormalCursor(untrackedPath, 3, `export const nested = "`.length + 1);

  // A file disappearing between the search and preview remains a compact
  // recoverable state, without opening a broken normal file or throwing.
  await page.keyboard.press(shortcut);
  await input.fill('preview-failure');
  await waitForResults(2, 2, 2);
  await result('preview-stable.ts', 1).click();
  await expect(preview.locator('.view-lines')).toContainText('stable');
  await rm(join(repository, 'preview-vanishing.ts'));
  await result('preview-vanishing.ts', 1).click();
  await expect(dialog).toContainText(/unavailable|removed|not found|no longer|could not|cannot|missing/i);
  await expect(dialog).toBeVisible();
  // Keeping the same source line count is not enough: a replaced occurrence
  // must not paint or reveal the old column as though it still matched.
  await writeFile(join(repository, 'preview-stable.ts'), 'export const stable = "this text changed after the search";\n');
  await result('preview-stable.ts', 1).click();
  await expect(dialog).toContainText('This match is no longer in the file.');
  await expect(preview).not.toHaveClass(/\bis-ready\b/);
  await input.fill(query);
  await waitForResults(4, 5, 3);
  await result(sourcePath, 67).click();
  await expect(preview.locator('.view-lines')).toContainText('fallback');

  // Repeated close/open cycles check focus restoration, session query, one
  // dialog and one preview model host rather than accumulated editor widgets.
  for (let iteration = 0; iteration < 3; iteration++) {
    await input.focus();
    await input.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.find-preview-editor')).toHaveCount(0);
    await page.keyboard.press(shortcut);
    await expect(dialog).toHaveCount(1);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(query);
    await waitForResults(4, 5, 3);
    await expect(preview.locator('.monaco-editor')).toHaveCount(1);
  }
  await input.fill('rapid-old');
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.locator('.find-preview-editor')).toHaveCount(0);
  await page.getByRole('button', { name: 'Find in Files', exact: true }).click();
  await expect(input).toHaveValue('rapid-old');
  await waitForResults(1, 1, 1);
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Find in Files', exact: true })).toBeFocused();

  // Closing the last editor presents the actual project search in the empty
  // workspace, with no unused Editor tabbar or placeholder above it.
  await page.getByRole('tab').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close All Tabs', exact: true }).click();
  const workspace = page.locator('.editor-workspace');
  const inline = workspace.locator('.find-in-files-view');
  const inlineInput = inline.getByRole('searchbox', { name: 'Search text', exact: true });
  const inlineResults = inline.getByRole('listbox', { name: 'Search results', exact: true });
  const inlinePreview = inline.locator('.find-preview-editor');
  const inlineResult = (path: string, line: number) => inlineResults.getByRole('option', { name: new RegExp(`^${`${path}:${line} `.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(workspace.locator('.workspace-tabbar')).toHaveCount(0);
  await expect(workspace.getByText('Editor', { exact: true })).toHaveCount(0);
  await expect(workspace.locator('.workspace-empty')).toHaveCount(0);
  await expect(inline).toBeVisible();
  await expect(inlineInput).not.toBeFocused();
  await expect(inlineInput).toHaveValue('rapid-old');
  await inlineInput.fill('');
  await expect(inline).toContainText('Type to search');
  await expect(inlineResults.getByRole('option')).toHaveCount(0);
  await writeFile(join(artifacts, 'empty-workspace-search.png'), await captureWindow(application, page));

  await inlineInput.fill(query);
  await expect(inlineResults.getByRole('option')).toHaveCount(4);
  await expect(inline).toContainText('5 matches in 3 files');
  await inlineResult(sourcePath, 41).click();
  await expect(inline.locator('.find-preview-name')).toHaveText('unchanged café [1].ts');
  await expect(inlinePreview).toHaveClass(/\bis-ready\b/);
  await expect(inlinePreview.locator('.view-lines')).toContainText('🧭');
  await expectSyntaxColors(inlineResult(sourcePath, 41), inlinePreview);
  await writeFile(join(artifacts, 'empty-workspace-results.png'), await captureWindow(application, page));
  await inlineInput.focus();
  await inlineInput.press('Enter');
  await expect(inline).toHaveCount(0);
  await expectNormalCursor(sourcePath, 41, firstColumn);
  await expect(workspace.locator('.workspace-tabbar')).toHaveCount(1);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: `Close ${sourcePath}`, exact: true }).click();
  await expect(inline).toBeVisible();
  await expect(inlineInput).toHaveValue(query);
  await expect(workspace.locator('.workspace-tabbar')).toHaveCount(0);
  await expect(inlineResults.getByRole('option')).toHaveCount(4);
  await expect(inlinePreview).toHaveClass(/\bis-ready\b/);

  // The modal temporarily owns the one per-window backend search. Closing it
  // resumes the embedded search with the shared query, without stale results
  // from either surface winning the other's request or focus.
  await page.getByRole('button', { name: 'Find in Files', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue(query);
  await expect(inline).toHaveAttribute('inert', '');
  await waitForResults(4, 5, 3);
  await input.fill('rapid-final');
  await waitForResults(1, 1, 1);
  await expect(results).toContainText('currentSearch');
  await expect(preview).toHaveClass(/\bis-ready\b/);
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(inline).not.toHaveAttribute('inert');
  await expect(inlineInput).toHaveValue('rapid-final');
  await expect(inlineResults.getByRole('option')).toHaveCount(1);
  await expect(inline).toContainText('1 match in 1 file');
  await expect(inlineResults).toContainText('currentSearch');
  await expect(inlineResults).not.toContainText('previousSearch');
  await expect(inlinePreview).toHaveClass(/\bis-ready\b/);
  await expect(inlinePreview.locator('.view-lines')).toContainText('currentSearch');
  await expect(workspace.locator('.workspace-tabbar')).toHaveCount(0);

  expect((await git('diff', '--', sourcePath, 'other/unchanged.ts')).stdout).toBe('');
  expect(errors).toEqual([]);
  console.log('PASS: production Find in Files, project/directory scopes, unchanged/untracked/ignored/binary files, occurrence counts, literal punctuation, Unicode/CRLF coordinates, keyword/string/JSON syntax colors and live theme updates, keyboard navigation, normal-file open, cancellation/stale previews, removed-file recovery, repeated close/reopen, popup drag/resize/clamping/geometry persistence/reset, embedded empty-workspace search, and modal/embedded query handoff.');
  console.log(`Screenshots: ${artifacts}/project-search.png, directory-search.png, selected-preview.png, moved-resized-search.png, empty-workspace-search.png, empty-workspace-results.png`);
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
