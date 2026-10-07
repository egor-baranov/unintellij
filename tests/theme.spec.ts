import { expect, test } from '@playwright/test';
import ts from 'typescript';
import { referenceFixture } from '../apps/playground/src/reference-fixture';

test('reference fixture is valid TSX with real distant source lines', () => {
  for (const side of ['original', 'modified'] as const) {
    const source = referenceFixture[side];
    expect(source.split('\n').length).toBeGreaterThanOrEqual(250);
    const transpiled = ts.transpileModule(source, {
      fileName: 'ReviewPreferencesPanel.tsx',
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error)).toEqual([]);
  }
});

test('host JSX colors survive generic types, multiline attributes, and nested expressions', async ({ page }) => {
  await page.goto('/?fixture=reference');
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
  const colors = await page.evaluate(() => {
    const monaco = window.playground.monaco;
    const sample = [
      'const [value, setValue] = useState<Preferences>(initial);',
      'function update<Key extends keyof Preferences>(key: Key) { return key; }',
      'const element = (',
      '  <section className="preferences">',
      '    <input',
      '      type="checkbox"',
      '      checked={value.enabled}',
      '      onChange={(event) => setValue({ ...value, enabled: event.target.checked })}',
      '    />',
      '    <span>{value.enabled ? <strong>On</strong> : "Off"}</span>',
      '  </section>',
      ');',
      'const after = true;',
      'function render() { return <Panel title="Ready" />; }',
      'function fragment() { return <><span>Ready</span></>; }',
      'const finalValue = true;',
    ];
    const tokens = monaco.editor.tokenize(sample.join('\n'), 'smart-diff-tsx');
    const tokenFor = (line: number, text: string) => {
      const offset = sample[line].indexOf(text);
      return [...tokens[line]].reverse().find(token => token.offset <= offset)?.type;
    };
    const info = window.playground.viewer!.getEditors().original.getOption(monaco.editor.EditorOption.fontInfo);
    return {
      generic: tokenFor(0, 'Preferences'), constrained: tokenFor(1, 'Key'),
      section: tokenFor(3, 'section'), attribute: tokenFor(5, 'type'),
      expression: tokenFor(6, 'value'), callback: tokenFor(7, 'setValue'),
      nested: tokenFor(9, 'strong'), subsequentCode: tokenFor(12, 'const'),
      directReturn: tokenFor(13, 'Panel'), returnKeyword: tokenFor(13, 'return'),
      fragmentTag: tokenFor(14, 'span'), afterFragment: tokenFor(15, 'const'),
      metrics: { size: info.fontSize, height: info.lineHeight, weight: info.fontWeight },
    };
  });
  expect(colors.generic).toBe('type.identifier.tsx');
  expect(colors.constrained).toBe('type.identifier.tsx');
  expect(colors.section).toBe('tag.tsx');
  expect(colors.attribute).toBe('attribute.name.tsx');
  expect(colors.expression).toBe('identifier.tsx');
  expect(colors.callback).toBe('identifier.tsx');
  expect(colors.nested).toBe('tag.tsx');
  expect(colors.subsequentCode).toBe('keyword.tsx');
  expect(colors.directReturn).toBe('tag.tsx');
  expect(colors.returnKeyword).toBe('keyword.tsx');
  expect(colors.fragmentTag).toBe('tag.tsx');
  expect(colors.afterFragment).toBe('keyword.tsx');
  expect(colors.metrics).toEqual({ size: 16, height: 23, weight: '400' });
  await expect.poll(() => page.evaluate(() => window.playground.monaco.editor
    .tokenize('const value = true;', 'typescript')[0].some(token => token.type.endsWith('.ts')))).toBe(true);
});

test('Go source loads the shared tokenizer in both comparison panes and survives file switching', async ({ page }) => {
  await page.goto('/?fixture=go');
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
  const syntax = await page.evaluate(async () => {
    const { monaco, viewer } = window.playground;
    const editors = viewer!.getEditors();
    const source = editors.original.getModel()!.getValue();
    await monaco.editor.colorize(source, 'go', {});
    const lines = source.split('\n');
    const tokens = monaco.editor.tokenize(source, 'go');
    function tokenFor(line: number, value: string) {
      const offset = lines[line].indexOf(value);
      return [...tokens[line]].reverse().find(token => token.offset <= offset)?.type;
    }
    return {
      languages: [editors.original, editors.modified].map(editor => editor.getModel()!.getLanguageId()),
      package: tokenFor(0, 'package'), import: tokenFor(2, 'import'),
      quotedString: tokenFor(2, 'fmt'), comment: tokenFor(4, 'Runtime'),
      function: tokenFor(5, 'func'), number: tokenFor(7, '1'),
      multilineComment: tokenFor(11, 'multiple'), rawString: tokenFor(13, 'enabled'),
    };
  });
  expect(syntax.languages).toEqual(['go', 'go']);
  expect(syntax.package).toBe('keyword.package.go');
  expect(syntax.import).toBe('keyword.import.go');
  expect(syntax.quotedString).toBe('string.go');
  expect(syntax.comment).toBe('comment.go');
  expect(syntax.function).toBe('keyword.func.go');
  expect(syntax.number).toBe('number.go');
  expect(syntax.multilineComment).toBe('comment.go');
  expect(syntax.rawString).toBe('string.go');
  for (const pane of ['original', 'modified']) {
    await expect(page.locator(`.smart-diff-pane[data-side="${pane}"] .view-line`).first()).toContainText('package api');
  }
  await page.screenshot({ path: 'test-results/go-syntax-comparison.png' });
  await page.evaluate(() => window.playground.selectFixture('json'));
  await expect.poll(() => page.evaluate(() => window.playground.viewer?.getEditors().modified.getModel()?.getLanguageId())).toBe('json');
  await page.evaluate(() => window.playground.selectFixture('go'));
  await expect.poll(() => page.evaluate(() => window.playground.viewer?.getEditors().modified.getModel()?.getLanguageId())).toBe('go');
  await expect.poll(() => page.evaluate(() => window.playground.getState().status)).toBe('ready');
});

test('Terraform loads HCL highlighting in both comparison panes and restores it after switching languages', async ({ page }) => {
  await page.goto('/?fixture=terraform');
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
  const syntax = await page.evaluate(async () => {
    const { monaco, viewer } = window.playground;
    const editors = viewer!.getEditors();
    const source = editors.original.getModel()!.getValue();
    await monaco.editor.colorize(source, 'hcl', {});
    const lines = source.split('\n');
    const tokens = monaco.editor.tokenize(source, 'hcl');
    function tokenFor(line: number, value: string) {
      const offset = lines[line].indexOf(value);
      return [...tokens[line]].reverse().find(token => token.offset <= offset)?.type;
    }
    return {
      languages: [editors.original, editors.modified].map(editor => editor.getModel()!.getLanguageId()),
      comment: tokenFor(0, 'Terraform'), block: tokenFor(1, 'terraform'),
      string: tokenFor(7, 'eu-west-1'), number: tokenFor(11, '2'), keyword: tokenFor(12, 'true'),
      interpolation: tokenFor(13, 'var'), function: tokenFor(14, 'merge'),
      multilineComment: tokenFor(17, 'across'), heredoc: tokenFor(19, 'Managed'),
    };
  });
  expect(syntax).toEqual({
    languages: ['hcl', 'hcl'], comment: 'comment.hcl', block: 'type.hcl',
    string: 'string.hcl', number: 'number.hcl', keyword: 'keyword.true.hcl',
    interpolation: 'keyword.var.hcl', function: 'type.hcl', multilineComment: 'comment.hcl', heredoc: 'string.heredoc.hcl',
  });
  await page.evaluate(() => window.playground.selectFixture('json'));
  await expect.poll(() => page.evaluate(() => window.playground.viewer?.getEditors().modified.getModel()?.getLanguageId())).toBe('json');
  await page.evaluate(() => window.playground.selectFixture('terraform'));
  await expect.poll(() => page.evaluate(() => window.playground.viewer?.getEditors().modified.getModel()?.getLanguageId())).toBe('hcl');
  await expect.poll(() => page.evaluate(() => window.playground.getState().status)).toBe('ready');
  for (const pane of ['original', 'modified']) {
    // Inspect the painted token color, not just the model's assigned language ID.
    await expect.poll(() => page.locator(`.smart-diff-pane[data-side="${pane}"] .view-line span`).evaluateAll(spans => {
      const token = spans.find(span => span.textContent === 'true' || span.textContent === 'false');
      return token && getComputedStyle(token).color;
    })).toBe('rgb(192, 133, 255)');
  }
});
