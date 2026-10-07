import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grammars, injections } from 'tm-grammars';
import { Registry, INITIAL, type IRawGrammar, type StateStack } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { defaultSettings } from '../settings/model';
import { syntaxStyleForToken } from '../settings/syntax';
import { textmateScopesToToken } from './textmateScopes';

const require = createRequire(import.meta.url);
const grammarInfo = [...grammars, ...injections];
let registry: Registry;

beforeAll(async () => {
  await loadWASM(await readFile(require.resolve('vscode-oniguruma/release/onig.wasm')));
  registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: patterns => new OnigScanner(patterns), createOnigString: value => new OnigString(value) }),
    loadGrammar: async scope => {
      const info = grammarInfo.find(grammar => grammar.scopeName === scope);
      return info ? JSON.parse(await readFile(require.resolve(`tm-grammars/grammars/${info.name}.json`), 'utf8')) as IRawGrammar : null;
    },
    getInjections: scope => {
      const name = grammarInfo.find(grammar => grammar.scopeName === scope)?.name;
      return injections.filter(grammar => name && grammar.embeddedIn?.includes(name)).map(grammar => grammar.scopeName);
    },
  });
});

afterAll(() => registry?.dispose());

async function tokensFor(name: string, code: string) {
  const info = grammarInfo.find(grammar => grammar.name === name)!;
  const grammar = (await registry.loadGrammar(info.scopeName))!;
  let state: StateStack = INITIAL;
  return code.split('\n').flatMap(line => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    return result.tokens.map(token => ({ text: line.slice(token.startIndex, token.endIndex), token: textmateScopesToToken(token.scopes) }));
  });
}

describe('TextMate scopes in the existing syntax palette', () => {
  it('distinguishes TOML keys, sections, strings, booleans, numbers and dates', async () => {
    const tokens = await tokensFor('toml', 'title = "hello"\n[package]\nenabled = true\ncount = 42\ntime = 1979-05-27T07:32:00Z');
    expect(tokens).toEqual(expect.arrayContaining([
      { text: 'title', token: 'attribute.name' }, { text: 'package', token: 'type.identifier' },
      { text: 'hello', token: 'string' }, { text: 'true', token: 'keyword' },
      { text: '42', token: 'number' }, { text: '1979-05-27T07:32:00Z', token: 'number' },
    ]));
  });

  it('colors Vue template tags and embedded TypeScript without theme replacement', async () => {
    const tokens = await tokensFor('vue', '<template>\n<div title="hello">{{ count + 2 }}</div>\n</template>\n<script setup lang="ts">\nconst count: number = 1\n</script>');
    expect(tokens).toEqual(expect.arrayContaining([
      { text: 'div', token: 'tag' }, { text: 'title', token: 'attribute.name' }, { text: 'hello', token: 'string' },
      { text: 'const', token: 'keyword' }, { text: 'count', token: 'identifier' }, { text: 'number', token: 'type.identifier' },
      { text: '+', token: 'operator' }, { text: '2', token: 'number' },
    ]));
  });

  it('escapes the enclosing Svelte attribute string for embedded expressions', async () => {
    const tokens = await tokensFor('svelte', '<button title="Count {count + 1}">Hello</button>\n{#if ready}<Widget foo={42} />{/if}');
    expect(tokens).toEqual(expect.arrayContaining([
      { text: 'Count ', token: 'string' }, { text: 'count', token: 'identifier' }, { text: '+', token: 'operator' },
      { text: '1', token: 'number' }, { text: 'Hello', token: '' }, { text: 'if', token: 'keyword' },
      { text: 'Widget', token: 'tag' }, { text: 'foo', token: 'attribute.name' },
    ]));
  });

  it('keeps Make interpolation variables and functions distinct from literal text', async () => {
    const tokens = await tokensFor('make', 'all: build\n\techo "Hello $(NAME)"\nOBJECTS := $(wildcard *.o)');
    expect(tokens).toEqual(expect.arrayContaining([
      { text: 'all', token: 'type.identifier' }, { text: 'NAME', token: 'identifier' },
      { text: 'OBJECTS', token: 'identifier' }, { text: 'wildcard', token: 'type.identifier' },
    ]));
  });

  it('distinguishes diff headers, ranges, deletions and insertions using palette tokens', async () => {
    const tokens = await tokensFor('diff', 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-before\n+after');
    expect(tokens).toEqual(expect.arrayContaining([
      { text: 'diff --git a/a.txt b/a.txt', token: 'type.identifier' }, { text: '-1 +1', token: 'number' },
      { text: 'before', token: 'keyword' }, { text: 'after', token: 'string' },
      { text: '-', token: 'keyword' }, { text: '+', token: 'string' },
    ]));
  });

  it('preserves comments and string escapes while allowing explicit interpolation', () => {
    expect(textmateScopesToToken(['source.js', 'comment.block.documentation.js', 'storage.type.class.js'])).toBe('comment');
    expect(textmateScopesToToken(['source.js', 'string.quoted.double.js', 'constant.character.escape.js'])).toBe('string');
    expect(textmateScopesToToken(['source.js', 'string.template.js', 'meta.template.expression.js', 'keyword.control.js'])).toBe('keyword');
    expect(textmateScopesToToken(['source.svelte', 'string.quoted.svelte', 'meta.embedded.expression.svelte', 'source.ts'])).toBe('');
    expect(textmateScopesToToken(['source.toml', 'variable.other.key.toml', 'punctuation.definition.variable.begin.toml'])).toBe('attribute.name');
    expect(textmateScopesToToken(['source.unknown', 'keywordish', 'entity.name-tagged', 'unknown.scope'])).toBe('');
  });

  it('inherits custom color, bold, italic and the highlighting toggle from current settings', () => {
    const settings = structuredClone(defaultSettings);
    settings.colors.syntax.keyword = { foreground: '#123456', bold: true, italic: true };
    const token = textmateScopesToToken(['source.toml', 'constant.language.boolean.toml']);
    expect(syntaxStyleForToken(token, settings)).toEqual(settings.colors.syntax.keyword);
    settings.editor.syntaxHighlight = false;
    expect(syntaxStyleForToken(token, settings)).toEqual({ foreground: settings.colors.editor.foreground, bold: false, italic: false });
  });
});
