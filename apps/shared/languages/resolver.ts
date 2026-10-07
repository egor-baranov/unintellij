import { applicationLanguageDefinitions } from './registry';
import { additionalLanguageDefinitions } from './additional';
import type { LanguageDefinition } from './types';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Earlier definitions win conflicting associations. No filesystem reads or Monaco globals. */
export function createLanguageResolver(definitions: readonly LanguageDefinition[]): (path: string, firstLine?: string) => string {
  const filenames = new Map<string, string>();
  const extensions = new Map<string, string>();
  const caseSensitiveExtensions = new Map<string, string>();
  const patterns: { expression: RegExp; id: string }[] = [];
  const firstLines: { expression: RegExp; id: string }[] = [];

  for (const definition of definitions) {
    for (const filename of definition.filenames ?? []) {
      const key = filename.toLowerCase();
      if (!filenames.has(key)) filenames.set(key, definition.id);
    }
    for (const extension of definition.extensions ?? []) {
      const key = extension.toLowerCase();
      if (!extensions.has(key)) extensions.set(key, definition.id);
    }
    for (const extension of definition.caseSensitiveExtensions ?? []) {
      if (!caseSensitiveExtensions.has(extension)) caseSensitiveExtensions.set(extension, definition.id);
    }
    for (const pattern of definition.filenamePatterns ?? []) {
      patterns.push({ expression: new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i'), id: definition.id });
    }
    if (definition.firstLine) firstLines.push({ expression: new RegExp(definition.firstLine), id: definition.id });
  }

  // Monaco has first-line metadata for only some script languages. These aliases
  // cover interpreters without inspecting source beyond an optional first line.
  const ids = new Set(definitions.map(({ id }) => id));
  const interpreters: readonly [string, RegExp][] = [
    ['shell', /\b(?:ba|da|k|z)?sh\b/],
    ['python', /\bpython(?:[0-9.]+)?\b/],
    ['javascript', /\b(?:node|nodejs|deno|bun)\b/],
    ['ruby', /\bruby(?:[0-9.]+)?\b/],
    ['perl', /\bperl(?:[0-9.]+)?\b/],
    ['php', /\bphp(?:[0-9.]+)?\b/],
    ['powershell', /\bpwsh\b/],
  ];

  return (path, firstLine) => {
    const name = path.replaceAll('\\', '/').split('/').at(-1) ?? '';
    if (!name) return 'plaintext';
    const lowerName = name.toLowerCase();
    const filenameLanguage = filenames.get(lowerName);
    if (filenameLanguage) return filenameLanguage;
    const patternLanguage = patterns.find(({ expression }) => expression.test(name));
    if (patternLanguage) return patternLanguage.id;

    // Start at the first dot: .d.ts and other compound suffixes win over .ts.
    for (let index = name.indexOf('.'); index !== -1; index = name.indexOf('.', index + 1)) {
      const extension = name.slice(index);
      const language = caseSensitiveExtensions.get(extension) ?? extensions.get(extension.toLowerCase());
      if (language) return language;
    }

    // Explicit text and binary file types must not inherit an interpreter merely
    // because their displayed contents happen to begin with a shebang.
    if (/\.(?:txt|text|log|csv|tsv|svgz|png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|bz2|xz|7z|tar|exe|dll|so|dylib|wasm|bin|woff2?|ttf|otf|mp[34]|mov|wav)$/i.test(name)) return 'plaintext';
    const line = firstLine?.split(/\r?\n/, 1)[0];
    if (line && !line.includes('\0')) {
      const metadataLanguage = firstLines.find(({ expression }) => expression.test(line));
      if (metadataLanguage) return metadataLanguage.id;
      if (line.startsWith('#!')) {
        const interpreter = interpreters.find(([id, expression]) => ids.has(id) && expression.test(line));
        if (interpreter) return interpreter[0];
      }
    }
    return 'plaintext';
  };
}

export const allLanguageDefinitions = [...applicationLanguageDefinitions, ...additionalLanguageDefinitions];
export const resolveLanguageForPath = createLanguageResolver(allLanguageDefinitions);
