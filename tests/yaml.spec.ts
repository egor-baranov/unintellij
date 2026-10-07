import { expect, test } from '@playwright/test';
import { helmYaml, plainYaml } from '../apps/playground/src/yaml-fixture';

test('YAML and Helm actions paint in both diff panes on cold load and after file switching', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?fixture=language-helm-yaml');
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
  await page.evaluate(() => window.playground.setPreferences({ collapse: false }));
  const languages = () => page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    return [editors.original, editors.modified].map(editor => editor.getModel()!.getLanguageId());
  });
  await expect.poll(languages).toEqual(['yaml', 'yaml']);
  for (const side of ['original', 'modified']) {
    const spans = page.locator(`[data-side="${side}"] .view-line span`);
    for (const [text, color] of [['if', 'rgb(192, 133, 255)'], ['fail', 'rgb(255, 203, 107)'], ['apiVersion', 'rgb(255, 203, 107)'], ['true', 'rgb(192, 133, 255)']]) {
      await expect.poll(() => spans.evaluateAll((nodes, text) => {
        const node = nodes.find(node => node.textContent?.trim() === text);
        return node && getComputedStyle(node).color;
      }, text)).toBe(color);
    }
  }
  await page.screenshot({ path: 'artifacts/yaml/helm-diff.png' });
  await page.evaluate(() => window.playground.selectFixture('language-yaml'));
  await expect.poll(languages).toEqual(['yaml', 'yaml']);
  const result = await page.evaluate(async source => {
    const { monaco } = window.playground;
    await monaco.editor.colorize(source, 'yaml', {});
    const tokens = monaco.editor.tokenize(source, 'yaml');
    const lines = source.split('\n');
    return ['# Chart', 'apiVersion', '"1.0.0"', 'true', '---', 'null'].map(word => {
      const line = lines.findIndex(line => line.includes(word)), offset = lines[line].indexOf(word);
      return [...tokens[line]].reverse().find(token => token.offset <= offset)?.type;
    });
  }, plainYaml);
  expect(result).toEqual(['comment.yaml', 'type.yaml', 'string.yaml', 'keyword.yaml', 'operators.directivesEnd.yaml', 'keyword.yaml']);
  await page.evaluate(() => window.playground.selectFixture('language-helm-yaml'));
  await expect.poll(languages).toEqual(['yaml', 'yaml']);
  expect(errors).toEqual([]);
});

test('Helm expressions preserve strings, comments, nested YAML flows and block-scalar state', async ({ page }) => {
  await page.goto('/?fixture=language-helm-yaml');
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
  await page.evaluate(() => window.playground.setPreferences({ collapse: false }));
  const lines = [
    '{{- /* multiline template comment',
    '   if .Values.fake }} still comment',
    '*/ -}}',
    '{{- $message := "literal }} delimiter" -}}',
    '{{- $raw := `raw }} string` -}}',
    '{{- if',
    '  and .Values.enabled (gt .Values.count 2)',
    '}}',
    'enabled: true',
    'quoted: "before {{ printf "ready" }} after"',
    'flow: {name: {{ .Release.Name }}, enabled: false}',
    'items: [{{ .Values.mode | quote }}, "ready", 42]',
    'body: |',
    '  hello {{ .Release.Name }} after',
    '  still literal',
    'next: false',
    '{{- end }}',
    '# {{ this is a YAML comment }}',
    'plain: "no template here"',
    '{{ _helper .Values.name }}',
  ];
  const probes: [number, string, string][] = [
    [1, 'if', 'comment'], [3, 'literal', 'string'], [4, 'raw }}', 'string'],
    [5, 'if', 'keyword'], [6, '.Values.enabled', 'identifier'], [6, '2', 'number'],
    [8, 'true', 'keyword'], [9, 'printf', 'type.identifier'], [9, 'ready', 'string'], [9, 'after', 'string'],
    [10, '.Release.Name', 'identifier'], [10, 'false', 'keyword'], [11, 'ready', 'string'], [11, '42', 'number'],
    [13, '.Release.Name', 'identifier'], [13, 'after', 'string'], [14, 'still literal', 'string'],
    [15, 'next', 'type'], [15, 'false', 'keyword'], [16, 'end', 'keyword'], [17, 'this', 'comment'],
    [19, '_helper', 'type.identifier'],
  ];
  const actual = await page.evaluate(async ({ lines, probes }) => {
    const { monaco } = window.playground;
    const source = lines.join('\n');
    await monaco.editor.colorize(source, 'yaml', {});
    const tokens = monaco.editor.tokenize(source, 'yaml');
    return probes.map(([line, word]) => [...tokens[line]].reverse().find(token => token.offset <= lines[line].indexOf(word))?.type);
  }, { lines, probes });
  for (const [index, [line, word, type]] of probes.entries()) {
    expect.soft(actual[index], `line ${line + 1}: ${word}`).toMatch(new RegExp(`^${type.replaceAll('.', '\\.')}\\.yaml$`));
  }
  // A model edit must invalidate the previous template state, not leak a comment
  // or string into the next version of the document.
  await page.evaluate(source => window.playground.setContents(source, source), helmYaml);
  await expect.poll(() => page.locator('[data-side="modified"] .view-line span').evaluateAll(nodes => {
    const node = nodes.find(node => node.textContent === 'apiVersion');
    return node && getComputedStyle(node).color;
  })).toBe('rgb(255, 203, 107)');
});
