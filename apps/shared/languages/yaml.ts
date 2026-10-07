import type { languages } from 'monaco-editor/esm/vs/editor/editor.api.js';
import { conf, language as yaml } from 'monaco-editor/esm/vs/basic-languages/yaml/yaml.js';

export { conf };

type Rule = languages.IMonarchLanguageRule;

/** Extend the pinned YAML provider rather than maintain a second YAML grammar.
 * These rules only interrupt scalars at Go-template actions. The Monarch stack
 * restores the YAML context (including a quoted/flow/block scalar) on `}}`.
 * This is lexical highlighting, not Helm rendering or YAML validation.
 */
function replaceRule(rules: Rule[], pattern: RegExp, replacement: Rule): Rule[] {
  return rules.map(rule => Array.isArray(rule) && rule[0] instanceof RegExp && rule[0].source === pattern.source
    ? replacement : rule);
}

const templateStart: Rule = [/\{\{(?:-(?=\s))?/, 'delimiter', '@templateAction'];
const scalarValue: languages.IMonarchLanguageAction = { cases: { '@keywords': 'keyword', '@default': 'string' } };

let root = replaceRule(yaml.tokenizer.root, /(".*?"|'.*?'|[^#'"]*?)([ \t]*)(:)( |$)/,
  [/("(?:(?!\{\{).)*?"|'(?:(?!\{\{).)*?'|(?:(?!\{\{)[^#'"])*?)([ \t]*)(:)( |$)/,
    ['type', 'white', 'operators', 'white']]);
root = replaceRule(root, /.+?(?=(\s+#|$))/,
  [/(?:(?!\{\{).)+?(?=(\{\{|\s+#|$))/, scalarValue]);

let object = replaceRule(yaml.tokenizer.object, /(?:".*?"|'.*?'|[^,\{\[]+?)(?=: )/,
  [/(?:"(?:(?!\{\{).)*?"|'(?:(?!\{\{).)*?'|[^,\{\[]+?)(?=: )/, 'type']);
object = replaceRule(object, /[^\},]+/, [/(?:(?!\{\{)[^\},])+/, scalarValue]);
const array = replaceRule(yaml.tokenizer.array, /[^\],]+/, [/(?:(?!\{\{)[^\],])+/, scalarValue]);

export const language: languages.IMonarchLanguage = {
  ...yaml,
  templateKeywords: ['if', 'else', 'end', 'range', 'with', 'define', 'template', 'block', 'break', 'continue', 'true', 'false', 'nil'],
  tokenizer: {
    ...yaml.tokenizer,
    root: [templateStart, ...root],
    object: [templateStart, ...object],
    array: [templateStart, ...array],
    flowScalars: [
      [/"/, 'string', '@doubleQuotedString'],
      [/'/, 'string', '@singleQuotedString'],
    ],
    doubleQuotedString: [
      templateStart,
      [/(?:(?!\{\{)[^\\"])+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string', '@pop'],
    ],
    singleQuotedString: [
      templateStart,
      [/''/, 'string.escape'],
      [/(?:(?!\{\{)[^'])+/, 'string'],
      [/'/, 'string', '@pop'],
    ],
    // Remember the first content line's indentation without consuming its
    // content, so actions inside block scalars can be recognized as well.
    multiString: [
      [/^\s*$/, 'string'],
      [/^( +)/, { token: 'string', switchTo: '@multiStringContinued.$1' }],
      [/^/, { token: '@rematch', next: '@popall' }],
    ],
    multiStringContinued: [
      [/^$S2/, 'string'],
      [/^(?=\S|[ \t]+\S)/, { token: '@rematch', next: '@popall' }],
      templateStart,
      [/(?:(?!\{\{).)+/, 'string'],
    ],
    templateAction: [
      [/\s+-\}\}|\}\}/, 'delimiter', '@pop'],
      [/\s+/, 'white'],
      [/\/\*/, 'comment', '@templateComment'],
      [/"/, 'string', '@templateDoubleString'],
      [/`/, 'string', '@templateRawString'],
      [/'/, 'string', '@templateRune'],
      [/[+-]?(?:0[xX][\da-fA-F_]+(?:\.[\da-fA-F_]*)?(?:[pP][+-]?[\d_]+)?|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)(?:i)?/, 'number'],
      [/\$(?:[A-Za-z_]\w*)?(?:\.[A-Za-z_]\w*)*|\.(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?/, 'identifier'],
      [/[A-Za-z_]\w*/, { cases: { '@templateKeywords': 'keyword', '@default': 'type.identifier' } }],
      [/:=|[=|,+\-*/%<>!]/, 'operator'],
      [/[()[\]]/, 'delimiter.bracket'],
      [/./, 'delimiter'],
    ],
    templateComment: [
      [/\*\//, 'comment', '@pop'],
      [/[^*]+/, 'comment'],
      [/\*/, 'comment'],
    ],
    templateDoubleString: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
    templateRawString: [
      [/[^`]+/, 'string'],
      [/`/, 'string', '@pop'],
    ],
    templateRune: [
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, 'string', '@pop'],
    ],
  },
};
