import type { languages } from 'monaco-editor/esm/vs/editor/editor.api.js';
import { conf, language as typescript } from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js';

export const tsxLanguageId = 'smart-diff-tsx';

/** A host-scoped JSX extension of Monaco's pinned TypeScript Monarch grammar.
 * The regular TypeScript provider remains untouched. This is lexical coloring,
 * not parsing or structural ancestry: comparison and folding never use it.
 */
const jsxStart: languages.IMonarchLanguageRule[] = [
  // TSX permits constrained generics. They are TypeScript, not opening JSX tags.
  [/<(?=[A-Za-z_$][\w$]*\s+extends\b)/, 'delimiter'],
  [/(<)([A-Za-z][\w.:-]*)(?=[\s/>]|$)/, ['delimiter', { token: 'tag', next: '@jsxTag' }]],
  [/<>/, { token: 'delimiter', next: '@jsxContent' }],
];
export const tsxLanguage: languages.IMonarchLanguage = {
  ...typescript,
  tokenPostfix: '.tsx',
  tokenizer: {
    ...typescript.tokenizer,
    common: [
      // An expression-introducing keyword is not a generic call identifier.
      // Leave '<' for jsxStart so `return <Panel />` and fragments retain JSX.
      [/(return|yield|await|throw)(\s+)(?=<)/, ['keyword', '']],
      // Consume an angle directly following a code identifier as TypeScript.
      // Otherwise useState<Preferences>() could enter JSX state indefinitely.
      [/([A-Za-z_$][\w$]*)(\s*)(<)(?=[A-Za-z_$])/, ['identifier', '', 'delimiter']],
      ...jsxStart,
      ...typescript.tokenizer.common,
    ],
    jsxTag: [
      [/\/>/, 'delimiter', '@pop'],
      [/>/, { token: 'delimiter', switchTo: '@jsxContent' }],
      [/[\w:-]+/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/"/, 'string', '@string_double'],
      [/'/, 'string', '@string_single'],
      [/\{/, 'delimiter.bracket', '@jsxExpression'],
      [/[ \t\r\n]+/, ''],
    ],
    jsxContent: [
      [/(<\/)([A-Za-z][\w.:-]*)(\s*>)/, ['delimiter', 'tag', { token: 'delimiter', next: '@pop' }]],
      [/<\/>/, 'delimiter', '@pop'],
      ...jsxStart,
      [/\{/, 'delimiter.bracket', '@jsxExpression'],
      [/[^<{]+/, 'jsx.text'],
    ],
    jsxExpression: [
      [/\{/, 'delimiter.bracket', '@jsxExpression'],
      [/\}/, 'delimiter.bracket', '@pop'],
      { include: 'common' },
    ],
  },
};
export const tsxConfiguration = conf;
