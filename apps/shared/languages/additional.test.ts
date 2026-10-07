import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { grammars, injections } from 'tm-grammars';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INITIAL, Registry, type IRawGrammar, type StateStack } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { additionalLanguageDefinitions, registerAdditionalLanguages } from './additional';
import { additionalCatalog } from './additionalCatalog';
import { grammarImports } from './grammarImports';
import { applicationLanguageDefinitions } from './registry';
import { createLanguageResolver, resolveLanguageForPath } from './resolver';
import { createTextmateTokensProvider, loadTextmateGrammar, textmateInjections } from './textmate';

const require = createRequire(import.meta.url);
const loaded = new Map<string, IRawGrammar>();
let registry: Registry;

beforeAll(async () => {
  await Promise.all(Object.entries(grammarImports).map(async ([scope, load]) => {
    loaded.set(scope, (await load()).default as IRawGrammar);
  }));
  await loadWASM(await readFile(require.resolve('vscode-oniguruma/release/onig.wasm')));
  registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: patterns => new OnigScanner(patterns), createOnigString: value => new OnigString(value) }),
    loadGrammar: loadTextmateGrammar,
    getInjections: textmateInjections,
  });
});

afterAll(() => registry?.dispose());

describe('bundled supplemental language catalog', () => {
  it('retries an interrupted line once from its incoming state and uses only complete tokens', () => {
    const incomingStack = { equals: (other: StateStack) => other === incomingStack } as StateStack;
    const partialState = { equals: () => false } as unknown as StateStack;
    const tokenizeLine = vi.fn()
      .mockReturnValueOnce({ stoppedEarly: false, ruleStack: incomingStack, tokens: [] })
      .mockReturnValueOnce({ stoppedEarly: true, ruleStack: partialState, tokens: [{ startIndex: 0, endIndex: 5, scopes: ['string.quoted'] }] })
      .mockReturnValueOnce({ stoppedEarly: false, ruleStack: INITIAL, tokens: [{ startIndex: 0, endIndex: 5, scopes: ['keyword.control'] }] });
    const provider = createTextmateTokensProvider({ tokenizeLine });
    const incoming = provider.tokenize('previous line', provider.getInitialState()).endState;
    tokenizeLine.mockClear();
    const result = provider.tokenize('const', incoming);
    expect(tokenizeLine).toHaveBeenCalledTimes(2);
    expect(tokenizeLine.mock.calls[0][1]).toBe(incomingStack);
    expect(tokenizeLine.mock.calls[1][1]).toBe(incomingStack);
    expect(result.tokens).toEqual([{ startIndex: 0, scopes: 'keyword' }]);
    expect(result.endState.equals(provider.getInitialState())).toBe(true);
  });

  it('uses neutral tokens and preserves the incoming state after two interrupted attempts', () => {
    const incomingStack = { equals: (other: StateStack) => other === incomingStack } as StateStack;
    const partialState = { equals: () => false } as unknown as StateStack;
    const tokenizeLine = vi.fn().mockReturnValueOnce({ stoppedEarly: false, ruleStack: incomingStack, tokens: [] }).mockReturnValue({
      stoppedEarly: true, ruleStack: partialState, tokens: [{ startIndex: 0, endIndex: 5, scopes: ['string.quoted'] }],
    });
    const provider = createTextmateTokensProvider({ tokenizeLine });
    const incoming = provider.tokenize('previous line', provider.getInitialState()).endState;
    tokenizeLine.mockClear();
    const result = provider.tokenize('const', incoming);
    expect(tokenizeLine).toHaveBeenCalledTimes(2);
    expect(tokenizeLine.mock.calls[0][1]).toBe(incomingStack);
    expect(tokenizeLine.mock.calls[1][1]).toBe(incomingStack);
    expect(result.tokens).toEqual([{ startIndex: 0, scopes: '' }]);
    expect(result.endState.equals(incoming)).toBe(true);
    provider.tokenize('next line', result.endState);
    expect(tokenizeLine.mock.calls[2][1]).toBe(incomingStack);
  });

  it('keeps the pinned upstream catalog, license evidence and imported grammar bytes in sync', async () => {
    const evidence = JSON.parse(await readFile(new URL('../../../licenses/textmate-grammars-sources.json', import.meta.url), 'utf8')) as {
      name: string; scopeName: string; source: string; sha: string; sha256: string; license?: string; verifiedLicenseFile?: string;
      verifiedLicenseUrl?: string; verifiedLicense?: string;
    }[];
    const permitted = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC']);
    const selected = [...grammars, ...injections].filter(item => permitted.has(item.license ?? '') || ['toml', 'sass', 'yaml'].includes(item.name));
    expect(additionalCatalog.map(item => item.name)).toEqual(selected.map(item => item.name));
    expect(evidence.map(item => item.name)).toEqual(additionalCatalog.map(item => item.name));
    expect(new Set(additionalCatalog.map(item => item.id)).size).toBe(additionalCatalog.length);
    expect(new Set(additionalCatalog.map(item => item.scopeName)).size).toBe(additionalCatalog.length);
    expect(Object.keys(grammarImports)).toEqual(additionalCatalog.map(item => item.scopeName));
    for (const item of evidence) {
      const bytes = await readFile(require.resolve(`tm-grammars/grammars/${item.name}.json`));
      expect(createHash('sha256').update(bytes).digest('hex'), item.name).toBe(item.sha256);
      expect(item.source, item.name).toMatch(/^https:\/\//);
      expect(item.sha, item.name).toMatch(/^[0-9a-f]{40}$/);
      expect(permitted.has(item.license ?? '') || Boolean(item.verifiedLicenseFile), item.name).toBe(true);
      if (item.verifiedLicenseFile) expect((await readFile(new URL(`../../../licenses/${item.verifiedLicenseFile}`, import.meta.url), 'utf8')).length).toBeGreaterThan(100);
      expect(loaded.get(item.scopeName)?.scopeName, item.name).toBe(item.scopeName);
    }
    expect(evidence.find(item => item.name === 'yaml')).toMatchObject({
      verifiedLicenseFile: 'textmate-yaml-MIT.txt', verifiedLicense: 'MIT',
      verifiedLicenseUrl: 'https://raw.githubusercontent.com/textmate/yaml.tmbundle/e54ceae3b719506dba7e481a77cea4a8b576ae46/Syntaxes/YAML-license.txt',
    });
  });

  it('registers factories without loading the engine and keeps injection grammars out of filename selection', () => {
    const register = vi.fn();
    const dispose = vi.fn();
    const registerTokensProviderFactory = vi.fn(() => ({ dispose }));
    const monaco = { languages: { register, registerTokensProviderFactory } } as unknown as typeof Monaco;
    const disposables = registerAdditionalLanguages(monaco);
    expect(register).toHaveBeenCalledTimes(additionalLanguageDefinitions.length);
    expect(registerTokensProviderFactory).toHaveBeenCalledTimes(additionalLanguageDefinitions.length);
    expect(disposables).toHaveLength(additionalLanguageDefinitions.length);
    for (const definition of additionalLanguageDefinitions) {
      expect(register).toHaveBeenCalledWith({ id: definition.id, aliases: definition.aliases });
      expect(additionalCatalog.find(item => item.id === definition.id)).not.toHaveProperty('embeddedIn');
    }
    for (const disposable of disposables) disposable.dispose();
    expect(dispose).toHaveBeenCalledTimes(additionalLanguageDefinitions.length);
  });

  it('loads and tokenizes every selected grammar with local dependencies and injection metadata', async () => {
    for (const definition of additionalCatalog) {
      const grammar = await registry.loadGrammar(definition.scopeName);
      expect(grammar, definition.name).not.toBeNull();
      let state: StateStack = INITIAL;
      for (const line of ['let value = "hello";', '# comment', '<section class="example">42</section>']) {
        const result = grammar!.tokenizeLine(line, state);
        state = result.ruleStack;
        expect(result.stoppedEarly, definition.name).toBe(false);
        expect(result.tokens.length, definition.name).toBeGreaterThan(0);
        expect(result.tokens[0].startIndex, definition.name).toBe(0);
        expect(result.tokens.every(token => token.scopes.every(scope => typeof scope === 'string')), definition.name).toBe(true);
      }
    }
  });

  it('resolves historical embedded scopes without changing the canonical grammar or losing injections', async () => {
    for (const [alias, canonical] of [['source.vue', 'text.html.vue'], ['source.c++', 'source.cpp']]) {
      const aliased = await loadTextmateGrammar(alias);
      expect(aliased?.scopeName).toBe(alias);
      expect((await loadTextmateGrammar(canonical))?.scopeName).toBe(canonical);
      expect(textmateInjections(alias)).toEqual(textmateInjections(canonical));
      expect(await registry.loadGrammar(alias)).not.toBeNull();
    }
    expect(textmateInjections('source.vue')).toContain('vue.interpolations');
    const cpp = (await registry.loadGrammar('source.c++'))!;
    const tokens = cpp.tokenizeLine('int value = 42;', INITIAL).tokens;
    expect(tokens.some(token => token.scopes.some(scope => scope.startsWith('constant.numeric')))).toBe(true);
    const vue = (await registry.loadGrammar('source.vue'))!;
    let state: StateStack = INITIAL;
    const vueScopes: string[] = [];
    for (const line of ['<template>', '<div>{{ count + 2 }}</div>', '</template>']) {
      const result = vue.tokenizeLine(line, state);
      state = result.ruleStack;
      vueScopes.push(...result.tokens.flatMap(token => token.scopes));
    }
    expect(vueScopes).toContain('constant.numeric.decimal.ts');
    expect(await loadTextmateGrammar('source.missing-language')).toBeNull();
    expect(await loadTextmateGrammar('__proto__')).toBeNull();
  });

  it('highlights YAML embedded in Vue custom blocks and Markdown frontmatter', async () => {
    for (const [scope, lines] of [
      ['text.html.vue', ['<i18n lang="yaml">', 'message: hello', 'count: 42', '</i18n>']],
      ['text.html.markdown', ['---', 'message: hello', 'count: 42', '---']],
    ] as const) {
      const grammar = (await registry.loadGrammar(scope))!;
      let state: StateStack = INITIAL;
      const scopes: string[] = [];
      for (const line of lines) {
        const result = grammar.tokenizeLine(line, state);
        state = result.ruleStack;
        scopes.push(...result.tokens.flatMap(token => token.scopes));
      }
      expect(scopes.some(scope => scope.startsWith('constant.numeric') && scope.endsWith('.yaml')), scope).toBe(true);
    }
  });

  it.each([
    ['Cargo.toml', 'toml'], ['src/App.vue', 'vue'], ['src/App.svelte', 'svelte'],
    ['Makefile', 'make'], ['GNUmakefile', 'make'], ['Makefile.local', 'make'], ['rules.mk', 'make'],
    ['CMakeLists.txt', 'cmake'], ['cmake/toolchain.cmake', 'cmake'],
    ['build.gradle', 'groovy'], ['Jenkinsfile', 'groovy'], ['deploy.fish', 'fish'],
    ['styles.sass', 'sass'], ['settings.json5', 'json5'], ['events.ndjson', 'jsonl'],
    ['.env', 'dotenv'], ['.env.production', 'dotenv'], ['change.diff', 'diff'], ['change.patch', 'diff'],
    ['requests.http', 'http'], ['requests.rest', 'http'], ['CODEOWNERS', 'codeowners'],
    ['COMMIT_EDITMSG', 'git-commit'], ['git-rebase-todo', 'git-rebase'],
    ['table.csv', 'csv'], ['table.tsv', 'tsv'], ['flake.nix', 'nix'], ['schema.prisma', 'prisma'],
    ['main.zig', 'zig'], ['document.typ', 'typst'], ['site.astro', 'astro'],
  ])('selects bundled syntax for %s', (path, name) => {
    expect(resolveLanguageForPath(path)).toBe(`textmate-${name}`);
  });

  it('preserves host and Monaco providers for all of their existing filename associations', () => {
    const primary = createLanguageResolver(applicationLanguageDefinitions);
    for (const definition of applicationLanguageDefinitions) {
      for (const extension of [...(definition.extensions ?? []), ...(definition.caseSensitiveExtensions ?? [])]) {
        const path = `example${extension}`;
        expect(resolveLanguageForPath(path), path).toBe(primary(path));
      }
      for (const path of definition.filenames ?? []) expect(resolveLanguageForPath(path), path).toBe(primary(path));
    }
    expect(resolveLanguageForPath('App.tsx')).toBe('smart-diff-tsx');
    expect(resolveLanguageForPath('BUILD.bazel')).toBe('starlark');
    expect(resolveLanguageForPath('settings.jsonc')).toBe('json');
    expect(resolveLanguageForPath('build.gradle.kts')).toBe('kotlin');
  });

  it.each(['image.png', 'archive.zip', 'program.wasm', 'font.woff2', 'library.class', 'module.pyc', 'module.pyd',
    'compiled.elc', 'compressed.svgz', 'notes.txt', 'debug.log', 'data.dat', 'data.bin', 'plain.text', 'LICENSE', 'README',
    'config', 'dependency.lock', 'file.unknown-extension'])('leaves %s plain rather than borrowing an unrelated grammar', path => {
    expect(resolveLanguageForPath(path)).toBe('plaintext');
  });
});
