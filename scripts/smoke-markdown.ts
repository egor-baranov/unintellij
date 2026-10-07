/** Build desktop first. Exercise real Markdown IPC/editor integration using only
 * a disposable Git repository and profile; native windows remain hidden. */
import { _electron as electron, expect as baseExpect, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, hideWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 15000 });
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'smart-diff-markdown-smoke-'));
const repository = join(directory, 'markdown-project'), profile = join(directory, 'profile');
const output = resolve('artifacts/markdown-preview');
const checks: string[] = [], errors: string[] = [];
const pass = (message: string) => { checks.push(message); console.log(`PASS: ${message}`); };
let application: ElectronApplication | undefined;
let page: Page | undefined;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const original = `# Markdown workspace

Edit documentation and review the result **as you type**.

## Project guide

[Open the guide](docs/guide.md) · [Web reference](https://example.test/markdown)

![Workflow](images/workflow.svg)

| View | Purpose |
| --- | --- |
| Code | Edit the source |
| Split | Code and preview together |
| Preview | Read the document |

- [x] Local images
- [x] Project links
- [ ] Finish the guide

\`\`\`typescript
const preview = { mode: 'split', live: true };
\`\`\`

![Pixel fixture](images/pixel.png)
`;
const changed = original.replace('# Markdown workspace', '# Updated Markdown workspace');
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });

try {
  await Promise.all([mkdir(join(repository, 'docs'), { recursive: true }), mkdir(join(repository, 'images'), { recursive: true }), mkdir(profile), mkdir(output, { recursive: true })]);
  await Promise.all([
    writeFile(join(repository, 'README.md'), original),
    writeFile(join(repository, 'docs', 'guide.md'), '# Project guide\n\nThis link opened a real project file.\n'),
    writeFile(join(repository, 'images', 'pixel.png'), png),
    writeFile(join(repository, 'images', 'workflow.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="380" height="58" viewBox="0 0 380 58"><rect x="1" y="1" width="113" height="56" rx="6" fill="#294372"/><rect x="133" y="1" width="113" height="56" rx="6" fill="#294372"/><rect x="265" y="1" width="113" height="56" rx="6" fill="#294372"/><path d="M114 29h19m113 0h19" stroke="#739ddd" stroke-width="2"/><g fill="#dce6fa" font-family="sans-serif" font-size="14" text-anchor="middle"><text x="57" y="34">Write</text><text x="189" y="34">Preview</text><text x="321" y="34">Save</text></g></svg>'),
  ]);
  await git('init', '-q', '-b', 'main');
  await git('add', '.');
  await git('-c', 'user.name=Markdown Smoke', '-c', 'user.email=markdown@example.invalid', 'commit', '-qm', 'Disposable Markdown fixture');
  const bootstrap = join(directory, 'bootstrap.cjs');
  await writeFile(bootstrap, `const { BrowserWindow } = require('electron');
BrowserWindow.prototype.show = function () { this.webContents.setBackgroundThrottling(false); this.hide(); };
require(${JSON.stringify(resolve('apps/desktop/dist/index.cjs'))});
`);
  application = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`], env: { ...process.env, SMART_DIFF_DEV_URL: '' } });
  const welcome = await application.firstWindow();
  await hideWindow(application, welcome);
  expect(await application.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, repository);
  page = await openRepositoryWindow(application, () => welcome.getByRole('button', { name: 'Open…', exact: true }).click());
  page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
  page.on('pageerror', error => errors.push(error.message));
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const project = page.getByRole('group', { name: 'Workspace view', exact: true }).getByRole('button', { name: 'Project', exact: true });
  if (await project.getAttribute('aria-pressed') !== 'true') await project.click();
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  const markdown = page.locator('.markdown-surface');
  const preview = page.getByRole('region', { name: 'Markdown preview: README.md', exact: true });
  const file = page.getByTestId('file-surface');
  const mode = (name: string) => page!.getByRole('toolbar', { name: 'Markdown view', exact: true }).getByRole('button', { name, exact: true });
  await expect(markdown).toHaveAttribute('data-mode', 'split');
  await expect(file).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Markdown workspace', exact: true })).toBeVisible();
  await expect(preview.getByRole('table')).toBeVisible();
  for (const alt of ['Workflow', 'Pixel fixture']) {
    const image = preview.getByRole('img', { name: alt, exact: true });
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
    expect(await image.getAttribute('src')).toMatch(/^blob:/);
  }
  pass('Opening a Markdown project file defaults to Split, renders a table, and loads real PNG/static-SVG images through the desktop bridge.');

  await mode('Preview').click();
  await expect(markdown).toHaveAttribute('data-mode', 'preview');
  await expect(file).toBeHidden();
  await expect(preview).toBeVisible();
  await mode('Code').click();
  await expect(markdown).toHaveAttribute('data-mode', 'code');
  await expect(file).toBeVisible();
  await expect(preview).toHaveCount(0);
  await mode('Split').click();
  await expect(preview).toBeVisible();
  pass('Code, Preview, and Split switch layouts while retaining the same project editor.');

  await preview.getByRole('link', { name: 'Open the guide', exact: true }).click();
  await expect(file).toHaveAttribute('data-path', 'docs/guide.md');
  await expect(page.getByRole('region', { name: 'Markdown preview: docs/guide.md', exact: true }).getByRole('heading', { name: 'Project guide', exact: true })).toBeVisible();
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await expect(file).toHaveAttribute('data-path', 'README.md');
  pass('Clicking a relative Markdown link opens the real linked file as a project tab.');

  // Observe external-link dispatch without launching a browser or contacting a
  // network: the UI, preload, IPC validation and URL handling still run normally.
  await application.evaluate(({ shell }) => {
    Reflect.set(globalThis, 'markdownSmokeLinks', []);
    shell.openExternal = async url => { (Reflect.get(globalThis, 'markdownSmokeLinks') as string[]).push(url); };
  });
  await preview.getByRole('link', { name: 'Web reference', exact: true }).click();
  expect(await application.evaluate(() => Reflect.get(globalThis, 'markdownSmokeLinks'))).toEqual(['https://example.test/markdown']);
  const rejected = await page.evaluate(async () => {
    const { repository } = (await window.desktop.getLastRepository())!;
    const root = await window.desktop.listProjectDirectory(repository.id, null);
    const sourceId = root.entries.find(entry => entry.name === 'README.md')!.id;
    return Promise.all([
      window.desktop.readMarkdownImage(repository.id, sourceId, '../outside.png'),
      window.desktop.openMarkdownLink('javascript:alert(1)'),
    ].map(promise => promise.then(() => false, () => true)));
  });
  expect(rejected).toEqual([true, true]);
  pass('External link clicks reach the validated system opener; traversal and executable URLs are rejected by real IPC handlers.');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('navigation', { name: 'Settings categories', exact: true }).getByRole('button', { name: 'Files', exact: true }).click();
  await settings.getByRole('checkbox', { name: 'Save changes automatically', exact: true }).uncheck();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await file.locator('.view-lines').click({ position: { x: 100, y: 10 } });
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(changed);
  await expect(preview.getByRole('heading', { name: 'Updated Markdown workspace', exact: true })).toBeVisible();
  expect(await readFile(join(repository, 'README.md'), 'utf8')).toBe(original);
  await mode('Preview').click();
  await preview.focus();
  await page.keyboard.press(`${mod}+s`);
  await expect.poll(() => readFile(join(repository, 'README.md'), 'utf8')).toBe(changed);
  await expect(page.getByRole('img', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
  pass('An unsaved Monaco edit updates the live preview; Save in Preview mode writes through the existing editing flow.');

  await page.reload();
  await expect(markdown).toHaveAttribute('data-mode', 'preview');
  await expect(preview.getByRole('heading', { name: 'Updated Markdown workspace', exact: true })).toBeVisible();
  await expect(file).toBeHidden();
  await mode('Split').click();
  const divider = page.getByRole('separator', { name: 'Resize Markdown split', exact: true });
  await divider.focus();
  await divider.press('ArrowRight');
  await divider.press('ArrowRight');
  const ratio = await divider.getAttribute('aria-valuenow');
  await page.reload();
  await expect(markdown).toHaveAttribute('data-mode', 'split');
  await expect(divider).toHaveAttribute('aria-valuenow', ratio!);
  await expect(preview.getByRole('img', { name: 'Workflow', exact: true })).toHaveClass(/is-loaded/);
  pass('Preview mode survives a renderer reload; the resized Split mode and its ratio also persist.');

  await writeFile(join(output, 'desktop-split.png'), await captureWindow(application, page));
  expect(errors).toEqual([]);
  await writeFile(join(output, 'desktop-checks.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(`Screenshot: ${join(output, 'desktop-split.png')}`);
} catch (error) {
  if (application && page && !page.isClosed()) await writeFile(join(output, 'desktop-failure.png'), await captureWindow(application, page)).catch(() => {});
  throw error;
} finally {
  await application?.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
  await application?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
