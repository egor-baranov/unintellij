import { expect, test } from '@playwright/test';
import { bazelMacro } from '../apps/playground/src/bazel-fixture';

test('Bazel colors both diff panes and keeps Starlark string states separate from code', async ({ page }) => {
  await page.goto('/?fixture=bazel');
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
  const syntax = await page.evaluate(macro => {
    const { monaco, viewer } = window.playground;
    const editors = viewer!.getEditors();
    const source = editors.original.getModel()!.getValue();
    const tokenAt = (text: string, lineText: string, word: string) => {
      const lines = text.split('\n');
      const line = lines.findIndex(value => value.includes(lineText));
      const offset = lines[line].indexOf(word);
      return [...monaco.editor.tokenize(text, 'starlark')[line]].reverse().find(token => token.offset <= offset)?.type;
    };
    const escapes = ['text = "hello\\nworld"', 'raw = r"hello\\nworld"', 'single = \'escaped\\\'quote\'', 'next = True'].join('\n');
    return {
      languages: [editors.original, editors.modified].map(editor => editor.getModel()!.getLanguageId()),
      load: tokenAt(source, 'load(', 'load'), label: tokenAt(source, 'load(', '@rules_go'),
      rule: tokenAt(source, 'go_library(', 'go_library'), attribute: tokenAt(source, 'name =', 'name'),
      count: tokenAt(source, 'shard_count', '1'), boolean: tokenAt(source, 'flaky', 'False'),
      comment: tokenAt(source, '# Bazel', 'Bazel'),
      docstring: tokenAt(macro, 'Loads targets', 'Loads'),
      afterDocstring: tokenAt(macro, 'load(', 'load'), definition: tokenAt(macro, 'def ', 'def'),
      comprehension: tokenAt(macro, 'labels =', 'for'),
      raw: tokenAt(macro, 'pattern =', '\\w'), inlineComment: tokenAt(macro, 'pattern =', 'inline'),
      escaped: tokenAt(escapes, 'text =', '\\n'), rawEscape: tokenAt(escapes, 'raw =', '\\n'),
      afterEscapedQuote: tokenAt(escapes, 'next =', 'True'),
    };
  }, bazelMacro);
  expect(syntax).toEqual({
    languages: ['starlark', 'starlark'], load: 'keyword.starlark', label: 'string.starlark',
    rule: 'type.identifier.starlark', attribute: 'attribute.name.starlark', count: 'number.starlark',
    boolean: 'keyword.starlark', comment: 'comment.starlark', docstring: 'string.starlark',
    afterDocstring: 'keyword.starlark', definition: 'keyword.starlark', comprehension: 'keyword.starlark',
    raw: 'string.starlark', inlineComment: 'comment.starlark', escaped: 'string.escape.starlark',
    rawEscape: 'string.starlark', afterEscapedQuote: 'keyword.starlark',
  });
  for (const side of ['original', 'modified']) {
    await expect.poll(() => page.locator(`[data-side="${side}"] .view-line span`).evaluateAll(spans => {
      const token = spans.find(span => span.textContent === 'False' || span.textContent === 'True');
      return token && getComputedStyle(token).color;
    })).toBe('rgb(192, 133, 255)');
  }
  await page.evaluate(() => window.playground.selectFixture('json'));
  await expect.poll(() => page.evaluate(() => window.playground.viewer?.getEditors().modified.getModel()?.getLanguageId())).toBe('json');
  await page.evaluate(() => window.playground.selectFixture('bazel'));
  await expect.poll(() => page.evaluate(() => window.playground.viewer?.getEditors().modified.getModel()?.getLanguageId())).toBe('starlark');
  await expect.poll(() => page.evaluate(() => window.playground.getState().status)).toBe('ready');
});

test('Starlark handles raw triple quotes, Unicode names, and numeric forms without leaking string state', async ({ page }) => {
  await page.goto('/?fixture=bazel');
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
  const scopes = await page.evaluate(() => {
    const lines = [
      'doc = r"""A raw multiline string',
      'with \\n and "quotes"',
      '"""',
      'café = 0x2a + 0o52 + 0b101010 + 1.5e2',
      'doc = \'\'\'Another multiline string',
      'with \\' + "'single quotes" ,
      "'''",
      'enabled = True # reset after triple quotes',
      'text = "unterminated',
      'still_code = False',
    ];
    const tokens = window.playground.monaco.editor.tokenize(lines.join('\n'), 'starlark');
    const tokenFor = (line: number, word: string) => [...tokens[line]].reverse().find(token => token.offset <= lines[line].indexOf(word))?.type;
    return {
      raw: tokenFor(1, '\\n'), unicode: tokenFor(3, 'café'),
      numbers: ['0x2a', '0o52', '0b101010', '1.5e2'].map(value => tokenFor(3, value)),
      singleDoc: tokenFor(5, 'single'), afterTriple: tokenFor(7, 'True'), afterUnterminated: tokenFor(9, 'False'),
    };
  });
  expect(scopes).toEqual({
    raw: 'string.starlark', unicode: 'attribute.name.starlark', numbers: Array(4).fill('number.starlark'),
    singleDoc: 'string.starlark', afterTriple: 'keyword.starlark', afterUnterminated: 'keyword.starlark',
  });
});
