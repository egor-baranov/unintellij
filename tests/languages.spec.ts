import { expect, test, type Page } from '@playwright/test';
import { languageSyntaxSamples, type LanguageSyntaxSample } from '../apps/playground/src/language-fixtures';
import { allLanguageDefinitions, resolveLanguageForPath } from '../apps/shared/languages/resolver';
import { additionalLanguageDefinitions } from '../apps/shared/languages/additional';

const tokenColors = {
  keyword: 'rgb(192, 133, 255)', string: 'rgb(195, 232, 141)', comment: 'rgb(105, 118, 143)',
  number: 'rgb(255, 203, 107)', type: 'rgb(255, 203, 107)', tag: 'rgb(240, 113, 120)',
};

async function open(page: Page, fixture = 'reference'): Promise<void> {
  await page.goto(`/?fixture=${fixture}`);
  await expect.poll(() => page.evaluate(() => window.playground?.getState().status)).toBe('ready');
}

async function inspectSample(page: Page, sample: LanguageSyntaxSample) {
  return page.evaluate(async sample => {
    const { monaco } = window.playground;
    const model = monaco.editor.createModel(sample.source, sample.language);
    const root = document.createElement('pre');
    root.className = 'monaco-editor';
    root.style.cssText = 'position:absolute;left:-10000px;top:0;';
    document.body.append(root);
    try {
      const html = await monaco.editor.colorize(model.getValue(), model.getLanguageId(), {});
      const tokenLines = monaco.editor.tokenize(model.getValue(), model.getLanguageId());
      const lines = sample.source.split('\n');
      const paintedLines = html.split(/<br\s*\/?\s*>/i);
      return {
        language: model.getLanguageId(),
        probes: sample.probes.map(probe => {
          const line = lines.findIndex(text => text.includes(probe.text));
          const column = lines[line]?.indexOf(probe.text) ?? -1;
          const scope = [...(tokenLines[line] ?? [])].reverse().find(token => token.offset <= column)?.type;
          root.innerHTML = paintedLines[line] ?? '';
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let offset = 0;
          let color: string | undefined;
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const length = node.textContent?.length ?? 0;
            if (column >= offset && column < offset + length) {
              color = getComputedStyle(node.parentElement!).color;
              break;
            }
            offset += length;
          }
          return { text: probe.text, scope, color };
        }),
      };
    } finally {
      model.dispose();
      root.remove();
    }
  }, sample);
}

test('extra grammars and the syntax engine load on demand from bundled local assets', async ({ page }) => {
  const requests: string[] = [];
  const failed: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  await open(page);
  await page.waitForLoadState('networkidle');
  expect(requests.filter(url => /\.wasm(?:\?|$)/.test(url))).toEqual([]);
  expect(requests.filter(url => /\/textmate-[^/]*\.js(?:\?|$)/.test(url))).toEqual([]);

  const sample = languageSyntaxSamples.find(sample => sample.key === 'vue')!;
  const result = await inspectSample(page, sample);
  expect(result.probes[0].scope).toMatch(/^keyword(?:\.|$)/);
  expect(result.probes[0].color).toBe(tokenColors.keyword);
  expect(requests.filter(url => /\.wasm(?:\?|$)/.test(url))).toHaveLength(1);
  expect(requests.filter(url => /^https?:/.test(url) && new URL(url).origin !== new URL(page.url()).origin)).toEqual([]);
  expect(failed).toEqual([]);
});

for (const provider of ['Monaco', 'TextMate']) {
  test(`${provider} samples produce semantic token scopes and the configured painted colors`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    for (const sample of languageSyntaxSamples.filter(sample => sample.language.startsWith('textmate-') === (provider === 'TextMate'))) {
      await test.step(`${sample.name}: ${sample.path}`, async () => {
        expect(resolveLanguageForPath(sample.path)).toBe(sample.language);
        const result = await inspectSample(page, sample);
        expect(result.language).toBe(sample.language);
        for (const [index, probe] of sample.probes.entries()) {
          const actual = result.probes[index];
          const scopePattern = probe.token === 'string' ? /^(?:string|attribute\.value)(?:\.|$)/ : new RegExp(`^${probe.token}(?:\\.|$)`);
          expect.soft(actual.scope, `${sample.name}: ${probe.text}`).toMatch(scopePattern);
          expect.soft(actual.color, `${sample.name}: ${probe.text}`).toBe(tokenColors[probe.token]);
        }
      });
    }
  });
}

test('every advertised grammar can be installed and tokenized in the production browser bundle', async ({ page }) => {
  test.setTimeout(180_000);
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  await open(page);
  const ids = [...new Set(allLanguageDefinitions.map(({ id }) => id))];
  const registered = await page.evaluate(() => window.playground.monaco.languages.getLanguages().map(({ id }) => id));
  expect(ids.filter(id => !registered.includes(id))).toEqual([]);
  expect(additionalLanguageDefinitions.length).toBeGreaterThan(150);
  const results = await page.evaluate(async ids => {
    const { monaco } = window.playground;
    const results: { id: string; error?: string }[] = [];
    for (const id of ids) {
      try {
        const source = '# sample\n// sample\nconst value = "ready";\nvalue = 42\n';
        await monaco.editor.colorize(source, id, {});
        const tokens = monaco.editor.tokenize(source, id);
        const lines = source.split('\n');
        if (tokens.length !== lines.length || tokens.some((line, index) => lines[index].length > 0 && (!line.length || line[0].offset !== 0))) {
          results.push({ id, error: 'Invalid tokenizer line boundaries' });
        }
      } catch (error) {
        results.push({ id, error: String(error) });
      }
    }
    return results;
  }, ids);
  expect(results).toEqual([]);
  expect(failures).toEqual([]);
});

test('extra grammar state updates after edits and both panes retain syntax through file switching', async ({ page }) => {
  await open(page, 'language-vue');
  const languageIds = () => page.evaluate(() => {
    const editors = window.playground.viewer!.getEditors();
    return [editors.original, editors.modified].map(editor => editor.getModel()!.getLanguageId());
  });
  await expect.poll(languageIds).toEqual(['textmate-vue', 'textmate-vue']);
  const edited = '<script setup lang="ts">\n/* A multiline comment\nconst hidden = "inside";\n*/\nconst visible = "ready";\n</script>\n<template><h1>{{ visible }}</h1></template>\n';
  await page.evaluate(value => {
    const app = window.playground;
    app.setContents(value, value.replace('ready', 'running'));
  }, edited);
  await expect.poll(() => page.evaluate(() => window.playground.viewer!.getEditors().modified.getModel()!.getValue())).toContain('const visible');
  const scopes = await page.evaluate(async source => {
    const { monaco, viewer } = window.playground;
    const model = viewer!.getEditors().modified.getModel()!;
    await monaco.editor.colorize(model.getValue(), model.getLanguageId(), {});
    const tokens = monaco.editor.tokenize(model.getValue(), model.getLanguageId());
    const lines = source.split('\n');
    return [2, 4].map(line => [...tokens[line]].reverse().find(token => token.offset <= lines[line].indexOf('const'))?.type);
  }, edited);
  expect(scopes).toEqual(['comment', 'keyword']);
  for (const side of ['original', 'modified']) {
    await expect.poll(() => page.locator(`[data-side="${side}"] .view-line span`).evaluateAll(spans => {
      const keyword = spans.find(span => span.textContent === 'const');
      return keyword && getComputedStyle(keyword).color;
    })).toBe(tokenColors.keyword);
  }
  await page.evaluate(() => window.playground.selectFixture('language-java'));
  await expect.poll(languageIds).toEqual(['java', 'java']);
  await page.evaluate(() => window.playground.selectFixture('language-vue'));
  await expect.poll(languageIds).toEqual(['textmate-vue', 'textmate-vue']);
  await expect.poll(() => page.evaluate(() => window.playground.getState().status)).toBe('ready');
});

test('supplemental grammar colors follow live syntax settings and disabling highlighting', async ({ page }) => {
  await open(page, 'language-vue');
  const keyword = page.locator('.smart-diff-pane[data-side="modified"] .view-lines span').filter({ hasText: /^const\s*$/ }).first();
  await expect(keyword).toHaveCSS('color', tokenColors.keyword);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Syntax Colors', exact: true }).click();
  await settings.getByRole('textbox', { name: 'Keywords color', exact: true }).fill('#be127e');
  await expect(keyword).toHaveCSS('color', 'rgb(190, 18, 126)');
  await settings.getByRole('checkbox', { name: 'Syntax highlighting', exact: true }).uncheck();
  // With one foreground color Monaco merges adjacent token spans. Inspect the
  // text node's painted color without requiring the old token DOM boundaries.
  await expect.poll(() => page.locator('.smart-diff-pane[data-side="modified"] .view-line').evaluateAll(lines => {
    const line = lines.find(line => /const\s+message/.test(line.textContent ?? ''));
    if (!line) return undefined;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.includes('const')) return getComputedStyle(walker.currentNode.parentElement!).color;
    }
    return undefined;
  })).toBe('rgb(195, 206, 227)');
  await settings.getByRole('checkbox', { name: 'Syntax highlighting', exact: true }).check();
  await expect(keyword).toHaveCSS('color', 'rgb(190, 18, 126)');
});
