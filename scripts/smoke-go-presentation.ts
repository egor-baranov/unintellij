/** Production Go presentation check with real files in a disposable Git repository. */
import { _electron as electron, expect as baseExpect, type Locator } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 20000 });
const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-go-'));
const repository = join(temporary, 'go-presentation');
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/go-presentation');
await Promise.all([mkdir(repository), mkdir(profile), mkdir(artifacts, { recursive: true })]);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const source = (value: number) => `package greeting

import "fmt"

// Greeting formats the current answer.
func Greeting() string {
    answer := ${value}
    return fmt.Sprintf("hello %d", answer)
}
`;
const test = (value: number) => `package greeting

import "testing"

// TestGreeting checks a real Go function.
func TestGreeting(t *testing.T) {
    want := "hello ${value}"
    if got := Greeting(); got != want {
        t.Errorf("got %q, want %q", got, want)
    }
}
`;
await git('init', '-q', '-b', 'main');
await Promise.all([
  writeFile(join(repository, 'go.mod'), 'module example.invalid/greeting\n\ngo 1.22\n'),
  writeFile(join(repository, 'greeting.go'), source(1)),
  writeFile(join(repository, 'greeting_test.go'), test(1)),
  writeFile(join(repository, 'notes_test.go.txt'), 'An ordinary text file.\n'),
  mkdir(join(repository, 'folder_test.go')),
]);
await writeFile(join(repository, 'folder_test.go', 'keep.txt'), 'An ordinary directory.\n');
await git('add', '.');
await git('-c', 'user.name=Go smoke', '-c', 'user.email=go-smoke@example.invalid', 'commit', '-qm', 'Go fixture');
await Promise.all([
  writeFile(join(repository, 'greeting.go'), source(42)),
  writeFile(join(repository, 'greeting_test.go'), test(42)),
]);

// Suppress showing/focusing this disposable app before its first renderer starts.
const bootstrap = join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
BrowserWindow.prototype.show = function () { this.webContents.setBackgroundThrottling(false); this.hide(); };
BrowserWindow.prototype.focus = function () {};
app.on('browser-window-created', (_event, window) => {
  window.setOpacity(0); window.setIgnoreMouseEvents(true); window.setFocusable(false);
  window.webContents.setBackgroundThrottling(false);
});
require(${JSON.stringify(resolve('apps/desktop/dist/index.cjs'))});
`);
const application = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], env: { ...process.env, SMART_DIFF_DEV_URL: '' } });
const errors: string[] = [];
try {
  const welcome = await application.firstWindow();
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repository);
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  const nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(window => window.setContentSize(1440, 900));
  const capture = async (name: string) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await nativeWindow.evaluate(window => window.showInactive());
      // Playwright centers max-content tree rows when clicking; keep the
      // captured tree at its normal left edge rather than its path annotation.
      await page.locator('.project-tree').evaluateAll(elements => elements.forEach(element => { element.scrollLeft = 0; }));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const png = await Promise.race([
        captureWindow(application, page),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Capture timed out')), 10000); }),
      ]);
      await writeFile(join(artifacts, name), png);
    } finally {
      clearTimeout(deadline);
      await nativeWindow.evaluate(window => window.hide());
    }
  };
  const background = (row: Locator) => row.evaluate(node => getComputedStyle(node).backgroundColor);
  const foreground = (row: Locator, selector: string) => row.locator(selector).evaluate(node => getComputedStyle(node).color);
  const tokenColors = (view: Locator) => view.locator('.view-lines').evaluate(node => [...new Set([...node.querySelectorAll('span[class*="mtk"]')]
    .filter(span => span.textContent?.trim()).map(span => getComputedStyle(span).color))]);
  const expectGoColors = async (view: Locator) => {
    await expect(view.locator('.view-lines')).toContainText('package');
    await expect.poll(async () => (await tokenColors(view)).length).toBeGreaterThanOrEqual(4);
  };
  const viewButtons = page.getByRole('group', { name: 'Workspace view', exact: true });
  const chooseView = async (name: 'Project' | 'Commit') => {
    const button = viewButtons.getByRole('button', { name, exact: true });
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  };
  await chooseView('Commit');
  const commitSource = page.getByRole('treeitem', { name: 'greeting.go (working)', exact: true });
  const commitTest = page.getByRole('treeitem', { name: 'greeting_test.go (working)', exact: true });
  await commitSource.click();
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await expect(commitSource.locator('[data-icon="file-go"]')).toBeVisible();
  await expect(commitTest.locator('[data-icon="file-go-test"]')).toBeVisible();
  const testBackground = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tree-test-background').trim());
  expect(testBackground).toMatch(/^#/);
  const cssColor = await page.evaluate(value => { const node = document.createElement('span'); node.style.color = value; document.body.append(node); const color = getComputedStyle(node).color; node.remove(); return color; }, testBackground);
  await expect.poll(() => background(commitTest)).toBe(cssColor);
  expect(await foreground(commitTest, '.commit-node-name')).toBe(await foreground(commitSource, '.commit-node-name'));
  await expectGoColors(page.locator('[data-side="original"]'));
  await expectGoColors(page.locator('[data-side="modified"]'));
  await capture('commit-go-diff.png');
  await commitTest.click();
  expect(await background(commitTest)).not.toBe(cssColor);
  await expect(page.locator('[data-side="modified"] .view-lines')).toContainText('TestGreeting');
  await capture('selected-go-test.png');

  await chooseView('Project');
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  const row = (path: string) => tree.getByRole('treeitem', { name: path, exact: true });
  await row('greeting.go').click();
  const editor = page.getByTestId('file-surface');
  await expect(editor).toHaveAttribute('data-path', 'greeting.go');
  await expectGoColors(editor);
  await expect(row('greeting_test.go').locator('[data-icon="file-go-test"]')).toBeVisible();
  await expect.poll(() => background(row('greeting_test.go'))).toBe(cssColor);
  expect(await background(row('folder_test.go'))).not.toBe(cssColor);
  expect(await background(row('notes_test.go.txt'))).not.toBe(cssColor);
  await capture('project-go-editor.png');

  // The existing scope preference controls both trees without altering Git colors.
  await page.getByRole('button', { name: 'Project view options', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Scope backgrounds', exact: true }).click();
  await expect.poll(() => background(row('greeting_test.go'))).not.toBe(cssColor);
  await chooseView('Commit');
  await commitSource.click();
  await expect.poll(() => background(commitTest)).not.toBe(cssColor);

  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+f`);
  const dialog = page.getByRole('dialog', { name: 'Find in Files', exact: true });
  await dialog.getByRole('searchbox', { name: 'Search text', exact: true }).fill('want :=');
  await dialog.getByRole('option').first().click();
  const preview = dialog.locator('.find-preview-editor');
  await expectGoColors(preview);
  await expect(dialog.locator('.find-preview-name')).toHaveText('greeting_test.go');
  await expect.poll(() => dialog.locator('.find-result-snippet').first().evaluate(node => new Set([...node.querySelectorAll('span')].map(span => getComputedStyle(span).color)).size)).toBeGreaterThanOrEqual(2);
  await capture('search-go-preview.png');
  expect(errors).toEqual([]);
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ checks: ['Go and Go test icons', 'Go test scope in Commit and Project', 'selection overrides scope', 'Git foreground preserved', 'non-test paths stay ordinary', 'scope preference applies to both trees', 'Go syntax in both diff panes, file editor, search rows and preview'], errors }, null, 2));
  await nativeWindow.dispose();
  console.log(`Go presentation checks passed. Screenshots: ${artifacts}`);
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
