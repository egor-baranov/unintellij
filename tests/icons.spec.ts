import { mkdir } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';

async function expectLocalIconsLoaded(page: Page, scope: Locator = page.locator('body')): Promise<void> {
  const icons = scope.locator('img.jb-icon');
  expect(await icons.count()).toBeGreaterThan(0);
  await expect.poll(() => icons.evaluateAll(nodes => nodes.filter(node => {
    const icon = node as HTMLImageElement;
    return !icon.complete || icon.naturalWidth === 0 || icon.naturalHeight === 0;
  }).length)).toBe(0);
  expect(await icons.evaluateAll(nodes => nodes.filter(node => {
    const icon = node as HTMLImageElement;
    return new URL(icon.currentSrc, location.href).origin !== location.origin
      || icon.alt !== '' || icon.getAttribute('aria-hidden') !== 'true' || icon.draggable;
  }).map(node => node.getAttribute('data-icon')))).toEqual([]);
}

async function checkboxImage(checkbox: Locator): Promise<string> {
  const image = await checkbox.evaluate(async node => {
    const background = getComputedStyle(node).backgroundImage;
    const url = /^url\(["']?(.*?)["']?\)$/.exec(background)?.[1];
    if (!url) return { background, loaded: false, local: false };
    const icon = new Image();
    icon.src = url;
    try { await icon.decode(); } catch { return { background, loaded: false, local: false }; }
    return {
      background,
      loaded: icon.naturalWidth > 0 && icon.naturalHeight > 0,
      local: url.startsWith('data:image/svg+xml') || new URL(url, location.href).origin === location.origin,
    };
  });
  expect(image.loaded, `Checkbox background must decode: ${image.background}`).toBe(true);
  expect(image.local).toBe(true);
  return image.background;
}

test('Project and Commit load local decorative toolbar, folder, and file-type icons', async ({ page }) => {
  const externalImages: string[] = [];
  page.on('request', request => {
    if (request.resourceType() === 'image' && new URL(request.url()).origin !== new URL(page.url()).origin) externalImages.push(request.url());
  });
  await page.goto('/?view=project');
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  const row = (path: string) => tree.getByRole('treeitem', { name: path, exact: true });
  await expect(row('apps/playground/src/ReviewPreferencesPanel.tsx').locator('[data-icon="file-tsx"]')).toBeVisible();
  await expect(row('tsconfig.json').locator('[data-icon="file-json"]')).toBeVisible();
  await expect(row('README.md').locator('[data-icon="file-markdown"]')).toBeVisible();
  await expect(row('apps').locator('[data-icon="folder"]')).toBeVisible();
  await expectLocalIconsLoaded(page);

  await page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Commit', exact: true }).click();
  const changedFiles = page.getByRole('tree', { name: 'Changed files', exact: true });
  await expect(changedFiles).toBeVisible();
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await expect(changedFiles.locator('[data-file-id="playground-main"] [data-icon="file-tsx"]')).toBeVisible();
  await expect(changedFiles.locator('[data-file-id="playground-main"]')).toHaveCount(1);
  await expect(changedFiles.locator('[data-file-id="playground-staged"]')).toHaveCount(0);
  await expect(changedFiles.locator('[data-file-id="readme-staged"] [data-icon="file-markdown"]')).toBeVisible();
  await expectLocalIconsLoaded(page);
  expect(externalImages).toEqual([]);
});

test('language and infrastructure files retain their specific icons in Project and opened tabs', async ({ page, browser }) => {
  await page.goto('/?view=project');
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  await tree.getByRole('treeitem', { name: 'apps', exact: true }).click();
  const folder = tree.getByRole('treeitem', { name: 'file-types', exact: true });
  await folder.click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  for (const [name, icon] of [
    ['BUILD', 'file-bazel'], ['BUILD.bazel', 'file-bazel'], ['WORKSPACE', 'file-bazel'],
    ['WORKSPACE.bazel', 'file-bazel'], ['MODULE.bazel', 'file-bazel'], ['defs.bzl', 'file-bazel'],
    ['main.go', 'file-go'], ['go.mod', 'file-go-mod'], ['go.sum', 'file-go-sum'], ['go.work', 'file-go-work'],
    ['main.tf', 'file-terraform'], ['vars.tfvars', 'file-terraform'], ['settings.tf.json', 'file-terraform'],
    ['terragrunt.hcl', 'file-terragrunt'], ['service.proto', 'file-proto'],
    ['main.py', 'file-python'], ['window.pyw', 'file-python'], ['types.pyi', 'file-python'],
  ]) {
    const path = `file-types/${name}`;
    const row = tree.getByRole('treeitem', { name: path, exact: true });
    await expect(row.locator(`img[data-icon="${icon}"]`)).toBeVisible();
    await expectLocalIconsLoaded(page, row);
    await row.click();
    const tab = page.getByRole('tab', { name: path, exact: true });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab.locator(`img[data-icon="${icon}"]`)).toBeVisible();
    await expectLocalIconsLoaded(page, tab);
  }
  await folder.scrollIntoViewIfNeeded();
  await mkdir('artifacts/file-icons', { recursive: true });
  await page.screenshot({ path: 'artifacts/file-icons/language-and-infrastructure-files-dpr1.png' });
  const retina = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  try {
    const retinaPage = await retina.newPage();
    await retinaPage.goto(page.url());
    const retinaTree = retinaPage.getByRole('tree', { name: 'Project files', exact: true });
    await retinaTree.getByRole('treeitem', { name: 'apps', exact: true }).click();
    await retinaTree.getByRole('treeitem', { name: 'file-types', exact: true }).click();
    await retinaTree.getByRole('treeitem', { name: 'file-types/types.pyi', exact: true }).click();
    await expect(retinaPage.getByRole('tab', { name: 'file-types/types.pyi', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expectLocalIconsLoaded(retinaPage);
    await retinaPage.screenshot({ path: 'artifacts/file-icons/language-and-infrastructure-files-dpr2.png' });
  } finally {
    await retina.close();
  }
});

test('official checkbox backgrounds decode for unchecked, checked, and mixed review states', async ({ page }) => {
  await page.goto('/?view=commit');
  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  const changes = page.getByRole('checkbox', { name: 'Include Changes in review', exact: true });
  const leaf = page.getByRole('tree', { name: 'Changed files', exact: true }).locator('[data-file-id="playground-main"]').getByRole('checkbox');
  await changes.uncheck();
  await expect(changes).toHaveAttribute('aria-checked', 'false');
  const unchecked = await checkboxImage(changes);
  await changes.check();
  await expect(leaf).toBeChecked();
  const checked = await checkboxImage(changes);
  await leaf.uncheck();
  await expect(changes).toHaveAttribute('aria-checked', 'mixed');
  const mixed = await checkboxImage(changes);
  expect(new Set([unchecked, checked, mixed]).size).toBe(3);
  // Checkbox decoration must preserve review selection and the active comparison.
  expect(await page.evaluate(() => window.commitPreview.getSelected())).toBe('preferences');
  await changes.check();
  await changes.uncheck();
  const commit = page.locator('.commit-panel').getByRole('button', { name: 'Commit', exact: true });
  await page.getByRole('textbox', { name: 'Commit message (local draft)', exact: true }).fill('Verify checked file icons');
  await expect(commit).toBeDisabled();
  await leaf.check();
  await expect(commit).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Commit settings', exact: true }).locator('[data-icon="settings"]')).toBeVisible();
});

test('floating menu icons stay local and preserve checked actions and focus', async ({ page }) => {
  await page.goto('/?view=commit');
  const picker = page.getByRole('button', { name: 'Project switcher', exact: true });
  await picker.click();
  const projectMenu = page.getByRole('menu', { name: 'Project switcher', exact: true });
  await expect(projectMenu).toBeVisible();
  await expectLocalIconsLoaded(page, projectMenu);
  await page.keyboard.press('Escape');
  await expect(picker).toBeFocused();

  const options = page.getByRole('button', { name: 'Diff options', exact: true });
  await options.click();
  const menu = page.getByRole('menu', { name: 'Diff options', exact: true });
  const collapse = menu.getByRole('menuitemcheckbox', { name: 'Collapse unchanged', exact: true });
  await expect(collapse).toHaveAttribute('aria-checked', 'true');
  await expect(collapse.locator('[data-icon="check"]')).toBeVisible();
  await expectLocalIconsLoaded(page, menu);
  await collapse.click();
  await expect(options).toBeFocused();
  await options.click();
  await expect(collapse).toHaveAttribute('aria-checked', 'false');
  await expect(collapse.locator('[data-icon="check"]')).toHaveCount(0);
});
