/** Real-file production Electron check for Terraform syntax in every editor surface. */
import { _electron as electron, expect as baseExpect, type Locator } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWindow, openRepositoryWindow } from './electron-smoke-windows';

const expect = baseExpect.configure({ timeout: 20000 });
const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'smart-diff-terraform-'));
const repository = join(temporary, 'terraform-presentation');
const profile = join(temporary, 'profile');
const artifacts = resolve('artifacts/terraform-presentation');
await Promise.all([mkdir(repository), mkdir(profile), mkdir(artifacts, { recursive: true })]);
const git = (...args: string[]) => run('git', ['-C', repository, ...args], { shell: false });
const source = (value: number) => `# Local Terraform fixture; no provider or network access is needed.
terraform {
  required_version = ">= 1.6.0"
}

variable "project_name" {
  type    = string
  default = "sample-project"
}

resource "terraform_data" "service" {
  count = ${value}
  input = {
    name    = var.project_name
    enabled = true
    labels  = [for n in range(3) : "service-${'${n}'}"]
  }
}

output "service_ids" {
  value = terraform_data.service[*].id
}
`;
const variables = `# Environment-specific settings.
project_name = "development"
replicas     = 3
enabled      = true
labels       = ["local", "smoke"]
`;
const test = `# A test declaration is HCL too.
run "verify_service" {
  command = plan
  variables {
    project_name = "test-project"
    replicas     = 2
  }
  assert {
    condition     = length(output.service_ids) > 0
    error_message = "Expected at least one service"
  }
}
`;
await git('init', '-q', '-b', 'main');
await Promise.all([
  writeFile(join(repository, 'main.tf'), source(1)),
  writeFile(join(repository, 'development.tfvars'), variables),
  writeFile(join(repository, 'service.tftest.hcl'), test),
  writeFile(join(repository, 'outputs.tf.json'), JSON.stringify({ output: { enabled: { value: true }, count: { value: 3 }, name: { value: 'sample-project' } } }, null, 2) + '\n'),
]);
await git('add', '.');
await git('-c', 'user.name=Terraform smoke', '-c', 'user.email=terraform-smoke@example.invalid', 'commit', '-qm', 'Terraform fixture');
await Promise.all([
  writeFile(join(repository, 'main.tf'), source(2)),
  writeFile(join(repository, 'added.tf'), source(4)),
]);

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
  const viewButtons = page.getByRole('group', { name: 'Workspace view', exact: true });
  const chooseView = async (name: 'Project' | 'Commit') => {
    const button = viewButtons.getByRole('button', { name, exact: true });
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  };

  await chooseView('Commit');
  await page.getByRole('treeitem', { name: 'main.tf (working)', exact: true }).click();
  await expect(page.locator('.smart-diff[data-status="ready"]')).toBeVisible();
  await checkColors(page.locator('[data-side="original"]'), 'diff-original', 'terraform_data');
  await checkColors(page.locator('[data-side="modified"]'), 'diff-modified', 'terraform_data');
  await capture('terraform-diff.png');

  await page.getByRole('treeitem', { name: 'added.tf (untracked)', exact: true }).click();
  const editor = page.getByTestId('file-surface');
  await expect(editor).toHaveAttribute('data-path', 'added.tf');
  await expect(editor).toHaveAttribute('data-added', 'true');
  await checkColors(editor, 'added-file', 'terraform_data');
  await capture('terraform-added.png');

  await chooseView('Project');
  const tree = page.getByRole('tree', { name: 'Project files', exact: true });
  for (const [file, text, minimum] of [
    ['main.tf', 'terraform_data', 4],
    ['development.tfvars', 'Environment-specific', 4],
    ['service.tftest.hcl', 'verify_service', 4],
    ['outputs.tf.json', 'sample-project', 3],
  ] as const) {
    await tree.getByRole('treeitem', { name: file, exact: true }).click();
    await expect(editor).toHaveAttribute('data-path', file);
    await checkColors(editor, file, text, minimum);
    await capture(`project-${file}.png`);
  }

  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+f`);
  const dialog = page.getByRole('dialog', { name: 'Find in Files', exact: true });
  await dialog.getByRole('searchbox', { name: 'Search text', exact: true }).fill('terraform_data');
  await dialog.getByRole('option').first().click();
  await checkColors(dialog.locator('.find-preview-editor'), 'search-preview', 'terraform_data');
  await expect.poll(() => dialog.locator('.find-result-snippet').first().evaluate(node => new Set([...node.querySelectorAll('span')].map(span => getComputedStyle(span).color)).size)).toBeGreaterThanOrEqual(2);
  await capture('terraform-search.png');
  expect(errors).toEqual([]);
  await writeFile(join(artifacts, 'summary.json'), JSON.stringify({ checks: ['Terraform original and modified diff panes', 'Green added Terraform editor', '.tf ordinary editor', '.tfvars ordinary editor', '.tftest.hcl ordinary editor', '.tf.json retains JSON highlighting', 'Find in Files syntax in result snippets and preview'], colors, errors }, null, 2));
  await nativeWindow.dispose();
  console.log(`Terraform presentation checks passed. Screenshots: ${artifacts}`);
} finally {
  await application.close();
  await rm(temporary, { recursive: true, force: true });
}
