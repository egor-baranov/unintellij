/** Real project-switcher behavior and appearance in a disposable, hidden Electron app.
 * Build the production desktop first. Nothing in a user repository/profile is changed. */
import { _electron as electron, expect as baseExpect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 20000 });
const run = promisify(execFile);
// Keeping fixtures under the home directory exercises the actual backend's ~/ abbreviation.
const temporary = await mkdtemp(join(homedir(), '.smart-diff-picker-'));
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/project-picker');
const names = ['unintellij', 'nebo', 'platform-no-code'];
const paths = names.map(name => join(temporary, name));
const errors: string[] = [], checks: string[] = [], screenshots: string[] = [];
await Promise.all([mkdir(profile), mkdir(artifacts, { recursive: true }), ...paths.map(async path => {
  await mkdir(path);
  const git = (...args: string[]) => run('git', ['-C', path, ...args], { shell: false });
  await git('init', '-q', '-b', 'main');
  await writeFile(join(path, 'sample.ts'), 'export const project = "Project switcher fixture";\n');
  await git('add', '.');
  await git('-c', 'user.name=Picker smoke', '-c', 'user.email=picker@example.invalid', 'commit', '-qm', 'Disposable project');
})]);

const bootstrap = join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
global.__pickerFocusIds = [];
BrowserWindow.prototype.show = function () { this.webContents.setBackgroundThrottling(false); this.hide(); };
BrowserWindow.prototype.focus = function () { global.__pickerFocusIds.push(this.id); };
app.on('browser-window-created', (_event, window) => {
  window.setOpacity(0); window.setIgnoreMouseEvents(true); window.setFocusable(false);
  window.webContents.setBackgroundThrottling(false);
});
require(${JSON.stringify(resolve('apps/desktop/dist/index.cjs'))});
`);
const application = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], env: { ...process.env, SMART_DIFF_DEV_URL: '' } });
const track = (page: Page) => page.on('pageerror', error => errors.push(error.stack ?? error.message));
application.windows().forEach(track);
application.on('window', track);
const pass = (message: string) => { checks.push(message); console.log(`PASS: ${message}`); };
const trigger = (page: Page) => page.getByRole('button', { name: 'Project switcher', exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Project switcher', exact: true });
const item = (page: Page, name: string) => menu(page).getByRole('menuitem', { name, exact: true });
const openMenu = async (page: Page) => {
  if (await trigger(page).getAttribute('aria-expanded') !== 'true') await trigger(page).click();
  await expect(menu(page)).toBeVisible();
};
const choose = async (origin: Page, path: string, welcome = false) => {
  await application.evaluate(({ dialog }, chosenPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosenPath] });
  }, path);
  const page = await openRepositoryWindow(application, async () => {
    if (welcome) await origin.getByRole('button', { name: 'Open…', exact: true }).click();
    else { await openMenu(origin); await item(origin, 'Open…').click(); }
  });
  await expect(trigger(page)).toContainText(basename(path));
  await expect(page.locator('.project-loading-screen')).toHaveCount(0);
  return page;
};
const capture = async (page: Page, name: string) => {
  const window = await application.browserWindow(page);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await window.evaluate(window => window.showInactive());
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const image = await Promise.race([
      captureWindow(application, page),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Capture timed out')), 10000); }),
    ]);
    await writeFile(join(artifacts, name), image);
    screenshots.push(name);
  } finally {
    clearTimeout(deadline);
    await window.evaluate(window => window.hide());
    await window.dispose();
  }
};

try {
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(await realpath(profile));
  const welcome = await application.firstWindow();
  const first = await choose(welcome, paths[0], true);
  const second = await choose(first, paths[1]);
  const recent = await choose(second, paths[2]);
  const closed = await application.browserWindow(recent);
  await closed.evaluate(window => window.close());
  await closed.dispose();
  await expect.poll(() => recent.isClosed()).toBe(true);
  await expect.poll(() => application.windows().length).toBe(2);
  const native = await application.browserWindow(second);
  await native.evaluate(window => window.setContentSize(1440, 900));
  await openMenu(second);
  await expect(menu(second).locator('.ui-menu-label')).toHaveText(['Open Projects', 'Recent Projects']);
  await expect(menu(second).getByRole('menuitem')).toHaveText([
    'New Project…', 'Open…', 'Clone Repository…',
    /unintellij.*~\//, /nebo.*~\//, /platform-no-code.*~\//,
  ]);
  for (const name of names) await expect(item(second, name)).toHaveCount(1);
  await expect(item(second, 'New Project…')).toBeEnabled();
  await expect(item(second, 'Clone Repository…')).toBeEnabled();
  await expect(menu(second).getByRole('menuitem', { name: /Project files|Commit changes/ })).toHaveCount(0);
  const roles = await menu(second).locator('.ui-menu-label, .project-picker-entry').evaluateAll(nodes => nodes.map(node => node.classList.contains('ui-menu-label') ? node.textContent : node.getAttribute('aria-label')));
  expect(roles).toEqual(['Open Projects', 'unintellij', 'nebo', 'Recent Projects', 'platform-no-code']);
  pass('Native Open… opens separate project windows; open projects and closed recent projects are grouped without duplicates.');
  pass('Real home-relative paths, project initials, New Project…, Open…, and Clone Repository… are displayed; workspace-mode actions are absent.');

  // A normal open starts on the first action; keyboard navigation remains in the popup.
  await expect(item(second, 'New Project…')).toBeFocused();
  await capture(second, 'project-picker-action.png');
  await second.keyboard.press('ArrowDown');
  await expect(item(second, 'Open…')).toBeFocused();
  await second.keyboard.press('ArrowDown');
  await expect(item(second, 'Clone Repository…')).toBeFocused();
  await second.keyboard.press('Escape');
  await expect(menu(second)).toHaveCount(0);
  await expect(trigger(second)).toBeFocused();
  pass('Arrow keys navigate menu actions and Escape closes the popup and restores focus.');

  await openMenu(second);
  await item(second, 'Clone Repository…').click();
  const clone = second.getByRole('dialog', { name: 'Clone Repository', exact: true });
  await expect(clone).toBeVisible();
  await expect(clone.getByRole('textbox', { name: 'Repository URL', exact: true })).toBeFocused();
  await expect(clone.getByRole('button', { name: 'Choose destination…', exact: true })).toBeDisabled();
  await clone.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(clone).toHaveCount(0);
  expect(application.windows()).toHaveLength(2);
  pass('Clone Repository… opens its focused URL dialog; cancellation does not create a window or start a clone.');

  await openMenu(second);
  await item(second, 'nebo').hover();
  await expect(item(second, 'nebo')).toHaveClass(/is-active/);
  await capture(second, 'project-picker-project.png');
  const geometry = await menu(second).evaluate(node => {
    const outer = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      width: outer.width, radius: style.borderTopLeftRadius,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bounds: { left: outer.left, right: outer.right, top: outer.top, bottom: outer.bottom },
      rows: [...node.querySelectorAll<HTMLElement>('.ui-menu-item')].map(row => {
        const rect = row.getBoundingClientRect();
        return { label: row.getAttribute('aria-label'), left: rect.left, right: rect.right, radius: getComputedStyle(row).borderTopLeftRadius };
      }),
    };
  });
  expect(parseFloat(geometry.radius)).toBeGreaterThan(4);
  for (const row of geometry.rows) {
    expect(row.left).toBeGreaterThan(geometry.bounds.left);
    expect(row.right).toBeLessThan(geometry.bounds.right);
    expect(parseFloat(row.radius)).toBeGreaterThan(0);
  }
  expect(geometry.bounds.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  const pathsFit = await menu(second).locator('.ui-menu-description').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node);
    const row = node.closest('.project-picker-entry')!;
    return { ellipsis: style.textOverflow, noWrap: style.whiteSpace, right: node.getBoundingClientRect().right, rowRight: row.getBoundingClientRect().right };
  }));
  for (const path of pathsFit) {
    expect(path.ellipsis).toBe('ellipsis');
    expect(path.noWrap).toBe('nowrap');
    expect(path.right).toBeLessThanOrEqual(path.rowRight);
  }

  const firstNative = await application.browserWindow(first);
  const firstId = await firstNative.evaluate(window => window.id);
  await firstNative.dispose();
  await application.evaluate(() => { (globalThis as typeof globalThis & { __pickerFocusIds: number[] }).__pickerFocusIds = []; });
  await item(second, 'unintellij').click();
  await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & { __pickerFocusIds: number[] }).__pickerFocusIds)).toContain(firstId);
  expect(application.windows()).toHaveLength(2);
  await expect(trigger(second)).toContainText('nebo');
  pass('Choosing an open project focuses its existing native window without switching or duplicating the caller.');

  await native.evaluate(window => window.setContentSize(760, 520));
  await openMenu(second);
  await item(second, 'platform-no-code').hover();
  const narrowBounds = await menu(second).evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: window.innerWidth, height: window.innerHeight };
  });
  expect(narrowBounds.left).toBeGreaterThanOrEqual(0);
  expect(narrowBounds.right).toBeLessThanOrEqual(narrowBounds.width);
  expect(narrowBounds.top).toBeGreaterThanOrEqual(0);
  expect(narrowBounds.bottom).toBeLessThanOrEqual(narrowBounds.height);
  await capture(second, 'project-picker-narrow.png');
  pass('Rounded popup and row insets fit inside both normal and narrow application viewports.');

  const reopened = await openRepositoryWindow(application, () => item(second, 'platform-no-code').click());
  await expect(trigger(reopened)).toContainText('platform-no-code');
  await expect.poll(() => application.windows().length).toBe(3);
  await openMenu(second);
  await expect(item(second, 'platform-no-code')).toHaveCount(1);
  await expect(menu(second).getByText('Recent Projects', { exact: true })).toHaveCount(0);
  pass('A closed recent project opens a new window, then moves into Open Projects without a duplicate recent row.');
  await second.keyboard.press('Escape');
  await native.dispose();
  expect(errors).toEqual([]);
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ checks, screenshots, geometry, narrowBounds, errors }, null, 2));
  console.log(`Project picker smoke passed. Screenshots: ${artifacts}`);
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
