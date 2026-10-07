/** Production YAML/Helm highlighting regression. Build desktop before running. */
import { _electron as electron, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 25000 });
const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-yaml-'));
const repository = join(temporary, 'yaml-fixture');
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/yaml');
await Promise.all([mkdir(repository), mkdir(profile), mkdir(artifacts, { recursive: true })]);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const chart = `# A plain YAML chart descriptor.
apiVersion: v2
name: sample-chart
version: "1.2.3"
appVersion: "2.0"
type: application
`;
const values = (count: number) => `# Ordinary .yml syntax.
replicas: ${count}
enabled: true
mode: "identity"
image:
  repository: example.local/worker
  tag: "1.0"
ports: [8080, 8081]
message: "yaml_smoke_marker" # a search syntax probe
`;
const helm = `{{- if not (has .Values.mode (list "identity" "rollout")) -}}
{{- fail "mode must be identity or rollout" -}}
{{- end -}}
{{- if gt (int .Values.timeoutSeconds) 3600 -}}
{{- fail "timeoutSeconds must be at most 3600" -}}
{{- end -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .Release.Name }}
automountServiceAccountToken: true
---
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ printf "%s-check" .Release.Name | quote }}
spec:
  backoffLimit: 0
  activeDeadlineSeconds: {{ add (int .Values.timeoutSeconds) 30 }}
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: check
          image: {{ .Values.image.repository | quote }}
          env:
            - name: MODE
              value: "{{ .Values.mode }}"
`;
const files = new Map<string, string>([
  ['Chart.yaml', chart], ['values.yml', values(1)], ['000-search-first.txt', 'yaml_smoke_marker\n'],
]);
const write = async (path: string, content: string) => {
  await mkdir(dirname(join(repository, path)), { recursive: true });
  await writeFile(join(repository, path), content);
};
await git('init', '-q', '-b', 'main');
await Promise.all([...files].map(([path, content]) => write(path, content)));
await git('add', '.');
await git('-c', 'user.name=YAML smoke', '-c', 'user.email=yaml-smoke@example.invalid', 'commit', '-qm', 'YAML fixture');
files.set('values.yml', values(3));
files.set('chart/templates/check.yaml', helm);
await Promise.all([...files].map(([path, content]) => write(path, content)));
const originalHead = (await git('rev-parse', 'HEAD')).stdout;
const originalStatus = (await git('status', '--porcelain=v1')).stdout;
const bootstrap = join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
global.__yamlSmokeErrors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (details) => {
    if (details.level === 'error') global.__yamlSmokeErrors.push(details.message);
  });
  contents.on('render-process-gone', (_event, details) => global.__yamlSmokeErrors.push(details.reason));
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame) global.__yamlSmokeErrors.push(description + ': ' + url);
  });
});
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
const evidence: Record<string, unknown> = {};
let phase = 'opening';
let projectPage: Page | undefined;
const observe = (page: Page) => page.on('pageerror', error => errors.push(error.stack ?? error.message));
application.on('window', observe);
for (const page of application.windows()) observe(page);
const startupErrors = () => application.evaluate(() => (globalThis as unknown as { __yamlSmokeErrors: string[] }).__yamlSmokeErrors);

try {
  const welcome = await application.firstWindow();
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repository);
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  projectPage = page;
  const window = await application.browserWindow(page);
  await window.evaluate(window => window.setContentSize(1440, 1000));
  const capture = async (name: string) => {
    try {
      await window.evaluate(window => window.showInactive());
      await page.locator('.project-tree').evaluateAll(elements => elements.forEach(element => { element.scrollLeft = 0; }));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await writeFile(join(artifacts, name), await captureWindow(application, page));
    } finally { await window.evaluate(window => window.hide()); }
  };
  const chooseView = async (name: 'Project' | 'Commit') => {
    const button = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name, exact: true });
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  };
  const paintedColor = (view: Locator, text: string) => view.locator('.view-lines').evaluate((node, text) => {
    for (const row of node.querySelectorAll('.view-line')) {
      const full = (row.textContent ?? '').replaceAll('\u00a0', ' ');
      const target = full.indexOf(text);
      if (target < 0) continue;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let offset = 0;
      while (walker.nextNode()) {
        const length = walker.currentNode.textContent?.length ?? 0;
        if (target >= offset && target < offset + length) return getComputedStyle(walker.currentNode.parentElement!).color;
        offset += length;
      }
    }
    return undefined;
  }, text);
  const colors = { key: 'rgb(255, 203, 107)', string: 'rgb(195, 232, 141)', keyword: 'rgb(192, 133, 255)', operator: 'rgb(137, 221, 255)' };
  const check = async (view: Locator, name: string, probes: [string, string][]) => {
    phase = name;
    const result: Record<string, string | undefined> = {};
    for (const [text, color] of probes) {
      await expect.poll(() => paintedColor(view, text), { message: `${name}: painted ${text}` }).toBe(color);
      result[text] = await paintedColor(view, text);
    }
    evidence[name] = result;
  };

  await chooseView('Project');
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  const editor = page.getByTestId('file-surface');
  await tree.getByRole('treeitem', { name: 'Chart.yaml', exact: true }).click();
  await expect(editor).toHaveAttribute('data-path', 'Chart.yaml');
  await check(editor, 'ordinary-chart', [['apiVersion', colors.key], ['v2', colors.string], [':', colors.operator]]);
  await capture('plain-yaml.png');

  await chooseView('Commit');
  await page.getByRole('treeitem', { name: 'values.yml (working)', exact: true }).click();
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  for (const side of ['original', 'modified']) {
    await check(page.locator(`[data-side="${side}"]`), `diff-${side}`, [['replicas', colors.key], ['true', colors.keyword], ['"identity"', colors.string]]);
  }
  await capture('yaml-diff.png');

  await page.getByRole('button', { name: 'Expand all folders', exact: true }).click();
  await page.getByRole('treeitem', { name: 'chart/templates/check.yaml (untracked)', exact: true }).click();
  await expect(editor).toHaveAttribute('data-path', 'chart/templates/check.yaml');
  await expect(editor).toHaveAttribute('data-added', 'true');
  await check(editor, 'added-helm', [['if', colors.keyword], ['"identity"', colors.string], ['3600', colors.key], ['apiVersion', colors.key], ['true', colors.keyword], ['---', colors.operator]]);
  const backgrounds = await editor.locator('.added-file-line').evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).backgroundColor))]);
  expect(backgrounds).toHaveLength(1);
  const [red, green, blue] = backgrounds[0].match(/[\d.]+/g)!.map(Number);
  expect(green).toBeGreaterThan(red);
  expect(green).toBeGreaterThan(blue);
  evidence.addedBackgrounds = backgrounds;
  await capture('helm-added.png');

  phase = 'search';
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+f`);
  const dialog = page.getByRole('dialog', { name: 'Find in Files', exact: true });
  await dialog.getByRole('searchbox', { name: 'Search text', exact: true }).fill('yaml_smoke_marker');
  const result = dialog.locator('.find-result-row[data-path="values.yml"]').first();
  await expect(result).toBeVisible();
  await expect(dialog.locator('.find-preview-name')).toHaveText('000-search-first.txt');
  await expect(result).toHaveAttribute('aria-selected', 'false');
  const snippetColors = () => result.locator('.find-result-snippet').evaluate(node => [...new Set([...node.querySelectorAll('.find-snippet-token')]
    .filter(span => span.textContent?.trim() && !span.closest('mark')).map(span => getComputedStyle(span).color))]);
  await expect.poll(snippetColors).toContain(colors.key);
  await expect.poll(snippetColors).toContain(colors.operator);
  evidence.searchSnippet = await snippetColors();
  await result.click();
  await check(dialog.locator('.find-preview-editor'), 'search-preview', [['message', colors.key], ['true', colors.keyword], ['"identity"', colors.string]]);
  await capture('yaml-search.png');

  phase = 'final verification';
  expect(errors).toEqual([]);
  expect(await startupErrors()).toEqual([]);
  expect((await git('rev-parse', 'HEAD')).stdout).toBe(originalHead);
  expect((await git('status', '--porcelain=v1')).stdout).toBe(originalStatus);
  for (const [path, content] of files) expect(await readFile(join(repository, path), 'utf8'), path).toBe(content);
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ checks: ['Plain YAML normal editor', 'Both YAML comparison panes', 'Helm control statements, quoted strings, numbers, YAML keys and document separator', 'Green added-file background preserved', 'Search snippet and preview syntax', 'Temporary repository HEAD, status and contents preserved'], evidence, errors: [] }, null, 2));
  await Promise.all(['failure.json', 'failure.png'].map(name => rm(join(artifacts, name), { force: true })));
  await window.dispose();
  console.log(`YAML checks passed. Screenshots: ${artifacts}`);
} catch (error) {
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ phase, error: String(error), evidence, errors, startupErrors: await startupErrors().catch(() => []) }, null, 2));
  if (projectPage && !projectPage.isClosed()) await writeFile(join(artifacts, 'failure.png'), await captureWindow(application, projectPage)).catch(() => {});
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
