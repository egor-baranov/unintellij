import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { monacoLanguageDefinitions, jsonLanguageDefinition, languageAliases } from './registry';
import { createLanguageResolver } from './resolver';
import type { LanguageDefinition } from './types';

const packageDirectory = dirname(createRequire(import.meta.url).resolve('monaco-editor/package.json'));
const contributionsDirectory = join(packageDirectory, 'esm/vs/basic-languages');
const contributionNames = readdirSync(contributionsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();

function installedDefinitions(): LanguageDefinition[] {
  const definitions: LanguageDefinition[] = [];
  for (const name of contributionNames) {
    const source = readFileSync(join(contributionsDirectory, name, `${name}.contribution.js`), 'utf8');
    // Contributions are declarative registerLanguage calls. Strip their shared
    // browser registrar so metadata can be verified without a DOM or tokenizers.
    runInNewContext(source.replace(/^import .*;\n/gm, ''), {
      registerLanguage: (definition: LanguageDefinition & { loader: unknown }) => {
        expect(typeof definition.loader).toBe('function');
        const { loader: _loader, ...metadata } = definition;
        definitions.push(JSON.parse(JSON.stringify(metadata)) as LanguageDefinition);
      },
    });
  }
  return definitions;
}

describe('bundled language coverage', () => {
  it('tracks all metadata from the pinned Monaco package, including multi-language contributions', () => {
    expect(monacoLanguageDefinitions).toEqual(installedDefinitions());
    expect(monacoLanguageDefinitions.map(({ id }) => id)).toContain('mdx');
    expect(new Set(monacoLanguageDefinitions.map(({ id }) => id)).size).toBe(monacoLanguageDefinitions.length);
  });

  it('registers every contribution without eagerly importing tokenizer modules', () => {
    const source = readFileSync(new URL('./contributions.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports).toEqual(contributionNames.map((name) => name === 'yaml' ? './yaml.contribution' : `monaco-editor/esm/vs/basic-languages/${name}/${name}.contribution.js`));
    const yaml = readFileSync(new URL('./yaml.contribution.ts', import.meta.url), 'utf8');
    expect(yaml).toContain("await import('./yaml')");
    expect(yaml).toContain('monacoLanguageDefinitions.find');
  });

  it('matches the dedicated JSON provider metadata', () => {
    const source = readFileSync(join(packageDirectory, 'esm/vs/language/json/monaco.contribution.js'), 'utf8');
    const registration = source.match(/languages\.register\((\{[\s\S]*?\})\);/);
    expect(registration).not.toBeNull();
    expect(runInNewContext(`(${registration![1]})`)).toEqual(jsonLanguageDefinition);
  });

  it('resolves every registered filename and extension in isolation', () => {
    for (const definition of [...monacoLanguageDefinitions, jsonLanguageDefinition, ...languageAliases]) {
      const resolve = createLanguageResolver([definition]);
      for (const extension of definition.extensions ?? []) {
        expect(resolve(`project/example${extension}`), `${definition.id}: ${extension}`).toBe(definition.id);
      }
      for (const filename of definition.filenames ?? []) {
        expect(resolve(`project/${filename}`), `${definition.id}: ${filename}`).toBe(definition.id);
      }
      for (const extension of definition.caseSensitiveExtensions ?? []) {
        expect(resolve(`project/example${extension}`)).toBe(definition.id);
      }
      for (const pattern of definition.filenamePatterns ?? []) {
        expect(resolve(`project/${pattern.replaceAll('*', 'production')}`)).toBe(definition.id);
      }
    }
  });
});
