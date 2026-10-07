import { expect, test, type Page } from '@playwright/test';

type Group = 'primary' | 'secondary';
const initialPath = 'apps/playground/src/ReviewPreferencesPanel.tsx';
const group = (page: Page, id: Group = 'primary') => page.locator(`section[data-group="${id}"]`);
const tabs = (page: Page, id: Group = 'primary') => group(page, id).getByRole('tab');
const tab = (page: Page, path: string, id: Group = 'primary') => group(page, id).getByRole('tab', { name: path, exact: true });
const workspaceButton = (page: Page, name: 'Project' | 'Commit') => page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name, exact: true });
const projectRow = (page: Page, path: string) => page.getByRole('tree', { name: 'Project files', exact: true }).getByRole('treeitem', { name: path, exact: true });
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function fileState(page: Page, id: Group = 'primary') {
  return page.evaluate(groupId => {
    const editor = window.projectPreview.monaco.editor.getEditors().find(candidate => {
      const element = candidate.getDomNode();
      return element?.closest(`section[data-group="${groupId}"]`) && element.closest('.file-surface') && element.getBoundingClientRect().width > 0;
    });
    const model = editor?.getModel();
    return editor && model ? { path: editor.getDomNode()!.closest('.file-surface')!.getAttribute('data-path'), text: model.getValue(),
      position: editor.getPosition(), selection: editor.getSelection(), scroll: editor.getScrollTop(), uri: model.uri.toString() } : null;
  }, id);
}
async function positionFile(page: Page, id: Group, line: number, column = 3, scroll = 0) {
  await page.evaluate(({ groupId, line, column, scroll }) => {
    const editor = window.projectPreview.monaco.editor.getEditors().find(candidate => {
      const element = candidate.getDomNode();
      return element?.closest(`section[data-group="${groupId}"]`) && element.closest('.file-surface') && element.getBoundingClientRect().width > 0;
    })!;
    editor.setPosition({ lineNumber: line, column }); editor.setScrollTop(scroll);
  }, { groupId: id, line, column, scroll });
  await settle(page);
  return fileState(page, id);
}
async function readyFile(page: Page, path: string, id: Group = 'primary') {
  await expect.poll(async () => (await fileState(page, id))?.path).toBe(path);
  await expect(tab(page, path, id)).toHaveAttribute('aria-selected', 'true');
  await settle(page);
}
async function open(page: Page) {
  await page.goto('/?view=project');
  await expect(group(page)).toBeVisible();
  await readyFile(page, initialPath);
}
async function chooseFile(page: Page, path: string, id: Group = 'primary') {
  await projectRow(page, path).click(); await readyFile(page, path, id);
}
async function action(page: Page, label: string, id: Group = 'primary') {
  await page.getByRole('button', { name: `Editor group ${id === 'primary' ? 1 : 2} options`, exact: true }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  await settle(page);
}
async function order(page: Page, id: Group = 'primary') {
  return tabs(page, id).evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
}
async function dragToEdge(page: Page, path: string, edge: 'right' | 'down', target: Group = 'primary') {
  const source = (await tab(page, path).boundingBox())!;
  // Edge indicators deliberately have pointer-events:none. Drag by coordinates
  // so the real pointer events reach the editor's containing drop surface.
  const destination = (await group(page, target).getByTestId(`editor-drop-${edge}`).boundingBox())!;
  const x = destination.x + destination.width / 2, y = destination.y + destination.height / 2;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down(); await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.move(x + 1, y + 1); await page.mouse.up();
}

test('opening files creates distinct tabs, deduplicates repeated selections and restores each reading position', async ({ page }) => {
  await open(page);
  const original = await positionFile(page, 'primary', 65, 5, 400);
  await chooseFile(page, 'README.md');
  const readme = await positionFile(page, 'primary', 2, 1);
  await chooseFile(page, 'package.json');
  await chooseFile(page, 'README.md');
  await expect(tabs(page)).toHaveCount(3);
  await expect(tab(page, 'README.md')).toHaveCount(1);
  expect((await fileState(page))?.position).toEqual(readme?.position);
  await tab(page, initialPath).click(); await readyFile(page, initialPath);
  expect((await fileState(page))?.position).toEqual(original?.position);
  expect(Math.abs((await fileState(page))!.scroll - original!.scroll)).toBeLessThan(2);
  await tab(page, 'README.md').click(); await readyFile(page, 'README.md');
  expect((await fileState(page))?.position).toEqual(readme?.position);
});

test('closing an active tab selects an adjacent tab and releases its editor model', async ({ page }) => {
  await open(page);
  for (const path of ['README.md', 'package.json', 'tsconfig.json']) await chooseFile(page, path);
  await tab(page, 'README.md').click(); await readyFile(page, 'README.md');
  const retired = (await fileState(page))!.uri;
  const before = await order(page);
  const index = before.indexOf('README.md');
  const adjacent = [before[index - 1], before[index + 1]].filter(Boolean);
  await group(page).getByRole('button', { name: 'Close README.md', exact: true }).click();
  await expect(tab(page, 'README.md')).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(3);
  await expect.poll(() => group(page).getByRole('tab', { selected: true }).getAttribute('aria-label')).toBeTruthy();
  expect(adjacent).toContain(await group(page).getByRole('tab', { selected: true }).getAttribute('aria-label'));
  await expect.poll(() => page.evaluate(uri => window.projectPreview.monaco.editor.getModels().some(model => model.uri.toString() === uri), retired)).toBe(false);
});

test('tabs reorder by dragging and move between editor groups without duplicating the document', async ({ page }) => {
  await open(page);
  await chooseFile(page, 'README.md'); await chooseFile(page, 'package.json');
  await workspaceButton(page, 'Project').click();
  await tab(page, 'package.json').dragTo(tab(page, initialPath), { targetPosition: { x: 3, y: 12 } });
  await expect.poll(() => order(page)).toEqual(['package.json', initialPath, 'README.md']);
  await tab(page, 'README.md').click();
  await action(page, 'Split right');
  await expect(group(page, 'secondary')).toBeVisible();
  await tab(page, initialPath).dragTo(tab(page, 'README.md', 'secondary'), { targetPosition: { x: 3, y: 12 } });
  await expect(tab(page, initialPath)).toHaveCount(0);
  await expect(tab(page, initialPath, 'secondary')).toHaveCount(1);
  await expect(tab(page, initialPath, 'secondary')).toHaveAttribute('aria-selected', 'true');
  await readyFile(page, initialPath, 'secondary');
  await action(page, 'Move tab to other group', 'secondary');
  await expect(tab(page, initialPath, 'secondary')).toHaveCount(0);
  await expect(tab(page, initialPath)).toHaveCount(1);
  await readyFile(page, initialPath);
});

test('split groups keep independent positions and support pointer and keyboard resizing in both orientations', async ({ page }) => {
  await open(page);
  const original = await positionFile(page, 'primary', 60, 5, 350);
  await action(page, 'Split right');
  await readyFile(page, initialPath, 'secondary');
  expect((await fileState(page, 'secondary'))?.position).toEqual(original?.position);
  const second = await positionFile(page, 'secondary', 110, 7, 700);
  expect((await fileState(page, 'primary'))?.position).toEqual(original?.position);
  expect((await fileState(page, 'secondary'))?.position).toEqual(second?.position);
  const separator = page.getByRole('separator', { name: 'Resize editor groups', exact: true });
  await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
  const initial = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(initial);
  const before = (await group(page).boundingBox())!.width;
  const bounds = (await separator.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 90); await page.mouse.down();
  await page.mouse.move(bounds.x + 55, bounds.y + 90, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await group(page).boundingBox())!.width).toBeGreaterThan(before + 30);
  await action(page, 'Unsplit', 'secondary');
  await expect(group(page, 'secondary')).toHaveCount(0);
  await action(page, 'Split down');
  await expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
  const top = Number(await separator.getAttribute('aria-valuenow'));
  await separator.focus(); await page.keyboard.press('ArrowDown');
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(top);
  await expect(page.locator('.workspace-group')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/workspace-split-down.png' });
});

test('shrinking a tab strip reveals its active tab without changing the selected document', async ({ page }) => {
  await open(page);
  for (const path of ['README.md', 'package.json', 'tsconfig.json', '.editorconfig', '.gitignore']) await chooseFile(page, path);
  const activePath = '.gitignore';
  const visibleSelectedTab = () => group(page).getByRole('tab', { selected: true }).evaluate(node => {
    const strip = node.closest('[role="tablist"]')!.getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    return bounds.left >= strip.left - 1 && bounds.right <= strip.right + 1;
  });
  await action(page, 'Split right');
  await readyFile(page, activePath, 'secondary');
  await expect.poll(visibleSelectedTab).toBe(true);
  await expect(tab(page, activePath)).toHaveAttribute('aria-selected', 'true');
  const divider = page.getByRole('separator', { name: 'Resize editor groups', exact: true });
  await divider.focus();
  for (let step = 0; step < 8; step++) await page.keyboard.press('ArrowLeft');
  await expect.poll(visibleSelectedTab).toBe(true);
  await expect(tab(page, activePath)).toHaveAttribute('aria-selected', 'true');
  await tab(page, 'README.md').click();
  await readyFile(page, 'README.md');
  await expect(tab(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
});

test('closing the final tab in a split removes the empty editor group', async ({ page }) => {
  await open(page);
  await action(page, 'Split right');
  await readyFile(page, initialPath, 'secondary');
  await group(page, 'secondary').getByRole('button', { name: `Close ${initialPath}`, exact: true }).click();
  await expect(group(page, 'secondary')).toHaveCount(0);
  await expect(page.getByRole('separator', { name: 'Resize editor groups', exact: true })).toHaveCount(0);
  await readyFile(page, initialPath);
});

test('dragging tabs onto editor edges creates and reorients a split without creating a third group', async ({ page }) => {
  await open(page);
  await chooseFile(page, 'README.md'); await chooseFile(page, 'package.json');
  await workspaceButton(page, 'Project').click();
  await dragToEdge(page, 'package.json', 'right');
  await readyFile(page, 'package.json', 'secondary');
  await expect(tab(page, 'package.json')).toHaveCount(0);
  await expect(page.getByRole('separator', { name: 'Resize editor groups', exact: true })).toHaveAttribute('aria-orientation', 'vertical');
  await dragToEdge(page, 'README.md', 'down', 'secondary');
  await readyFile(page, 'README.md', 'secondary');
  await expect(tab(page, 'README.md')).toHaveCount(0);
  await expect(tab(page, 'package.json', 'secondary')).toHaveCount(1);
  await expect(page.locator('.workspace-group')).toHaveCount(2);
  await expect(page.getByRole('separator', { name: 'Resize editor groups', exact: true })).toHaveAttribute('aria-orientation', 'horizontal');
});

test('Project and Commit toggle their panels and preserve sidebar state across mode switches and keyboard shortcuts', async ({ page }) => {
  await open(page);
  const projectTree = page.getByRole('tree', { name: 'Project files', exact: true });
  const commitTree = page.getByRole('tree', { name: 'Changed files', exact: true });
  const sidebarState = async (visible: 'Project' | 'Commit' | null) => {
    for (const name of ['Project', 'Commit'] as const) {
      await expect(workspaceButton(page, name)).toHaveAttribute('aria-pressed', String(visible === name));
      await expect(workspaceButton(page, name)).toHaveAttribute('aria-expanded', String(visible === name));
    }
    if (visible === 'Project') await expect(projectTree).toBeVisible(); else await expect(projectTree).toBeHidden();
    if (visible === 'Commit') await expect(commitTree).toBeVisible(); else await expect(commitTree).toBeHidden();
  };
  await sidebarState('Project');
  const resize = page.getByRole('separator', { name: 'Resize project panel', exact: true });
  await resize.focus(); await page.keyboard.press('ArrowRight');
  const width = await resize.getAttribute('aria-valuenow');
  await chooseFile(page, 'README.md');
  const reading = await positionFile(page, 'primary', 2, 1);
  await expect(projectRow(page, 'apps/playground/src')).toHaveAttribute('aria-expanded', 'true');
  const before = (await group(page).boundingBox())!.width;
  await workspaceButton(page, 'Project').click(); await sidebarState(null);
  await expect.poll(async () => (await group(page).boundingBox())!.width).toBeGreaterThan(before + 250);
  await workspaceButton(page, 'Project').click(); await sidebarState('Project');
  await expect(resize).toHaveAttribute('aria-valuenow', width!);

  // Either button can open its panel after the other panel was hidden.
  await workspaceButton(page, 'Project').click(); await sidebarState(null);
  await workspaceButton(page, 'Commit').click(); await sidebarState('Commit');
  await workspaceButton(page, 'Commit').click(); await sidebarState(null);
  await workspaceButton(page, 'Project').click(); await sidebarState('Project');

  // Clicking the other mode while a panel is open switches it directly.
  await workspaceButton(page, 'Commit').click(); await sidebarState('Commit');
  await workspaceButton(page, 'Project').click(); await sidebarState('Project');
  await expect(projectRow(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
  await expect(projectRow(page, 'apps/playground/src')).toHaveAttribute('aria-expanded', 'true');
  await readyFile(page, 'README.md');
  expect((await fileState(page))?.position).toEqual(reading?.position);

  await page.evaluate(() => window.projectPreview.editor!.focus());
  await page.keyboard.press('Control+b'); await sidebarState(null);
  await page.keyboard.press('Control+b'); await sidebarState('Project');
  await page.keyboard.press('Meta+b'); await sidebarState(null);
  await page.keyboard.press('Meta+b'); await sidebarState('Project');
  await expect(resize).toHaveAttribute('aria-valuenow', width!);
  await expect(projectRow(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
  await expect(projectRow(page, 'apps/playground/src')).toHaveAttribute('aria-expanded', 'true');
  expect((await fileState(page))?.position).toEqual(reading?.position);
});

test('ordinary files, modified diffs and additions coexist as distinct tabs across editor groups', async ({ page }) => {
  await open(page);
  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true }).click();
  await page.evaluate(() => window.commitPreview.selectFile('preferences'));
  await expect(group(page).locator('.smart-diff')).toHaveAttribute('data-status', 'ready');
  const comparisonTab = group(page).getByRole('tab', { selected: true });
  const comparisonLabel = (await comparisonTab.getAttribute('aria-label'))!;
  expect(comparisonLabel).toBe(`Commit: ${initialPath} — working`);
  await page.evaluate(() => window.commitPreview.selectFile('new-panel'));
  await expect(group(page).locator('.file-surface[data-added="true"]')).toBeVisible();
  await expect(tabs(page)).toHaveCount(3);
  await action(page, 'Split right');
  await expect(group(page, 'secondary').locator('.file-surface[data-added="true"]')).toBeVisible();
  await tab(page, initialPath).click(); await readyFile(page, initialPath);
  await expect(group(page).locator('.file-surface')).not.toHaveAttribute('data-added', 'true');
  await group(page).getByRole('tab', { name: comparisonLabel, exact: true }).click();
  await expect(group(page).locator('.smart-diff')).toHaveAttribute('data-status', 'ready');
  await expect(group(page, 'secondary').locator('.file-surface[data-added="true"]')).toBeVisible();
  await expect(group(page).getByRole('button', { name: 'Next change', exact: true })).toBeVisible();
  await expect(group(page, 'secondary').getByRole('button', { name: 'Next change', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/workspace-diff-and-added.png' });
});

test('tab and group-menu controls remain keyboard reachable', async ({ page }) => {
  await open(page);
  await chooseFile(page, 'README.md'); await chooseFile(page, 'package.json');
  await tab(page, initialPath).focus(); await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'README.md')).toBeFocused();
  await page.keyboard.press('Enter'); await readyFile(page, 'README.md');
  await page.keyboard.press('End'); await expect(tab(page, 'package.json')).toBeFocused();
  await page.keyboard.press('Home'); await expect(tab(page, initialPath)).toBeFocused();
  const menu = page.getByRole('button', { name: 'Editor group 1 options', exact: true });
  await menu.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Split right', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
});
