import type { AppSettings, SyntaxKey, SyntaxStyle } from './types';

/** Shared by the Monaco theme and lightweight code snippets outside an editor. */
export const syntaxTokenNames: Record<SyntaxKey, string[]> = {
  text: ['', 'jsx.text'], identifier: ['identifier'], keyword: ['keyword'], string: ['string', 'attribute.value'], number: ['number'],
  comment: ['comment'], type: ['type.identifier', 'type'], operator: ['operator', 'operators', 'delimiter'], tag: ['tag'], attribute: ['attribute.name', 'string.key.json'],
};

const scopes = (Object.entries(syntaxTokenNames) as Array<[SyntaxKey, string[]]>)
  .flatMap(([key, names]) => names.map(name => ({ key, name })))
  .sort((a, b) => b.name.length - a.name.length);

/** Monaco token themes use the most specific dot-delimited scope prefix. */
export function syntaxStyleForToken(token: string, settings: AppSettings): SyntaxStyle {
  if (!settings.editor.syntaxHighlight) return { foreground: settings.colors.editor.foreground, bold: false, italic: false };
  const key = scopes.find(({ name }) => !name || token === name || token.startsWith(`${name}.`))!.key;
  return settings.colors.syntax[key];
}
