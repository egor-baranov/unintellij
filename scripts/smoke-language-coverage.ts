/** Production Electron language/icon coverage in a disposable repository. Build desktop first. */
import { _electron as electron, expect as baseExpect, type Locator, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 25000 });
const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-language-coverage-'));
const repository = join(temporary, 'language-coverage');
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/language-coverage');
await Promise.all([mkdir(repository), mkdir(profile), mkdir(artifacts, { recursive: true })]);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });

interface Sample { path: string; source: string; text: string; icon: string; minimum?: number }
const samples: Sample[] = [
  { path: 'main.cpp', icon: 'file', text: 'std::string', source: '#include <string>\n// C++ source\nconstexpr int retries = 3;\nint main() {\n    const std::string name = "local";\n    return retries > 0 ? 0 : 1;\n}\n' },
  { path: 'Main.java', icon: 'file-java', text: 'class Main', source: '// Java source\npublic class Main {\n    private static final int RETRIES = 3;\n    public static String greeting() {\n        return "Hello from Java";\n    }\n}\n' },
  { path: 'Main.kt', icon: 'file-kotlin', text: 'fun main', source: '// Kotlin source\ndata class Service(val name: String, val port: Int = 8080)\nfun main() {\n    val service = Service("local")\n    println(service.name)\n}\n' },
  { path: 'Program.cs', icon: 'file', text: 'class Program', source: 'using System;\n// C# source\npublic class Program {\n    public const int Retries = 3;\n    public static void Main() {\n        Console.WriteLine("Hello from C#");\n    }\n}\n' },
  { path: 'main.rs', icon: 'file-rust', text: 'fn main', source: '// Rust source\nfn main() {\n    let retries: u32 = 3;\n    let name = "local";\n    if retries > 0 { println!("{}", name); }\n}\n' },
  { path: 'main.swift', icon: 'file', text: 'struct Service', source: '// Swift source\nstruct Service {\n    let name: String = "local"\n    let retries: Int = 3\n    func isEnabled() -> Bool { return retries > 0 }\n}\n' },
  { path: 'query.sql', icon: 'file-sql', text: 'SELECT', source: '-- SQL source\nSELECT name, COUNT(*) AS total\nFROM services\nWHERE environment = \'local\' AND retries > 3\nGROUP BY name;\n' },
  { path: 'settings.xml', icon: 'file-xml', text: 'configuration', source: '<?xml version="1.0" encoding="UTF-8"?>\n<!-- XML configuration -->\n<configuration enabled="true">\n    <service name="local" port="8080">Ready</service>\n</configuration>\n' },
  { path: 'settings.toml', icon: 'file-toml', text: 'language_coverage_marker', minimum: 3, source: '# TOML configuration\ntitle = "language_coverage_marker" # local-only syntax probe\nenabled = true\nretries = 3\n\n[server]\nhost = "127.0.0.1"\nports = [8080, 8081]\n' },
  { path: 'Makefile', icon: 'file-config', text: 'GREETING', minimum: 3, source: '# Makefile syntax only; nothing is executed.\nGREETING := "hello"\nCOUNT := 3\n.PHONY: all\nall:\n\t@echo $(GREETING)\n\nifeq ($(COUNT),3)\nMODE = enabled\nendif\n' },
  { path: 'Dockerfile', icon: 'file-docker', text: 'FROM', minimum: 3, source: '# Dockerfile syntax only; no image is downloaded.\nFROM alpine:3.20\nENV SERVICE_NAME="local"\nWORKDIR /app\nCOPY . /app\nRUN echo "hello"\nEXPOSE 8080\nCMD ["echo", "ready"]\n' },
  { path: 'schema.prisma', icon: 'file-prisma', text: 'model User', minimum: 3, source: '// Prisma schema\ndatasource db {\n  provider = "sqlite"\n  url = "file:local.db"\n}\n\nmodel User {\n  id Int @id @default(autoincrement())\n  name String\n  active Boolean @default(true)\n}\n' },
  { path: 'Program.fs', icon: 'file-fsharp', text: 'greeting', source: '// F# source\nmodule Program\nlet retries: int = 3\nlet greeting = "Hello from F#"\nlet enabled = true\nif retries > 0 then printfn "%s" greeting\n' },
  { path: 'schema.graphql', icon: 'file-graphql', text: 'type Query', minimum: 3, source: '# GraphQL schema\ntype Query {\n  service(name: String = "local", retries: Int = 3): Service!\n}\n\ntype Service {\n  id: ID!\n  enabled: Boolean!\n}\n' },
];
const proto = (field: string) => `syntax = "proto3";
// The only tracked working-tree modification in this fixture.
package coverage;

message Service {
  string name = 1;
  int32 retries = 2;
  ${field} = 3;
}

service Registry {
  rpc Find(Service) returns (Service);
}
`;
const vue = `<script setup lang="ts">
import { ref } from 'vue'
// Added Vue file: all lines retain the green addition background.
const title = ref('Language coverage')
const retries: number = 3
const enabled = true
</script>

<template>
  <main class="coverage" v-if="enabled">
    <h1>{{ title }}</h1>
    <button :disabled="retries === 0">Retry</button>
  </main>
</template>

<style scoped>
.coverage { color: #93c5fd; padding: 16px; }
</style>
`;
const fixtureContents = new Map(samples.map(sample => [sample.path, sample.source]));
fixtureContents.set('000-search-first.txt', 'language_coverage_marker\n');
await git('init', '-q', '-b', 'main');
await Promise.all([...fixtureContents].map(([path, source]) => writeFile(join(repository, path), source)));
await writeFile(join(repository, 'service.proto'), proto('bool enabled'));
await git('add', '.');
await git('-c', 'user.name=Language smoke', '-c', 'user.email=language-smoke@example.invalid', 'commit', '-qm', 'Language coverage fixture');
fixtureContents.set('service.proto', proto('string environment'));
fixtureContents.set('Added.vue', vue);
await Promise.all([
  writeFile(join(repository, 'service.proto'), fixtureContents.get('service.proto')!),
  writeFile(join(repository, 'Added.vue'), vue),
]);
const originalHead = (await git('rev-parse', 'HEAD')).stdout;
const originalStatus = (await git('status', '--porcelain=v1')).stdout;

// Install error/network observers before loading the application: startup errors
// and CSP failures must count even if the first renderer fails before Playwright attaches.
const bootstrap = join(temporary, 'bootstrap.cjs');
await writeFile(bootstrap, `const { app, BrowserWindow } = require('electron');
global.__languageSmoke = { errors: [], wasm: [] };
const sessions = new WeakSet();
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (details) => {
    if (details.level === 'error') global.__languageSmoke.errors.push({ kind: 'console', message: details.message, source: details.sourceId });
  });
  contents.on('render-process-gone', (_event, details) => global.__languageSmoke.errors.push({ kind: 'renderer', reason: details.reason }));
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame) global.__languageSmoke.errors.push({ kind: 'load', code, description, url });
  });
  if (!sessions.has(contents.session)) {
    sessions.add(contents.session);
    contents.session.webRequest.onCompleted((details) => {
      if (/\\.wasm(?:$|\\?)/.test(details.url)) global.__languageSmoke.wasm.push({ url: details.url, status: details.statusCode });
    });
    contents.session.webRequest.onErrorOccurred((details) => {
      if (/\\.wasm(?:$|\\?)/.test(details.url)) global.__languageSmoke.errors.push({ kind: 'wasm', url: details.url, error: details.error });
    });
  }
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
const colors: Record<string, string[]> = {};
const icons: Record<string, { src: string; width: number; height: number }> = {};
let phase = 'opening';
let projectPage: Page | undefined;
const observePage = (page: Page) => page.on('pageerror', error => errors.push(error.stack ?? error.message));
application.on('window', observePage);
for (const window of application.windows()) observePage(window);
const startupEvidence = () => application.evaluate(() => (globalThis as unknown as {
  __languageSmoke: { errors: unknown[]; wasm: { url: string; status: number }[] };
}).__languageSmoke);

try {
  const welcome = await application.firstWindow();
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repository);
  const page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  projectPage = page;
  const nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(window => window.setContentSize(1440, 1000));
  const capture = async (name: string) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await nativeWindow.evaluate(window => window.showInactive());
      await page.locator('.project-tree').evaluateAll(elements => elements.forEach(element => { element.scrollLeft = 0; }));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await writeFile(join(artifacts, name), await Promise.race([
        captureWindow(application, page),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Capture timed out')), 10000); }),
      ]));
    } finally {
      clearTimeout(deadline);
      await nativeWindow.evaluate(window => window.hide());
    }
  };
  const tokenColors = (view: Locator) => view.locator('.view-lines').evaluate(node => [...new Set([...node.querySelectorAll('span[class*="mtk"]')]
    .filter(span => span.textContent?.trim()).map(span => getComputedStyle(span).color))]);
  const checkColors = async (view: Locator, key: string, text: string, minimum = 4) => {
    phase = `syntax: ${key}`;
    await expect(view.locator('.view-lines')).toContainText(text);
    await expect.poll(async () => (await tokenColors(view)).length, { message: `${key} has real rendered syntax colors` }).toBeGreaterThanOrEqual(minimum);
    colors[key] = await tokenColors(view);
  };
  const checkIcon = async (scope: Locator, key: string, name: string) => {
    const icon = scope.locator(`img.jb-icon[data-icon="${name}"]`).first();
    await expect(icon).toBeVisible();
    const image = await icon.evaluate(async element => {
      const image = element as HTMLImageElement;
      await image.decode();
      return { src: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight };
    });
    expect(image.src).toMatch(/^app:\/\/smart-diff\/assets\/[^/]+\.svg$/);
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
    icons[key] = image;
  };
  const chooseView = async (name: 'Project' | 'Commit') => {
    const button = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name, exact: true });
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  };

  phase = 'protobuf diff';
  await chooseView('Commit');
  const protoRow = page.getByRole('treeitem', { name: 'service.proto (working)', exact: true });
  await protoRow.click();
  await checkIcon(protoRow, 'commit-service.proto', 'file-proto');
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await checkColors(page.locator('[data-side="original"]'), 'protobuf-original', 'bool enabled');
  await checkColors(page.locator('[data-side="modified"]'), 'protobuf-modified', 'string environment');
  await expect(page.locator('.source-headers')).toHaveCount(0);
  await capture('protobuf-diff.png');

  phase = 'added Vue';
  const addedRow = page.getByRole('treeitem', { name: 'Added.vue (untracked)', exact: true });
  await addedRow.click();
  await checkIcon(addedRow, 'commit-Added.vue', 'file-vue');
  const editor = page.getByTestId('file-surface');
  await expect(editor).toHaveAttribute('data-path', 'Added.vue');
  await expect(editor).toHaveAttribute('data-added', 'true');
  await checkColors(editor, 'added-vue', 'Language coverage', 5);
  await expect(editor.locator('.added-file-line')).toHaveCount(vue.trimEnd().split('\n').length);
  const addedBackgrounds = await editor.locator('.added-file-line, .added-file-margin').evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).backgroundColor))]);
  expect(addedBackgrounds).toHaveLength(1);
  const [red, green, blue] = addedBackgrounds[0].match(/[\d.]+/g)!.map(Number);
  expect(green).toBeGreaterThan(red);
  expect(green).toBeGreaterThan(blue);
  await capture('vue-added.png');

  // TOML is first encountered through search. Both unselected snippets and the
  // selected preview must trigger the lazy grammar, not borrow colors from a prior tab.
  phase = 'TOML search';
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+f`);
  const dialog = page.getByRole('dialog', { name: 'Find in Files', exact: true });
  await dialog.getByRole('searchbox', { name: 'Search text', exact: true }).fill('language_coverage_marker');
  const result = dialog.locator('.find-result-row[data-path="settings.toml"]').first();
  await expect(result).toBeVisible();
  await expect(dialog.locator('.find-preview-name')).toHaveText('000-search-first.txt');
  await expect(result).toHaveAttribute('aria-selected', 'false');
  const snippetColors = () => result.locator('.find-result-snippet').evaluate(node => [...new Set([...node.querySelectorAll('.find-snippet-token')]
    .filter(span => span.textContent?.trim() && !span.closest('mark')).map(span => getComputedStyle(span).color))]);
  await expect.poll(async () => (await snippetColors()).length).toBeGreaterThanOrEqual(2);
  colors['toml-search-snippet'] = await snippetColors();
  await result.click();
  await checkColors(dialog.locator('.find-preview-editor'), 'toml-search-preview', 'language_coverage_marker', 3);
  await checkIcon(dialog.locator('.find-preview-header'), 'search-heading-settings.toml', 'file-toml');
  await capture('toml-search.png');
  await dialog.getByRole('button', { name: 'Close Find in Files', exact: true }).click();

  await chooseView('Project');
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  for (const sample of samples) {
    phase = `project: ${sample.path}`;
    const row = tree.getByRole('treeitem', { name: sample.path, exact: true });
    await row.click();
    await checkIcon(row, `project-${sample.path}`, sample.icon);
    await expect(editor).toHaveAttribute('data-path', sample.path);
    await expect(editor).not.toHaveAttribute('data-added', 'true');
    await checkColors(editor, sample.path, sample.text, sample.minimum);
    const tab = page.getByRole('tab', { name: sample.path, exact: true });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await checkIcon(tab, `tab-${sample.path}`, sample.icon);
  }
  await tree.getByRole('treeitem', { name: 'schema.prisma', exact: true }).click();
  await checkColors(editor, 'project-capture-prisma', 'model User', 3);
  await tree.evaluate(node => { node.scrollTop = 0; });
  await capture('project-languages.png');

  phase = 'final verification';
  const startup = await startupEvidence();
  expect(startup.wasm.length, 'The production renderer loads the local syntax engine').toBeGreaterThan(0);
  for (const request of startup.wasm) {
    expect(request.url).toMatch(/^app:\/\/smart-diff\/assets\/onig[^/]*\.wasm$/);
    expect(request.status).toBe(200);
  }
  expect(startup.errors, 'Startup/runtime console, load, renderer, and WASM errors').toEqual([]);
  expect(errors, 'Playwright renderer exceptions').toEqual([]);
  expect((await git('rev-parse', 'HEAD')).stdout).toBe(originalHead);
  expect((await git('status', '--porcelain=v1')).stdout).toBe(originalStatus);
  for (const [path, content] of fixtureContents) expect(await readFile(join(repository, path), 'utf8'), path).toBe(content);
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({
    checks: ['Protobuf original and modified diff syntax', 'Added Vue syntax and full green background', 'Ordinary project editors for fourteen languages', 'Local JetBrains icons in project/commit trees, normal tabs, and search heading', 'TOML lazy syntax in result rows and preview', 'Production app-protocol WASM load under Electron CSP', 'Errors observed from before the first renderer', 'Fixture contents, HEAD, and working changes preserved'],
    colors, icons, addedBackgrounds, wasm: startup.wasm, errors: [...errors, ...startup.errors],
  }, null, 2));
  await nativeWindow.dispose();
  console.log(`Language coverage checks passed. Screenshots: ${artifacts}`);
} catch (error) {
  const startup = await startupEvidence().catch(() => ({ errors: [], wasm: [] }));
  await writeFile(join(artifacts, 'failure.json'), JSON.stringify({ phase, error: String(error), colors, icons, errors, startup }, null, 2));
  if (projectPage && !projectPage.isClosed()) await writeFile(join(artifacts, 'failure.png'), await captureWindow(application, projectPage)).catch(() => {});
  throw error;
} finally {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
