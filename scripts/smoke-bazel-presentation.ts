/** Real-file production Electron check for Bazel syntax and icons in every editor surface. */
import { _electron as electron, expect as baseExpect, type Locator } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 20000 });
const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-bazel-'));
const repository = join(temporary, 'bazel-presentation');
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/bazel-presentation');
await Promise.all([mkdir(repository), mkdir(profile), mkdir(artifacts, { recursive: true })]);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const build = (replicas: number) => `# Local Bazel fixture; this check never runs a build.
load(":rules.bzl", "service_binary")

package(default_visibility = ["//visibility:public"])

service_binary(
    name = "sample_service",
    srcs = glob(["*.cc"]),
    replicas = ${replicas},
    testonly = False,
)
`;
const rules = `# A local Starlark macro with several token categories.
def service_binary(name, srcs = [], replicas = 1, testonly = False):
    """Create one local service target."""
    outputs = ["service_%s.txt" % n for n in range(replicas)]
    if not outputs:
        fail("Expected at least one service")
    native.genrule(
        name = name,
        srcs = srcs,
        outs = outputs,
        cmd = "echo service > $@",
        testonly = testonly,
    )
`;
const workspace = `# The legacy Bazel workspace declaration.
workspace(name = "bazel_presentation")

local_repository(
    name = "local_tools",
    path = "tools",
)
`;
const moduleSource = `# Modern Bazel module metadata; no dependency is fetched.
module(
    name = "bazel_presentation",
    version = "1.0.0",
    compatibility_level = 1,
)

bazel_dep(name = "rules_cc", version = "0.0.17")
`;
await git('init', '-q', '-b', 'main');
await Promise.all([
  writeFile(join(repository, 'BUILD.bazel'), build(1)),
  writeFile(join(repository, 'BUILD'), build(3)),
  writeFile(join(repository, 'WORKSPACE'), workspace),
  writeFile(join(repository, 'WORKSPACE.bazel'), workspace),
  writeFile(join(repository, 'MODULE.bazel'), moduleSource),
  writeFile(join(repository, 'rules.bzl'), rules),
]);
await git('add', '.');
await git('-c', 'user.name=Bazel smoke', '-c', 'user.email=bazel-smoke@example.invalid', 'commit', '-qm', 'Bazel fixture');
await Promise.all([
  writeFile(join(repository, 'BUILD.bazel'), build(2)),
  writeFile(join(repository, 'added.bzl'), rules),
]);
const originalHead = (await git('rev-parse', 'HEAD')).stdout;
const originalStatus = (await git('status', '--porcelain=v1')).stdout;

// Keep this disposable app hidden/non-focusable from before its first window.
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
const colors: Record<string, string[]> = {};
const icons: Record<string, { src: string; width: number; height: number }> = {};
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
  const tokenColors = (view: Locator) => view.locator('.view-lines').evaluate(node => [...new Set([...node.querySelectorAll('span[class*="mtk"]')]
    .filter(span => span.textContent?.trim()).map(span => getComputedStyle(span).color))]);
  const checkColors = async (view: Locator, key: string, text: string, minimum = 4) => {
    await expect(view.locator('.view-lines')).toContainText(text);
    await expect.poll(async () => (await tokenColors(view)).length).toBeGreaterThanOrEqual(minimum);
    colors[key] = await tokenColors(view);
  };
  const checkIcon = async (row: Locator, key: string) => {
    const icon = row.locator('img.jb-icon[data-icon="file-bazel"]');
    await expect(icon).toBeVisible();
    const image = await icon.evaluate(async element => {
      const image = element as HTMLImageElement;
      await image.decode();
      return { src: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight };
    });
    expect(image.src).toMatch(/^app:\/\/smart-diff\/assets\/file-bazel[^/]*\.svg$/);
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
    icons[key] = image;
  };
  const checkNoSourceHeaders = async () => {
    await expect(page.locator('.source-headers')).toHaveCount(0);
    const content = page.locator('.workspace-tab-content');
    await expect(content.getByText('HEAD', { exact: true })).toHaveCount(0);
    await expect(content.getByText('Working tree', { exact: true })).toHaveCount(0);
  };
  const viewButtons = page.getByRole('group', { name: 'Workspace view', exact: true });
  const chooseView = async (name: 'Project' | 'Commit') => {
    const button = viewButtons.getByRole('button', { name, exact: true });
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  };

  await chooseView('Commit');
  const modifiedRow = page.getByRole('treeitem', { name: 'BUILD.bazel (working)', exact: true });
  await modifiedRow.click();
  await checkIcon(modifiedRow, 'diff-BUILD.bazel');
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await checkColors(page.locator('[data-side="original"]'), 'diff-original', 'service_binary');
  await checkColors(page.locator('[data-side="modified"]'), 'diff-modified', 'service_binary');
  await checkNoSourceHeaders();
  await capture('bazel-diff.png');

  const addedRow = page.getByRole('treeitem', { name: 'added.bzl (untracked)', exact: true });
  await addedRow.click();
  await checkIcon(addedRow, 'added.bzl');
  const editor = page.getByTestId('file-surface');
  await expect(editor).toHaveAttribute('data-path', 'added.bzl');
  await expect(editor).toHaveAttribute('data-added', 'true');
  await expect(page.locator('.smart-diff')).toHaveCount(0);
  await checkColors(editor, 'added-file', 'service_binary');
  await expect(editor.locator('.added-file-line')).toHaveCount(rules.trimEnd().split('\n').length);
  const addedBackgrounds = await editor.locator('.added-file-line, .added-file-margin').evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).backgroundColor))]);
  expect(addedBackgrounds).toHaveLength(1);
  const [red, green, blue] = addedBackgrounds[0].match(/[\d.]+/g)!.map(Number);
  expect(green).toBeGreaterThan(red);
  expect(green).toBeGreaterThan(blue);
  await checkNoSourceHeaders();
  await capture('bazel-added.png');

  await chooseView('Project');
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  for (const [file, text, minimum] of [
    ['BUILD', 'service_binary', 4],
    ['BUILD.bazel', 'service_binary', 4],
    ['WORKSPACE', 'bazel_presentation', 3],
    ['WORKSPACE.bazel', 'bazel_presentation', 3],
    ['MODULE.bazel', 'compatibility_level', 4],
    ['rules.bzl', 'service_binary', 4],
  ] as const) {
    const row = tree.getByRole('treeitem', { name: file, exact: true });
    await row.click();
    await checkIcon(row, `project-${file}`);
    await expect(editor).toHaveAttribute('data-path', file);
    await expect(editor).not.toHaveAttribute('data-added', 'true');
    await checkColors(editor, file, text, minimum);
    await checkNoSourceHeaders();
    await capture(`project-${file}.png`);
  }

  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+f`);
  const dialog = page.getByRole('dialog', { name: 'Find in Files', exact: true });
  await dialog.getByRole('searchbox', { name: 'Search text', exact: true }).fill('service_binary');
  for (const file of ['BUILD.bazel', 'rules.bzl']) {
    const result = dialog.locator(`.find-result-row[data-path="${file}"]`).first();
    await result.click();
    await checkColors(dialog.locator('.find-preview-editor'), `search-preview-${file}`, 'service_binary');
    // Exclude the match <mark>: distinct colors must come from syntax itself.
    const snippetColors = () => result.locator('.find-result-snippet').evaluate(node => [...new Set([...node.querySelectorAll('.find-snippet-token')]
      .filter(span => span.textContent?.trim()).map(span => getComputedStyle(span).color))]);
    await expect.poll(async () => (await snippetColors()).length).toBeGreaterThanOrEqual(2);
    colors[`search-snippet-${file}`] = await snippetColors();
    await capture(`bazel-search-${file}.png`);
  }
  expect(errors).toEqual([]);
  expect((await git('rev-parse', 'HEAD')).stdout).toBe(originalHead);
  expect((await git('status', '--porcelain=v1')).stdout).toBe(originalStatus);
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({
    checks: ['Bazel original and modified diff panes', 'Full green added Starlark editor', 'BUILD and BUILD.bazel ordinary editors', 'WORKSPACE and WORKSPACE.bazel ordinary editors', 'MODULE.bazel ordinary editor', '.bzl ordinary editor', 'Decoded bundled Bazel icons in Commit and Project trees', 'Find in Files syntax in BUILD.bazel and .bzl snippets and previews', 'No HEAD/Working tree header row', 'Fixture HEAD and working changes preserved'],
    colors, icons, addedBackgrounds, errors,
  }, null, 2));
  await nativeWindow.dispose();
  console.log(`Bazel presentation checks passed. Screenshots: ${artifacts}`);
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
