import { expect, test, type Page } from '@playwright/test';

const initialPath = 'apps/playground/src/ReviewPreferencesPanel.tsx';
const unchangedPath = 'apps/playground/src/components/RepositoryWelcome.tsx';
const projectTree = (page: Page) => page.getByRole('tree', { name: 'Project files', exact: true });
const row = (page: Page, path: string) => projectTree(page).getByRole('treeitem', { name: path, exact: true });
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function ready(page: Page, path = initialPath) {
  await expect.poll(() => page.evaluate(expected => {
    const preview = window.projectPreview;
    return preview?.getState()?.path === expected && preview.getState()?.state === 'text' && preview.editor?.getModel()?.getValue() === preview.getState()?.content?.text;
  }, path)).toBe(true);
  await settle(page);
}
async function open(page: Page) { await page.goto('/?view=project'); await expect(projectTree(page)).toBeVisible(); await ready(page); }
async function mode(page: Page, name: 'Project' | 'Commit') {
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]view=${name.toLowerCase()}`));
  await expect.poll(() => page.evaluate(() => window.projectPreview.getMode())).toBe(name.toLowerCase());
}

test('project preview lazily opens nested unchanged files with syntax and editable interactions', async ({ page }) => {
  await open(page);
  await expect(page.getByText('Preview', { exact: true })).toBeVisible();
  await expect(row(page, '.github')).toBeVisible();
  const requests = await page.evaluate(() => window.projectPreview.getRequestedDirectories());
  expect(requests).not.toContain('packages/monaco-smart-diff/src');
  // One level of visible folders is warmed, but collapsed descendants are not scanned.
  await expect(row(page, unchangedPath)).toHaveCount(0);
  await row(page, 'apps/playground/src/components').click();
  await expect(row(page, unchangedPath)).toBeVisible();
  await row(page, unchangedPath).click();
  await ready(page, unchangedPath);
  await expect(row(page, unchangedPath)).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => window.projectPreview.getRequestedDirectories())).toContain('apps/playground/src/components');
  const values = await page.evaluate(() => {
    const { editor, monaco } = window.projectPreview;
    return { text: editor!.getModel()!.getValue(), readOnly: editor!.getOption(monaco.editor.EditorOption.readOnly), language: editor!.getModel()!.getLanguageId() };
  });
  expect(values.readOnly).toBe(false); expect(values.language).toBe('smart-diff-tsx');
  expect(values.text).toContain('export function RepositoryWelcome');
  await expect(page.getByTestId('file-surface').locator('.view-line span[class^="mtk"]').first()).toBeVisible();
  await page.evaluate(() => { window.projectPreview.editor!.focus(); window.projectPreview.editor!.setPosition({ lineNumber: 1, column: 1 }); });
  await page.keyboard.type('// Local draft ');
  await expect.poll(() => page.evaluate(() => window.projectPreview.editor!.getModel()!.getValue())).toBe(`// Local draft ${values.text}`);
  await expect(page.getByRole('tab', { name: unchangedPath, exact: true }).getByRole('img', { name: 'Unsaved changes', exact: true })).toBeVisible();
  await expect(page.locator('.smart-diff')).toHaveCount(0);
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/project-nested-file.png' });
});

test('project folder arrows and Enter work from the keyboard', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Collapse project folders', exact: true }).click();
  const root = projectTree(page).getByRole('treeitem', { name: 'unintellij-example', exact: true });
  await root.focus();
  await expect(root).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(root).toHaveAttribute('aria-expanded', 'true');
  await row(page, 'apps').focus();
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'apps')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'apps/desktop')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, 'apps')).toBeFocused();
  await page.keyboard.press('Home'); await expect(root).toBeFocused();
  await page.keyboard.press('End'); await expect(projectTree(page).getByRole('treeitem').last()).toBeFocused();
  await row(page, 'README.md').focus(); await page.keyboard.press('Enter');
  await ready(page, 'README.md');
  await expect(row(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => window.projectPreview.editor!.getModel()!.getValue())).toContain('# Smart Diff');
  expect(await page.evaluate(() => window.projectPreview.editor!.getModel()!.getLanguageId())).toBe('markdown');
  await row(page, '.github').click(); await row(page, '.github/workflows').click();
  await row(page, '.github/workflows/checks.yml').click(); await ready(page, '.github/workflows/checks.yml');
  expect(await page.evaluate(() => window.projectPreview.editor!.getModel()!.getLanguageId())).toBe('yaml');
});

test('Project and Commit keep their selected files, editor positions and diff navigation across mode switches', async ({ page }) => {
  await open(page);
  const projectPosition = await page.evaluate(() => {
    const editor = window.projectPreview.editor!;
    editor.setPosition({ lineNumber: 60, column: 4 }); editor.setScrollTop(300);
    return { position: editor.getPosition(), scroll: editor.getScrollTop() };
  });
  await mode(page, 'Commit');
  await expect.poll(() => page.evaluate(() => window.commitPreview.viewer?.getState().status)).toBe('ready');
  await page.evaluate(() => window.commitPreview.selectFile('playground-main'));
  await expect.poll(() => page.evaluate(() => window.commitPreview.getSelected())).toBe('playground-main');
  await expect.poll(() => page.evaluate(() => window.commitPreview.viewer?.getState().status)).toBe('ready');
  await page.getByRole('button', { name: 'Next change', exact: true }).click();
  const currentChange = await page.evaluate(() => window.commitPreview.getState().currentChange);
  await mode(page, 'Project'); await ready(page);
  expect(await page.evaluate(() => window.projectPreview.getSelected())).toBe(initialPath);
  expect(await page.evaluate(() => window.projectPreview.editor!.getPosition())).toEqual(projectPosition.position);
  expect(Math.abs(await page.evaluate(() => window.projectPreview.editor!.getScrollTop()) - projectPosition.scroll)).toBeLessThan(2);
  await mode(page, 'Commit');
  await expect.poll(() => page.evaluate(() => window.commitPreview.viewer?.getState().status)).toBe('ready');
  expect(await page.evaluate(() => window.commitPreview.getSelected())).toBe('playground-main');
  expect(await page.evaluate(() => window.commitPreview.getState().currentChange)).toBe(currentChange);
  await expect(page.locator('.smart-diff')).toHaveCount(1);
  await expect(page.locator('.monaco-editor')).toHaveCount(2);
  await page.goBack(); await expect.poll(() => page.evaluate(() => window.projectPreview.getMode())).toBe('project'); await ready(page);
  await page.goForward(); await expect.poll(() => page.evaluate(() => window.projectPreview.getMode())).toBe('commit');
});

test('binary files, symlinks and submodules show explicit states and recover to text', async ({ page }) => {
  await open(page);
  await row(page, 'linked-settings').click();
  await expect(page.getByRole('heading', { name: 'Symbolic link', exact: true })).toBeVisible();
  await expect(page.getByTestId('file-surface')).toHaveCount(0);
  await row(page, 'artifacts').click(); await row(page, 'artifacts/sample.bin').click();
  await expect(page.getByRole('heading', { name: 'Binary file', exact: true })).toBeVisible();
  await row(page, 'vendor').click(); await row(page, 'vendor/editor-tools').click();
  await expect(page.getByRole('heading', { name: 'Submodule', exact: true })).toBeVisible();
  await row(page, 'README.md').click(); await ready(page, 'README.md');
  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  await page.evaluate(() => { window.projectPreview.selectFile('artifacts/sample.bin'); window.projectPreview.selectFile('linked-settings'); window.projectPreview.selectFile('apps/shared/monaco.ts'); });
  await ready(page, 'apps/shared/monaco.ts');
  expect(await page.evaluate(() => window.projectPreview.editor!.getModel()!.getValue())).toContain('configureHost');
});

test('project resizing and wrapping keep editor geometry current and refresh retains selection', async ({ page }) => {
  await open(page);
  const separator = page.getByRole('separator', { name: 'Resize project panel', exact: true });
  const initial = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus(); await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(initial + 20));
  const handle = (await separator.boundingBox())!;
  await page.mouse.move(handle.x + 2, handle.y + 80); await page.mouse.down();
  await page.mouse.move(handle.x + 65, handle.y + 80, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(initial + 60);
  await page.evaluate(() => window.projectPreview.editor!.focus());
  await page.keyboard.press('Alt+z');
  await expect.poll(() => page.evaluate(() => window.projectPreview.editor!.getOption(window.projectPreview.monaco.editor.EditorOption.wordWrap))).toBe('on');
  await page.setViewportSize({ width: 1050, height: 740 });
  await expect.poll(() => page.evaluate(() => Math.abs(window.projectPreview.editor!.getLayoutInfo().width - document.querySelector('[data-testid="file-surface"]')!.getBoundingClientRect().width))).toBeLessThan(1);
  await page.getByRole('button', { name: 'Refresh project', exact: true }).click(); await ready(page);
  expect(await page.evaluate(() => window.projectPreview.getSelected())).toBe(initialPath);
  await expect(row(page, initialPath)).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: 'test-results/project-narrow.png' });
});

const coldFolder = 'packages/monaco-smart-diff/src';
const coldChild = `${coldFolder}/index.ts`;
async function heldColdFolder(page: Page) {
  await page.evaluate(path => window.projectPreview.directoryReads.hold(path), coldFolder);
  await row(page, 'packages').click();
  await row(page, 'packages/monaco-smart-diff').click();
  await row(page, coldFolder).click();
  await expect.poll(() => page.evaluate(path => window.projectPreview.directoryReads.pending().filter(read => read.path === path).length, coldFolder)).toBe(1);
  return page.evaluate(path => window.projectPreview.directoryReads.pending().find(read => read.path === path)!.id, coldFolder);
}
async function warmedComponents(page: Page) {
  const folder = 'apps/playground/src/components';
  await row(page, folder).scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(path => window.projectPreview.directoryReads.completed().includes(path), folder)).toBe(true);
  await settle(page);
  return folder;
}

test('visible directory contents are warm before expansion and render without a loading frame', async ({ page }) => {
  await open(page);
  const folder = await warmedComponents(page);
  await expect(row(page, unchangedPath)).toHaveCount(0);
  const before = await page.evaluate(path => window.projectPreview.getRequestedDirectories().filter(value => value === path).length, folder);
  const immediate = await row(page, folder).evaluate(async element => {
    (element as HTMLElement).click();
    // Flush the discrete React click, without a timer, frame or directory read.
    await Promise.resolve();
    const tree = element.closest('[role="tree"]')!;
    return { paths: [...tree.querySelectorAll('[role="treeitem"]')].map(row => row.getAttribute('data-path')), text: tree.textContent };
  });
  expect(immediate.paths).toContain(unchangedPath);
  expect(immediate.text).not.toContain('Loading');
  expect(await page.evaluate(path => window.projectPreview.getRequestedDirectories().filter(value => value === path).length, folder)).toBe(before);
  await page.screenshot({ path: 'test-results/project-immediate-expansion.png' });
});

test('cold directory reads do not show Loading or misrepresent pending contents as empty', async ({ page }) => {
  await open(page);
  await heldColdFolder(page);
  await expect(row(page, coldFolder)).toHaveAttribute('aria-expanded', 'true');
  await expect(projectTree(page)).toHaveAttribute('aria-busy', 'true');
  await expect(row(page, coldChild)).toHaveCount(0);
  await expect(projectTree(page).getByText(/Loading|Empty folder|No visible files/)).toHaveCount(0);
  await page.evaluate(path => window.projectPreview.directoryReads.resume(path), coldFolder);
  await expect(row(page, coldChild)).toBeVisible();
  await expect(projectTree(page)).toHaveAttribute('aria-busy', 'false');
});

test('refresh retains a collapsed listing and replaces it after expansion revalidation', async ({ page }) => {
  await open(page);
  const folder = await warmedComponents(page);
  const replacement = `${folder}/Fresh.tsx`;
  const initialRoots = await page.evaluate(() => window.projectPreview.directoryReads.completed().filter(path => path === '').length);
  await page.evaluate(({ folder, replacement }) => {
    const reads = window.projectPreview.directoryReads;
    reads.hold(folder);
    reads.setEntries(folder, [{ id: `preview:${replacement}`, path: replacement, name: 'Fresh.tsx', kind: 'file' }]);
    window.branchPreview.refresh();
  }, { folder, replacement });
  await expect.poll(() => page.evaluate(() => window.projectPreview.directoryReads.completed().filter(path => path === '').length)).toBeGreaterThan(initialRoots);
  await expect(row(page, folder)).toHaveAttribute('aria-expanded', 'false');
  const paths = await row(page, folder).evaluate(async element => {
    (element as HTMLElement).click(); await Promise.resolve();
    return [...element.closest('[role="tree"]')!.querySelectorAll('[role="treeitem"]')].map(row => row.getAttribute('data-path'));
  });
  expect(paths).toContain(unchangedPath);
  await expect(projectTree(page).getByText(/Loading/)).toHaveCount(0);
  await expect.poll(() => page.evaluate(path => window.projectPreview.directoryReads.pending().some(read => read.path === path), folder)).toBe(true);
  await page.evaluate(path => window.projectPreview.directoryReads.resume(path), folder);
  await expect(row(page, replacement)).toBeVisible();
  await expect(row(page, unchangedPath)).toHaveCount(0);
  await expect(row(page, folder)).toHaveAttribute('aria-expanded', 'true');
});

test('removing a directory discards hidden cached descendants before the path reappears', async ({ page }) => {
  await open(page);
  const folder = await warmedComponents(page);
  const parent = 'apps/playground/src';
  await row(page, parent).click();
  await page.evaluate(path => {
    window.projectPreview.directoryReads.setEntries(path, []);
    window.branchPreview.refresh();
  }, parent);
  await row(page, parent).click();
  await expect(row(page, folder)).toHaveCount(0);
  const replacement = `${folder}/Recreated.tsx`;
  await page.evaluate(({ parent, folder, replacement }) => {
    const reads = window.projectPreview.directoryReads;
    reads.hold(folder);
    reads.setEntries(parent, [{ id: `preview:${folder}`, path: folder, name: 'components', kind: 'directory' }]);
    reads.setEntries(folder, [{ id: `preview:${replacement}`, path: replacement, name: 'Recreated.tsx', kind: 'file' }]);
    window.branchPreview.refresh();
  }, { parent, folder, replacement });
  await expect(row(page, folder)).toBeVisible();
  await row(page, folder).click();
  await expect(row(page, unchangedPath)).toHaveCount(0);
  await expect.poll(() => page.evaluate(path => window.projectPreview.directoryReads.pending().some(read => read.path === path), folder)).toBe(true);
  await page.evaluate(path => window.projectPreview.directoryReads.resume(path), folder);
  await expect(row(page, replacement)).toBeVisible();
  await expect(row(page, unchangedPath)).toHaveCount(0);
});

test('refresh restarts a cold expanded read and rejects its obsolete completion', async ({ page }) => {
  await open(page);
  const obsolete = await heldColdFolder(page);
  const replacement = `${coldFolder}/fresh.ts`;
  await page.evaluate(({ folder, replacement }) => {
    window.projectPreview.directoryReads.setEntries(folder, [{ id: `preview:${replacement}`, path: replacement, name: 'fresh.ts', kind: 'file' }]);
    window.branchPreview.refresh();
  }, { folder: coldFolder, replacement });
  await expect.poll(() => page.evaluate(path => window.projectPreview.directoryReads.pending().filter(read => read.path === path).length, coldFolder)).toBe(2);
  const current = await page.evaluate(({ path, obsolete }) => window.projectPreview.directoryReads.pending().find(read => read.path === path && read.id !== obsolete)!.id, { path: coldFolder, obsolete });
  await page.evaluate(id => window.projectPreview.directoryReads.release(id), current);
  await expect(row(page, replacement)).toBeVisible();
  await page.evaluate(id => window.projectPreview.directoryReads.release(id), obsolete);
  await expect.poll(() => page.evaluate(path => window.projectPreview.directoryReads.completed().filter(value => value === path).length, coldFolder)).toBe(2);
  await settle(page);
  await expect(row(page, replacement)).toBeVisible();
  await expect(row(page, coldChild)).toHaveCount(0);
  await expect(row(page, coldFolder)).toHaveAttribute('aria-expanded', 'true');
  await expect(projectTree(page)).toHaveAttribute('aria-busy', 'false');
});

test('repeated refreshes during a cold nested read do not orphan its pending state', async ({ page }) => {
  await open(page);
  await heldColdFolder(page);
  for (let index = 0; index < 3; index++) {
    const roots = await page.evaluate(() => window.projectPreview.directoryReads.completed().filter(path => path === '').length);
    await page.evaluate(() => window.branchPreview.refresh());
    await expect.poll(() => page.evaluate(() => window.projectPreview.directoryReads.completed().filter(path => path === '').length)).toBeGreaterThan(roots);
  }
  await page.evaluate(path => window.projectPreview.directoryReads.resume(path), coldFolder);
  await expect(row(page, coldChild)).toBeVisible();
  await expect(projectTree(page)).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => window.projectPreview.getSelected())).toBe(initialPath);
  await expect(row(page, coldFolder)).toHaveAttribute('aria-expanded', 'true');
});

test('fixture playground provides a top-left workspace switch and links back to fixtures', async ({ page }) => {
  await page.goto('/?fixture=tsx');
  const workspace = page.getByRole('group', { name: 'Workspace view', exact: true });
  await expect(workspace.getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await workspace.getByRole('button', { name: 'Project', exact: true }).click(); await ready(page);
  await expect(page).toHaveURL(/view=project/);
  await page.getByRole('link', { name: 'Diff fixtures', exact: true }).click();
  await expect(page).toHaveURL(/fixture=reference/);
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
  await workspace.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page).toHaveURL(/view=commit/);
  await expect.poll(() => page.evaluate(() => window.commitPreview?.viewer?.getState().status)).toBe('ready');
});
