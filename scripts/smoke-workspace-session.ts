/** Production Electron regression check. Build first, then run with `npx tsx scripts/smoke-workspace-session.ts`. */
import { _electron as electron, expect as baseExpect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const expect = baseExpect.configure({ timeout: 15000 });
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-workspace-session-'));
const profile = join(directory, 'profile');
const firstRepository = join(directory, 'first-repository');
const secondRepository = join(directory, 'second-repository');
const errors: string[] = [];
let application: ElectronApplication | undefined;

// Every line differs, so collapsed unchanged regions cannot hide the long-file
// viewport checks. Both files have enough horizontal content to exercise X too.
const source = (version: string) => Array.from({ length: 220 }, (_, index) =>
  `export const row_${String(index + 1).padStart(4, '0')} = "${'0123456789'.repeat(70)}"; // ${version}\n`).join('');
async function createRepository(path: string, changedPath: string) {
  await mkdir(path);
  const git = (...args: string[]) => run('git', ['-C', path, ...args], { shell: false });
  await git('init', '-q', '-b', 'main');
  await writeFile(join(path, changedPath), source('before'));
  await writeFile(join(path, 'notes.ts'), source('notes'));
  await git('add', '--', changedPath, 'notes.ts');
  await git('-c', 'user.name=Workspace Smoke', '-c', 'user.email=workspace-smoke@example.invalid', 'commit', '-qm', 'Isolated workspace fixture');
  await writeFile(join(path, changedPath), source('after'));
}
async function hideWindows() {
  await application!.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false);
      window.hide();
    }
  });
}
async function launch() {
  await mkdir(profile, { recursive: true });
  const executablePath = process.env.SMART_DIFF_PACKAGED_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [`--user-data-dir=${profile}`] }
      : { args: [resolve('apps/desktop/dist/index.cjs'), `--user-data-dir=${profile}`] }),
    env: { ...process.env, SMART_DIFF_DEV_URL: '' },
  });
  application = app;
  const observe = (page: Page) => page.on('pageerror', error => errors.push(error.message));
  app.windows().forEach(observe);
  app.on('window', observe);
  await app.firstWindow();
  await hideWindows();
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  return app;
}
async function chooseRepository(origin: Page, path: string, welcome = false) {
  const previousWindows = application!.windows().length;
  await application!.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, path);
  const created = application!.waitForEvent('window');
  if (welcome) await origin.getByRole('button', { name: 'Open…', exact: true }).click();
  else {
    await origin.getByRole('button', { name: 'Project switcher', exact: true }).click();
    await origin.getByRole('menuitem', { name: 'Open…', exact: true }).click();
  }
  const page = await created;
  await hideWindows();
  await expect(page.getByRole('button', { name: 'Project switcher', exact: true })).toContainText(basename(path));
  await expect.poll(() => application!.windows().length).toBe(previousWindows + (welcome ? 0 : 1));
  expect(await page.evaluate(() => location.protocol)).toBe('app:');
  return page;
}
const group = (page: Page, number: number) => page.getByRole('region', { name: `Editor group ${number}`, exact: true });
const file = (page: Page, number: number) => group(page, number).getByTestId('file-surface').locator('.monaco-editor');
const diffSide = (page: Page, side: 'original' | 'modified') => group(page, 1).locator(`[data-side="${side}"] .monaco-editor`);
const fileTab = 'changes.ts';
const diffTab = 'Commit: changes.ts — working';
async function chooseMode(page: Page, mode: 'Project' | 'Commit') {
  const button = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: mode, exact: true });
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
}
async function layout(page: Page) {
  return page.locator('.editor-workspace').evaluate(node => ({
    direction: node.getAttribute('data-direction'),
    activeGroup: node.getAttribute('data-active-group'),
    groups: [...node.querySelectorAll('.workspace-group')].map(section => ({
      id: section.getAttribute('data-group'),
      tabs: [...section.querySelectorAll('[role="tab"]')].map(tab => tab.getAttribute('aria-label')),
      active: section.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-label'),
    })),
    ratio: node.querySelector('[aria-label="Resize editor groups"]')?.getAttribute('aria-valuenow'),
  }));
}

// These assertions inspect only rendered Monaco state, without adding a test
// bridge or reaching through React/Monaco private objects in the production app.
async function viewport(editor: Locator) {
  return editor.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    const lines = [...node.querySelectorAll<HTMLElement>('.view-line')]
      .filter(line => { const rect = line.getBoundingClientRect(); return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 8; })
      .map(line => ({ row: line.textContent?.match(/row_\d+/)?.[0], y: Math.round(line.getBoundingClientRect().top - bounds.top) }))
      .filter(line => line.row).slice(0, 3);
    const horizontalSlider = node.querySelector<HTMLElement>('.scrollbar.horizontal .slider');
    const verticalSlider = node.querySelector<HTMLElement>('.scrollbar.vertical .slider');
    const horizontalTransform = new DOMMatrixReadOnly(horizontalSlider ? getComputedStyle(horizontalSlider).transform : undefined);
    const verticalTransform = new DOMMatrixReadOnly(verticalSlider ? getComputedStyle(verticalSlider).transform : undefined);
    return {
      lines,
      horizontal: Math.round(parseFloat(horizontalSlider?.style.left || '0') + horizontalTransform.m41),
      vertical: Math.round(parseFloat(verticalSlider?.style.top || '0') + verticalTransform.m42),
      selection: [...node.querySelectorAll<HTMLElement>('.cslr')].map(part => ({
        top: Math.round(part.getBoundingClientRect().top - bounds.top),
        left: Math.round(part.getBoundingClientRect().left - bounds.left),
        width: Math.round(part.getBoundingClientRect().width),
        height: Math.round(part.getBoundingClientRect().height),
      })).filter(part => part.width > 0 && part.height > 0),
    };
  });
}
type Viewport = Awaited<ReturnType<typeof viewport>>;
async function positionEditor(page: Page, editor: Locator, horizontal: number, vertical: number): Promise<Viewport> {
  await expect(editor).toBeVisible();
  const box = await editor.boundingBox();
  if (!box) throw new Error('Editor has no layout box');
  // Monaco's ordinary Go to Line command creates deterministic cursor/viewport
  // positions without depending on foreground macOS wheel event routing.
  await page.mouse.click(box.x + box.width * .55, box.y + box.height * .4);
  await page.keyboard.press('Control+g');
  const goToLine = page.locator('.quick-input-widget:visible input');
  await expect(goToLine).toBeVisible();
  await goToLine.fill(`:${Math.floor(vertical / 20) + 20}:${Math.floor(horizontal / 6) + 50}`);
  await page.keyboard.press('Enter');
  await expect(goToLine).toBeHidden();
  for (let count = 0; count < 7; count++) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await viewport(editor)).horizontal).toBeGreaterThan(0);
  await expect.poll(async () => (await viewport(editor)).vertical).toBeGreaterThan(0);
  await expect.poll(async () => (await viewport(editor)).selection.length).toBeGreaterThan(0);
  // Monaco paints selection/scrollbar updates on the next animation frame.
  await editor.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return viewport(editor);
}
async function expectViewport(editor: Locator, expected: Viewport, label: string) {
  await expect(editor, label).toBeVisible();
  try {
    await expect.poll(() => viewport(editor), { message: `${label}: rendered rows, horizontal/vertical scrolling and selection` }).toEqual(expected);
  } catch (cause) {
    console.error(`${label}: persisted editor snapshot`, JSON.stringify(await editor.evaluate(async node => {
      const instance = node.closest('.workspace-tab-content')?.getAttribute('data-instance-id');
      const repository = (await window.desktop.getLastRepository())?.repository;
      const session = await window.desktop.getWindowSessionId();
      const raw = repository && localStorage.getItem(`smart-diff:editor-session:v1:${JSON.stringify([repository.path, session])}`);
      return raw && instance ? JSON.parse(raw).views?.[instance] : null;
    }), null, 2));
    throw cause;
  }
}
async function waitForRepository(path: string) {
  let found: Page | undefined;
  await expect.poll(async () => {
    for (const page of application!.windows()) {
      try {
        const repository = await page.evaluate(async () => (await window.desktop.getLastRepository())?.repository.path);
        if (repository === path) { found = page; return true; }
      } catch { /* A restored window may still be loading its preload. */ }
    }
    return false;
  }, { message: `Restored repository window: ${path}` }).toBe(true);
  return found!;
}

try {
  await createRepository(firstRepository, 'changes.ts');
  await createRepository(secondRepository, 'other.ts');
  await launch();
  const welcome = await application!.firstWindow();
  await expect(welcome.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  const first = await chooseRepository(welcome, firstRepository, true);
  await expect.poll(() => welcome.isClosed()).toBe(true);
  const firstIdentity = await first.evaluate(async () => (await window.desktop.getLastRepository())!.repository);
  const firstSessionId = await first.evaluate(() => window.desktop.getWindowSessionId());
  await expect(group(first, 1).locator('.smart-diff[data-status="ready"]')).toBeVisible();

  await chooseMode(first, 'Project');
  await first.getByRole('treeitem', { name: 'notes.ts', exact: true }).click();
  await expect(group(first, 1).getByTestId('file-surface')).toHaveAttribute('data-path', 'notes.ts');
  await first.getByRole('treeitem', { name: fileTab, exact: true }).click();
  await expect(group(first, 1).getByRole('tab')).toHaveCount(3);
  await group(first, 1).getByRole('tab', { name: 'notes.ts', exact: true }).dragTo(
    group(first, 1).getByRole('tab', { name: diffTab, exact: true }), { targetPosition: { x: 3, y: 12 } });
  expect((await layout(first)).groups[0].tabs).toEqual(['notes.ts', diffTab, fileTab]);
  await group(first, 1).getByRole('tab', { name: fileTab, exact: true }).click();
  await group(first, 1).getByRole('button', { name: 'Editor group 1 options', exact: true }).click();
  await first.getByRole('menuitem', { name: 'Split right', exact: true }).click();
  await expect(group(first, 2).getByTestId('file-surface')).toHaveAttribute('data-path', fileTab);
  const divider = first.getByRole('separator', { name: 'Resize editor groups', exact: true });
  await divider.focus();
  await first.keyboard.press('ArrowRight');
  await first.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '54');
  expect(await group(first, 1).getByRole('tab', { name: fileTab, exact: true }).getAttribute('data-instance-id'))
    .not.toBe(await group(first, 2).getByRole('tab', { name: fileTab, exact: true }).getAttribute('data-instance-id'));

  await group(first, 1).getByRole('tab', { name: 'notes.ts', exact: true }).click();
  const notesViewport = await positionEditor(first, file(first, 1), 430, 940);
  await group(first, 1).getByRole('tab', { name: fileTab, exact: true }).click();
  const firstFileViewport = await positionEditor(first, file(first, 1), 590, 1370);
  const secondFileViewport = await positionEditor(first, file(first, 2), 810, 1820);
  expect(secondFileViewport.lines).not.toEqual(firstFileViewport.lines);
  // A temporarily hidden content host has zero dimensions during mounting.
  // Keep its real tabstrip available, remount the saved notes editor, then show
  // it again to catch premature horizontal-scroll clamping before first layout.
  const primaryContent = group(first, 1).locator('.workspace-content');
  await primaryContent.evaluate(node => { (node as HTMLElement).style.display = 'none'; });
  await group(first, 1).getByRole('tab', { name: 'notes.ts', exact: true }).click();
  await expect(group(first, 1).getByTestId('file-surface')).toHaveAttribute('data-path', 'notes.ts');
  await expect(file(first, 1)).toBeHidden();
  await primaryContent.evaluate(node => { (node as HTMLElement).style.removeProperty('display'); });
  await expectViewport(file(first, 1), notesViewport, 'Remount in a hidden content host');
  await group(first, 1).getByRole('tab', { name: fileTab, exact: true }).click();
  await expectViewport(file(first, 1), firstFileViewport, 'Primary file after hidden-host remount');
  await group(first, 1).getByRole('tab', { name: diffTab, exact: true }).click();
  await expect(group(first, 1).locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await group(first, 1).getByRole('button', { name: 'Synchronize scrolling', exact: true }).click();
  const diffDivider = group(first, 1).getByRole('separator', { name: 'Resize diff panes', exact: true });
  await diffDivider.focus();
  await first.keyboard.press('ArrowRight');
  await expect(diffDivider).toHaveAttribute('aria-valuenow', '52');
  const originalViewport = await positionEditor(first, diffSide(first, 'original'), 390, 1120);
  const modifiedViewport = await positionEditor(first, diffSide(first, 'modified'), 670, 1560);
  await group(first, 2).getByRole('tab', { name: fileTab, exact: true }).click();
  const expectedLayout = await layout(first);
  expect(expectedLayout.activeGroup).toBe('secondary');
  const initialContents = await readFile(join(firstRepository, fileTab), 'utf8');

  const second = await chooseRepository(first, secondRepository);
  const secondIdentity = await second.evaluate(async () => (await window.desktop.getLastRepository())!.repository);
  const secondSessionId = await second.evaluate(() => window.desktop.getWindowSessionId());
  expect(secondSessionId).not.toBe(firstSessionId);
  await expect.poll(() => first.evaluate(async () => (await window.desktop.listOpenRepositories()).map(item => item.path).sort()))
    .toEqual([await realpath(firstRepository), await realpath(secondRepository)].sort());
  // The live Open Projects menu focuses the existing destination, leaving the
  // caller's document and workspace in place instead of swapping repositories.
  await first.getByRole('button', { name: 'Project switcher', exact: true }).click();
  await first.getByRole('menuitem', { name: basename(secondRepository), exact: true }).click();
  await hideWindows();
  expect(application!.windows()).toHaveLength(2);
  await expect(first.getByRole('button', { name: 'Project switcher', exact: true })).toContainText(basename(firstRepository));
  expect(await layout(first)).toEqual(expectedLayout);
  await expectViewport(file(first, 2), secondFileViewport, 'Opening another repository preserves the first window');
  await chooseMode(second, 'Project');
  await second.getByRole('treeitem', { name: 'notes.ts', exact: true }).click();
  await expect(group(second, 1).getByTestId('file-surface')).toHaveAttribute('data-path', 'notes.ts');
  expect(await first.evaluate(async () => (await window.desktop.getLastRepository())!.repository.id)).toBe(firstIdentity.id);
  expect(firstIdentity.id).not.toBe(secondIdentity.id);

  // Changes and explicit refreshes stay with their owning window.
  await writeFile(join(secondRepository, 'second-only.ts'), 'export const secondOnly = true;\n');
  await chooseMode(second, 'Commit');
  await expect(second.getByRole('treeitem', { name: 'second-only.ts (untracked)', exact: true })).toBeVisible();
  await chooseMode(first, 'Commit');
  await first.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await expect(first.getByRole('treeitem', { name: 'second-only.ts (untracked)', exact: true })).toHaveCount(0);
  await writeFile(join(firstRepository, 'first-only.ts'), 'export const firstOnly = true;\n');
  await expect(first.getByRole('treeitem', { name: 'first-only.ts (untracked)', exact: true })).toBeVisible();
  await second.getByRole('button', { name: 'Refresh changes', exact: true }).click();
  await expect(second.getByRole('treeitem', { name: 'first-only.ts (untracked)', exact: true })).toHaveCount(0);
  // Switching sidebars may select the remembered document, so restore the exact
  // intended active tabs before taking the reload/restart checkpoint.
  await group(first, 1).getByRole('tab', { name: diffTab, exact: true }).click();
  await group(first, 2).getByRole('tab', { name: fileTab, exact: true }).click();
  await chooseMode(second, 'Project');
  await group(second, 1).getByRole('tab', { name: 'notes.ts', exact: true }).click();
  const persistedFirstLayout = await layout(first);
  const persistedSecondLayout = await layout(second);
  expect(persistedSecondLayout.groups[0].tabs).toEqual(['notes.ts', 'Commit: other.ts — working']);
  await expectViewport(file(first, 2), secondFileViewport, 'Before reload: split file after changing sidebars');
  const splitInstance = await group(first, 2).getByRole('tab', { name: fileTab, exact: true }).getAttribute('data-instance-id');
  await expect.poll(() => first.evaluate(async instance => {
    const repository = (await window.desktop.getLastRepository())!.repository;
    const session = await window.desktop.getWindowSessionId();
    const raw = localStorage.getItem(`smart-diff:editor-session:v1:${JSON.stringify([repository.path, session])}`);
    return raw && instance ? JSON.parse(raw).views?.[instance]?.file?.viewState?.scrollLeft ?? 0 : 0;
  }, splitInstance), { message: 'The split editor saves nonzero horizontal scroll before reload' }).toBeGreaterThan(0);

  async function verifyFirst(page: Page, phase: string) {
    await expect.poll(() => layout(page), { message: `${phase}: ordered tabs, selected tabs, group focus and split` }).toEqual(persistedFirstLayout);
    await expect(group(page, 1).locator('.smart-diff[data-status="ready"]')).toBeVisible();
    await expect(group(page, 1).getByRole('separator', { name: 'Resize diff panes', exact: true })).toHaveAttribute('aria-valuenow', '52');
    await expectViewport(diffSide(page, 'original'), originalViewport, `${phase}: original diff editor`);
    await expectViewport(diffSide(page, 'modified'), modifiedViewport, `${phase}: modified diff editor`);
    await expectViewport(file(page, 2), secondFileViewport, `${phase}: independent split file editor`);
    await group(page, 1).getByRole('tab', { name: 'notes.ts', exact: true }).click();
    await expectViewport(file(page, 1), notesViewport, `${phase}: inactive notes editor`);
    await group(page, 1).getByRole('tab', { name: fileTab, exact: true }).click();
    await expectViewport(file(page, 1), firstFileViewport, `${phase}: inactive primary file editor`);
    await group(page, 1).getByRole('tab', { name: diffTab, exact: true }).click();
    await group(page, 2).getByRole('tab', { name: fileTab, exact: true }).click();
    await expect.poll(() => layout(page)).toEqual(persistedFirstLayout);
  }

  await first.reload();
  expect(await first.evaluate(() => window.desktop.getWindowSessionId())).toBe(firstSessionId);
  await verifyFirst(first, 'Renderer reload');
  expect(await layout(second)).toEqual(persistedSecondLayout);
  expect(await readFile(join(firstRepository, fileTab), 'utf8')).toBe(initialContents);
  await expect(first.getByRole('img', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
  console.log('PASS: new repository windows, independent watchers/refreshes, hidden editor remount, renderer reload, tab order, selected tabs, splits and editor positions');

  await application!.close();
  application = undefined;
  await launch();
  const restoredFirst = await waitForRepository(await realpath(firstRepository));
  const restoredSecond = await waitForRepository(await realpath(secondRepository));
  await hideWindows();
  const restoredIdentity = await restoredFirst.evaluate(async () => (await window.desktop.getLastRepository())!.repository);
  expect(restoredIdentity.id).not.toBe(firstIdentity.id);
  expect((await restoredSecond.evaluate(async () => (await window.desktop.getLastRepository())!.repository)).id).not.toBe(secondIdentity.id);
  expect(await restoredFirst.evaluate(() => window.desktop.getWindowSessionId())).toBe(firstSessionId);
  expect(await restoredSecond.evaluate(() => window.desktop.getWindowSessionId())).toBe(secondSessionId);
  await verifyFirst(restoredFirst, 'Application restart');
  await expect.poll(() => layout(restoredSecond)).toEqual(persistedSecondLayout);
  await expect(group(restoredSecond, 1).getByTestId('file-surface')).toHaveAttribute('data-path', 'notes.ts');
  await writeFile(join(firstRepository, 'restarted-only.ts'), 'export const restarted = true;\n');
  await expect(restoredFirst.getByRole('treeitem', { name: 'restarted-only.ts (untracked)', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('PASS: application restart restores both repository windows and workspaces with fresh repository capabilities; no renderer errors');
} finally {
  if (application) {
    // Failed assertions must not strand a hidden window or an unexpected draft.
    await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await application.close().catch(() => {});
  }
  await rm(directory, { recursive: true, force: true });
}
