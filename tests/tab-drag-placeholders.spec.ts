import { mkdir } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';

type Group = 'primary' | 'secondary';
type Edge = 'left' | 'right' | 'up' | 'down';
const initialPath = 'apps/playground/src/ReviewPreferencesPanel.tsx';
const group = (page: Page, id: Group = 'primary') => page.locator(`section[data-group="${id}"]`);
const tabs = (page: Page, id: Group = 'primary') => group(page, id).getByRole('tab');
const tab = (page: Page, label: string, id: Group = 'primary') => group(page, id).getByRole('tab', { name: label, exact: true });
const strip = (page: Page, id: Group = 'primary') => group(page, id).getByRole('tablist');
const marker = (page: Page) => page.getByTestId('tab-drop-placeholder');
const preview = (page: Page) => page.getByTestId('workspace-drop-preview');
const mode = (page: Page, name: 'Project' | 'Commit') => page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name, exact: true });
const order = (page: Page, id: Group = 'primary') => tabs(page, id).evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));

async function bounds(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}
async function chooseFile(page: Page, path: string, id: Group = 'primary') {
  await page.getByRole('tree', { name: 'Project files', exact: true }).getByRole('treeitem', { name: path, exact: true }).click();
  await expect(tab(page, path, id)).toHaveAttribute('aria-selected', 'true');
}
async function open(page: Page) {
  await page.goto('/?view=project');
  await expect(tab(page, initialPath)).toBeVisible();
  await expect(group(page).locator('.file-surface')).toHaveAttribute('data-path', initialPath);
  await expect.poll(() => fileView(page, 'primary')).not.toBeNull();
  await chooseFile(page, 'README.md');
  await chooseFile(page, 'package.json');
}
async function groupAction(page: Page, label: string, id: Group = 'primary') {
  await page.getByRole('button', { name: `Editor group ${id === 'primary' ? 1 : 2} options`, exact: true }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}
async function startDrag(page: Page, source: Locator) {
  await source.scrollIntoViewIfNeeded();
  // The strip reveals its active tab after a layout resize; use the settled
  // position, as a person does, before pressing the mouse button.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const box = await bounds(source);
  await page.mouse.move(box.x + Math.min(35, box.width / 2), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(35, box.width / 2) + 9, box.y + box.height / 2, { steps: 3 });
}
async function over(page: Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 6 });
}
async function overEdge(page: Page, edge: Edge, target: Group = 'primary') {
  const box = await bounds(group(page, target).getByTestId(`editor-drop-${edge}`));
  await over(page, box.x + box.width / 2, box.y + box.height / 2);
  await expect(preview(page)).toHaveAttribute('data-drop-direction', edge);
}
async function clean(page: Page) {
  await expect(marker(page)).toHaveCount(0);
  await expect(preview(page)).toHaveCount(0);
  await expect(page.locator('.workspace-tab-drag-image')).toHaveCount(0);
  await expect(page.locator('.workspace-tab-shell.is-drag-source, .workspace-tab-shell.is-reordering-tab')).toHaveCount(0);
  await expect(page.locator('.editor-workspace')).not.toHaveAttribute('data-tab-drag-mode', /reorder|dock/);
}
async function cancel(page: Page) {
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await clean(page);
}
function sameBounds(actual: { x: number; y: number; width: number; height: number }, expected: typeof actual) {
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(actual[key] - expected[key]), key).toBeLessThanOrEqual(2);
}
async function fileView(page: Page, id: Group) {
  return page.evaluate(groupId => {
    const editor = window.projectPreview.monaco.editor.getEditors().find(candidate => {
      const node = candidate.getDomNode();
      return node?.closest(`section[data-group="${groupId}"]`) && node.closest('.file-surface') && node.getBoundingClientRect().width > 0;
    });
    return editor ? { position: editor.getPosition(), scroll: editor.getScrollTop() } : null;
  }, id);
}
async function setFileView(page: Page, id: Group) {
  // Let a real editor gesture finish any pending restoration before setting a
  // distinctive reading position that the drag must preserve.
  await group(page, id).locator('.file-surface .monaco-editor').click({ position: { x: 180, y: 150 } });
  await page.evaluate(groupId => {
    const editor = window.projectPreview.monaco.editor.getEditors().find(candidate => {
      const node = candidate.getDomNode();
      return node?.closest(`section[data-group="${groupId}"]`) && node.closest('.file-surface') && node.getBoundingClientRect().width > 0;
    })!;
    editor.setPosition({ lineNumber: 65, column: 5 });
    editor.setScrollTop(400);
  }, id);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(() => fileView(page, id)).toEqual({ position: { lineNumber: 65, column: 5 }, scroll: 400 });
  return fileView(page, id);
}
async function capture(page: Page, name: string) {
  await mkdir('artifacts/tab-drag', { recursive: true });
  await page.screenshot({ path: `artifacts/tab-drag/${name}.png` });
}

for (const dpr of [1, 2]) {
  test.describe(`tab drop visuals at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test('tabs reorder directly in their row and detach only outside it', async ({ page }) => {
      await open(page);
      await mode(page, 'Project').click();
      await mkdir('artifacts/tab-inline-reorder', { recursive: true });
      await page.evaluate(() => {
        document.body.dataset.nativeDragCount = '0';
        document.addEventListener('dragstart', () => { document.body.dataset.nativeDragCount = String(Number(document.body.dataset.nativeDragCount) + 1); });
      });
      const workspace = page.locator('.editor-workspace');
      const originalBounds = await bounds(group(page));
      const widths: number[] = [];

      for (const [label, kind] of [[initialPath, 'long-file'], ['README.md', 'short-file']] as const) {
        const source = tab(page, label);
        await source.click();
        await expect(group(page).locator('.file-surface')).toHaveAttribute('data-path', label);
        const reading = label === initialPath ? await setFileView(page, 'primary') : await fileView(page, 'primary');
        const shell = source.locator('..');
        widths.push((await bounds(shell)).width);
        await expect(source).toHaveJSProperty('draggable', false);

        for (const direction of ['right', 'left'] as const) {
          await strip(page).evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
          const before = await order(page);
          const sourceBounds = await bounds(shell);
          const sourceNode = await source.elementHandle();
          const positions = await tabs(page).evaluateAll(elements => elements.map(element => ({ label: element.getAttribute('aria-label'), x: element.getBoundingClientRect().x })));
          const first = await bounds(tabs(page).first().locator('..'));
          const last = await bounds(tabs(page).last().locator('..'));
          const point = { x: direction === 'right' ? last.x + last.width + 14 : first.x + 3, y: sourceBounds.y + sourceBounds.height / 2 };
          const remaining = before.filter(item => item !== label);
          const expected = direction === 'right' ? [...remaining, label] : [label, ...remaining];
          await startDrag(page, source);
          await over(page, point.x, point.y);
          await expect(workspace).toHaveAttribute('data-tab-drag-mode', 'reorder');
          await expect(shell).toHaveClass(/is-reordering-tab/);
          await expect(shell).toHaveCSS('opacity', '1');
          await expect(marker(page)).toHaveCount(0);
          await expect(preview(page)).toHaveCount(0);
          await expect(page.locator('.workspace-tab-drag-image')).toHaveCount(0);
          expect(await sourceNode!.evaluate(node => node.isConnected)).toBe(true);
          const moved = await bounds(shell);
          expect(Math.abs(moved.x - sourceBounds.x)).toBeGreaterThan(50);
          expect(moved.y).toBeCloseTo(sourceBounds.y, 1);
          expect(moved.width).toBeCloseTo(sourceBounds.width, 1);
          expect(moved.height).toBeCloseTo(sourceBounds.height, 1);
          await expect.poll(() => tabs(page).evaluateAll(elements => elements
            .map(element => ({ label: element.getAttribute('aria-label'), x: element.getBoundingClientRect().x }))
            .sort((a, b) => a.x - b.x).map(item => item.label))).toEqual(expected);
          await expect.poll(() => tabs(page).evaluateAll((elements, original) => elements.some(element => {
            const label = element.getAttribute('aria-label');
            const previous = original.positions.find(item => item.label === label);
            return label !== original.source && previous && Math.abs(element.getBoundingClientRect().x - previous.x) > 50;
          }), { positions, source: label })).toBe(true);
          expect(await order(page)).toEqual(before);
          for (let repeat = 0; repeat < 3; repeat++) {
            await page.mouse.move(point.x, point.y);
            sameBounds(await bounds(shell), moved);
          }
          await page.screenshot({ path: `artifacts/tab-inline-reorder/${kind}-${direction}-dpr${dpr}.png` });

          if (label === initialPath && direction === 'right') {
            await overEdge(page, 'up');
            await expect(workspace).toHaveAttribute('data-tab-drag-mode', 'dock');
            await expect(page.locator('.workspace-tab-drag-image')).toBeVisible();
            await expect(shell).not.toHaveClass(/is-reordering-tab/);
            await page.screenshot({ path: `artifacts/tab-inline-reorder/detached-top-dpr${dpr}.png` });
            await over(page, point.x, point.y);
            await expect(workspace).toHaveAttribute('data-tab-drag-mode', 'reorder');
            await expect(page.locator('.workspace-tab-drag-image')).toHaveCount(0);
            await expect(preview(page)).toHaveCount(0);
            await expect(marker(page)).toHaveCount(0);
            await expect(shell).toHaveCSS('opacity', '1');
            sameBounds(await bounds(shell), moved);
          }
          await page.mouse.up();
          await clean(page);
          expect(await order(page)).toEqual(expected);
          await expect(source).toHaveAttribute('aria-selected', 'true');
          await expect.poll(() => fileView(page, 'primary')).toEqual(reading);
          sameBounds(await bounds(group(page)), originalBounds);
        }
      }
      expect(widths[0]).toBeGreaterThan(widths[1] + 50);

      await mode(page, 'Commit').click();
      await page.evaluate(() => window.commitPreview.selectFile('preferences'));
      const diffLabel = `Commit: ${initialPath} — working`;
      await expect(tab(page, diffLabel)).toHaveAttribute('aria-selected', 'true');
      await expect(group(page).locator('.smart-diff')).toHaveAttribute('data-status', 'ready');
      await mode(page, 'Commit').click();
      const beforeDiff = await order(page);
      const first = await bounds(tabs(page).first().locator('..'));
      await startDrag(page, tab(page, diffLabel));
      await over(page, first.x + 3, first.y + first.height / 2);
      await expect(workspace).toHaveAttribute('data-tab-drag-mode', 'reorder');
      await expect(marker(page)).toHaveCount(0);
      await expect(page.locator('.workspace-tab-drag-image')).toHaveCount(0);
      expect(await order(page)).toEqual(beforeDiff);
      await page.screenshot({ path: `artifacts/tab-inline-reorder/diff-left-dpr${dpr}.png` });
      await page.mouse.up();
      await clean(page);
      expect(await order(page)).toEqual([diffLabel, ...beforeDiff.filter(label => label !== diffLabel)]);
      await expect(page.locator('body')).toHaveAttribute('data-native-drag-count', '0');
    });

    for (const edge of ['left', 'up'] as const) {
      test(`docking ${edge} from a single pane puts the dragged tab on that physical side`, async ({ page }) => {
        await open(page);
        await tab(page, initialPath).click();
        await expect(group(page).locator('.file-surface')).toHaveAttribute('data-path', initialPath);
        const reading = await setFileView(page, 'primary');
        await mode(page, 'Project').click();
        await startDrag(page, tab(page, initialPath));
        await overEdge(page, edge);
        await expect(preview(page)).toHaveAttribute('data-drop-group', 'primary');
        const expected = await bounds(preview(page));
        await capture(page, `split-${edge}-dpr${dpr}`);
        await page.mouse.up();
        await clean(page);
        await expect(page.locator('.workspace-group')).toHaveCount(2);
        await expect(tab(page, initialPath)).toHaveAttribute('aria-selected', 'true');
        await expect(tab(page, initialPath, 'secondary')).toHaveCount(0);
        expect(await order(page, 'secondary')).toEqual(['README.md', 'package.json']);
        sameBounds(await bounds(group(page)), expected);
        await expect.poll(() => fileView(page, 'primary')).toEqual(reading);
        const other = await bounds(group(page, 'secondary'));
        if (edge === 'left') expect(expected.x + expected.width).toBeLessThan(other.x);
        else expect(expected.y + expected.height).toBeLessThan(other.y);
      });
    }

    test('split previews describe actual destination sizes for file and diff tabs', async ({ page }) => {
      await open(page);
      await mode(page, 'Commit').click();
      await page.evaluate(() => window.commitPreview.selectFile('preferences'));
      const diffLabel = `Commit: ${initialPath} — working`;
      await expect(tab(page, diffLabel)).toHaveAttribute('aria-selected', 'true');
      await expect(group(page).locator('.smart-diff')).toHaveAttribute('data-status', 'ready');
      await mode(page, 'Commit').click();
      const before = await order(page);
      await startDrag(page, tab(page, diffLabel));
      await overEdge(page, 'right');
      await expect(preview(page)).toHaveAttribute('data-drop-kind', 'split');
      await expect(preview(page)).toHaveAttribute('data-drop-group', 'secondary');
      const right = await bounds(preview(page));
      expect(right.width).toBeGreaterThan((await bounds(page.locator('.editor-workspace'))).width * .45);
      await capture(page, `split-right-dpr${dpr}`);
      expect(await order(page)).toEqual(before);
      await expect(page.locator('.workspace-group')).toHaveCount(1);
      await page.mouse.up();
      await expect(tab(page, diffLabel, 'secondary')).toHaveAttribute('aria-selected', 'true');
      await clean(page);
      sameBounds(await bounds(group(page, 'secondary')), right);

      // Reorienting an existing split uses its non-default ratio. The lower
      // destination is secondary regardless of which group supplied the tab.
      const divider = page.getByRole('separator', { name: 'Resize editor groups', exact: true });
      await divider.focus();
      for (let count = 0; count < 4; count++) await page.keyboard.press('ArrowRight');
      await startDrag(page, tab(page, diffLabel, 'secondary'));
      await overEdge(page, 'down', 'primary');
      await expect(preview(page)).toHaveAttribute('data-drop-group', 'secondary');
      const down = await bounds(preview(page));
      await capture(page, `existing-split-down-dpr${dpr}`);
      await expect(divider).toHaveAttribute('aria-orientation', 'vertical');
      await page.mouse.up();
      await expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
      await clean(page);
      sameBounds(await bounds(group(page, 'secondary')), down);
      await expect(tab(page, diffLabel, 'secondary')).toHaveAttribute('aria-selected', 'true');

      await startDrag(page, tab(page, 'package.json'));
      await overEdge(page, 'down', 'secondary');
      await expect(preview(page)).toHaveAttribute('data-drop-group', 'secondary');
      await capture(page, `file-split-down-dpr${dpr}`);
      await cancel(page);
    });
  });
}

test('a small pointer movement still clicks the tab without starting a drag', async ({ page }) => {
  await open(page);
  await mode(page, 'Project').click();
  const before = await order(page);
  const source = tab(page, 'README.md');
  const box = await bounds(source);
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 32, box.y + box.height / 2);
  await clean(page);
  await page.mouse.up();
  await expect(source).toHaveAttribute('aria-selected', 'true');
  expect(await order(page)).toEqual(before);
});

test('Escape, pointer cancellation and window blur restore the original tab layout', async ({ page }) => {
  await open(page);
  await tab(page, initialPath).click();
  await expect(group(page).locator('.file-surface')).toHaveAttribute('data-path', initialPath);
  const reading = await setFileView(page, 'primary');
  await mode(page, 'Project').click();
  const before = await order(page);
  const source = tab(page, initialPath);
  const original = await bounds(source.locator('..'));
  for (const reason of ['Escape', 'pointercancel', 'blur'] as const) {
    const last = await bounds(tabs(page).last().locator('..'));
    await startDrag(page, source);
    await over(page, last.x + last.width + 14, last.y + last.height / 2);
    await expect(page.locator('.editor-workspace')).toHaveAttribute('data-tab-drag-mode', 'reorder');
    if (reason !== 'pointercancel') await overEdge(page, 'right');
    if (reason === 'Escape') await page.keyboard.press('Escape');
    else if (reason === 'pointercancel') await source.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
    else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await clean(page);
    if (reason === 'pointercancel') {
      // A canceled pointer need not emit a trailing click; keyboard activation
      // must work immediately while any click-suppression guard is still set.
      await tab(page, 'README.md').focus();
      await page.keyboard.press('Enter');
      await expect(tab(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
      await source.focus();
      await page.keyboard.press('Enter');
      await expect(source).toHaveAttribute('aria-selected', 'true');
    }
    await page.mouse.up();
    expect(await order(page)).toEqual(before);
    sameBounds(await bounds(source.locator('..')), original);
    await expect(page.locator('.workspace-group')).toHaveCount(1);
    await expect.poll(() => fileView(page, 'primary')).toEqual(reading);
  }
});

test('dropping on trailing space deduplicates a document already in the destination group', async ({ page }) => {
  await open(page);
  await tab(page, 'README.md').click();
  await groupAction(page, 'Split right');
  await chooseFile(page, 'package.json', 'secondary');
  await mode(page, 'Project').click();
  const sourceBounds = await bounds(tab(page, 'README.md').locator('..'));
  await startDrag(page, tab(page, 'README.md'));
  const box = await bounds(strip(page, 'secondary'));
  await over(page, box.x + box.width - 60, box.y + box.height / 2);
  await expect(marker(page)).toHaveAttribute('data-drop-index', '1');
  await expect(page.locator('.editor-workspace')).toHaveAttribute('data-tab-drag-mode', 'dock');
  await expect(page.locator('.workspace-tab-drag-image')).toBeVisible();
  const slot = await bounds(marker(page));
  expect(slot.width).toBeCloseTo(sourceBounds.width, 1);
  expect(slot.height).toBeCloseTo(sourceBounds.height, 1);
  for (let repeat = 0; repeat < 3; repeat++) {
    await page.mouse.move(slot.x + slot.width / 2, slot.y + slot.height / 2);
    await expect(marker(page)).toHaveAttribute('data-drop-index', '1');
    sameBounds(await bounds(marker(page)), slot);
  }
  await page.mouse.up();
  await clean(page);
  expect(await order(page)).toEqual([initialPath, 'package.json']);
  expect(await order(page, 'secondary')).toEqual(['package.json', 'README.md']);
});

test('center move preview reflects a group collapse and leaving the workspace clears it', async ({ page }) => {
  await open(page);
  await groupAction(page, 'Split right');
  await mode(page, 'Project').click();
  await startDrag(page, tab(page, 'package.json', 'secondary'));
  const content = await bounds(group(page).locator('.workspace-content'));
  await over(page, content.x + content.width / 2, content.y + content.height / 2);
  await expect(preview(page)).toHaveAttribute('data-drop-kind', 'move');
  sameBounds(await bounds(preview(page)), await bounds(page.locator('.editor-workspace')));
  await over(page, 10, 10);
  await expect(preview(page)).toHaveCount(0);
  await expect(marker(page)).toHaveCount(0);
  await cancel(page);
  await expect(page.locator('.workspace-group')).toHaveCount(2);
});

test('overflowing strips auto-scroll during dragging without reordering until drop', async ({ page }) => {
  await page.setViewportSize({ width: 850, height: 800 });
  await open(page);
  for (const path of ['tsconfig.json', '.editorconfig', '.gitignore']) await chooseFile(page, path);
  await mode(page, 'Project').click();
  await tab(page, initialPath).click();
  await expect.poll(() => strip(page).evaluate(element => element.scrollLeft)).toBeLessThan(10);
  const before = await order(page);
  await startDrag(page, tab(page, initialPath));
  const box = await bounds(strip(page));
  await over(page, box.x + box.width - 3, box.y + box.height / 2);
  await expect.poll(() => strip(page).evaluate(element => element.scrollLeft)).toBeGreaterThan(60);
  await expect(page.locator('.editor-workspace')).toHaveAttribute('data-tab-drag-mode', 'reorder');
  await expect(marker(page)).toHaveCount(0);
  await expect(page.locator('.workspace-tab-drag-image')).toHaveCount(0);
  expect(await order(page)).toEqual(before);
  await cancel(page);
  expect(await order(page)).toEqual(before);
});

for (const source of ['primary', 'secondary'] as const) {
  test(`all edges use physical destinations when the tab starts in ${source}`, async ({ page }) => {
    await open(page);
    await groupAction(page, 'Split right');
    await mode(page, 'Project').click();
    const divider = page.getByRole('separator', { name: 'Resize editor groups', exact: true });
    await divider.focus();
    for (let count = 0; count < 5; count++) await page.keyboard.press('ArrowRight');
    expect(Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
    for (const edge of ['left', 'up', 'right', 'down'] as const) {
      const destination = edge === 'left' || edge === 'up' ? 'primary' : 'secondary';
      // Both groups contain the initial split's package.json linked view. Every
      // edge must refer to the physical side, including a same-side drop.
      await startDrag(page, tab(page, 'package.json', source));
      await overEdge(page, edge, source === 'primary' ? 'secondary' : 'primary');
      await expect(preview(page)).toHaveAttribute('data-drop-group', destination);
      const expected = await bounds(preview(page));
      await page.mouse.up();
      await clean(page);
      await expect(page.locator('.workspace-group')).toHaveCount(2);
      await expect(tab(page, 'package.json', destination)).toHaveAttribute('aria-selected', 'true');
      sameBounds(await bounds(group(page, destination)), expected);
      // Make a linked view again when a move into an existing destination
      // removed the source copy. This prepares the next independent direction.
      if (await tab(page, 'package.json', source).count() === 0) {
        await groupAction(page, edge === 'left' || edge === 'right' ? 'Split right' : 'Split down', destination);
      }
    }
  });
}

test('left and upper edge previews cancel without changing layout or tabs', async ({ page }) => {
  await open(page);
  await mode(page, 'Project').click();
  const before = await order(page);
  const originalBounds = await bounds(group(page));
  for (const edge of ['left', 'up'] as const) {
    await startDrag(page, tab(page, 'package.json'));
    await overEdge(page, edge);
    await cancel(page);
    expect(await order(page)).toEqual(before);
    await expect(page.locator('.workspace-group')).toHaveCount(1);
    sameBounds(await bounds(group(page)), originalBounds);
  }
});
