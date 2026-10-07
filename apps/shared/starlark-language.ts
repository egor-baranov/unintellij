import type { languages } from 'monaco-editor/esm/vs/editor/editor.api.js';

export const starlarkLanguageId = 'starlark';

export const starlarkConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [
    { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
    { open: '"', close: '"' }, { open: "'", close: "'" },
  ],
  folding: { offSide: true },
  indentationRules: {
    increaseIndentPattern: /^\s*(?:def|for|if|elif|else)\b.*:\s*(?:#.*)?$/,
    decreaseIndentPattern: /^\s*(?:elif|else)\b/,
  },
};

function stringRules(quote: string, triple: boolean, raw = false): languages.IMonarchLanguageRule[] {
  return [
    [new RegExp(quote.repeat(triple ? 3 : 1)), 'string', '@pop'],
    [/\\./, raw ? 'string' : 'string.escape'],
    [/\\$/, 'string'], // An escaped newline continues the string on the next line.
    ...(!triple ? [[new RegExp(`[^\\\\${quote}]+$`), 'string', '@pop'] as languages.IMonarchLanguageRule] : []),
    [new RegExp(`[^\\\\${quote}]+`), 'string'],
    [new RegExp(quote), 'string'],
  ];
}

/** Host-owned lexical highlighting based on https://github.com/bazelbuild/starlark/blob/master/spec.md.
 * This is not a Python alias: load, Bazel rule calls, raw strings, and multiline
 * docstrings are colored without introducing Python imports or f-string syntax.
 */
export const starlarkLanguage: languages.IMonarchLanguage = {
  tokenPostfix: '.starlark',
  unicode: true,
  keywords: ['and', 'break', 'continue', 'def', 'elif', 'else', 'for', 'if', 'in', 'lambda', 'load', 'not', 'or', 'pass', 'return'],
  constants: ['True', 'False', 'None'],
  tokenizer: {
    root: [
      [/[ \t\r\n]+/, ''],
      [/#.*$/, 'comment'],
      [/[rR]"""/, 'string', '@rawTripleDouble'],
      [/[rR]'''/, 'string', '@rawTripleSingle'],
      [/"""/, 'string', '@tripleDouble'],
      [/'''/, 'string', '@tripleSingle'],
      [/[rR]"/, 'string', '@rawDouble'],
      [/[rR]'/, 'string', '@rawSingle'],
      [/"/, 'string', '@double'],
      [/'/, 'string', '@single'],
      [/0[xX][\da-fA-F]+|0[oO][0-7]+|0[bB][01]+/, 'number'],
      [/(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/, 'number'],
      [/[\p{L}_][\p{L}\p{Nd}_]*/u, {
        cases: { '@keywords': 'keyword', '@constants': 'keyword', '@default': { token: '@rematch', next: '@identifier' } },
      }],
      [/[{}\[\]()]/, '@brackets'],
      [/[.,:;]/, 'delimiter'],
      [/[+\-*/%<>=!&|^~]+/, 'operator'],
      [/\\$/, ''],
    ],
    identifier: [
      [/[\p{L}_][\p{L}\p{Nd}_]*(?=\s*\()/u, 'type.identifier', '@pop'],
      [/[\p{L}_][\p{L}\p{Nd}_]*(?=\s*=(?!=))/u, 'attribute.name', '@pop'],
      [/[\p{L}_][\p{L}\p{Nd}_]*/u, 'identifier', '@pop'],
    ],
    single: stringRules("'", false), double: stringRules('"', false),
    tripleSingle: stringRules("'", true), tripleDouble: stringRules('"', true),
    rawSingle: stringRules("'", false, true), rawDouble: stringRules('"', false, true),
    rawTripleSingle: stringRules("'", true, true), rawTripleDouble: stringRules('"', true, true),
  },
};
