/** The semantic token names already styled by the application's syntax palette. */
export type MonacoSyntaxToken = '' | 'identifier' | 'keyword' | 'string' | 'number' | 'comment'
  | 'type.identifier' | 'operator' | 'delimiter' | 'tag' | 'attribute.name';

const is = (scope: string, prefix: string) => scope === prefix || scope.startsWith(`${prefix}.`);
const any = (scope: string, prefixes: readonly string[]) => prefixes.some(prefix => is(scope, prefix));

function semanticToken(scope: string): MonacoSyntaxToken | undefined {
  if (any(scope, ['comment', 'punctuation.definition.comment'])) return 'comment';
  if (any(scope, ['entity.name.tag', 'support.class.component', 'punctuation.definition.tag'])) return 'tag';
  if (any(scope, ['entity.other.attribute-name', 'variable.other.key', 'support.type.property-name',
    'support.type.vendored.property-name', 'string.key'])) return 'attribute.name';
  if (any(scope, ['string', 'constant.character', 'punctuation.definition.string', 'markup.inline.raw',
    'markup.inserted', 'punctuation.definition.inserted'])) return 'string';
  if (any(scope, ['constant.numeric', 'constant.other.date', 'constant.other.time', 'constant.other.timestamp',
    'markup.changed', 'punctuation.definition.changed', 'meta.diff.range', 'meta.toc-list.line-number'])) return 'number';
  if (is(scope, 'keyword.operator')) return 'operator';
  if (any(scope, ['keyword', 'storage', 'constant.language', 'constant.other', 'support.constant', 'variable.language',
    'punctuation.definition.keyword', 'markup.deleted', 'punctuation.definition.deleted'])) return 'keyword';
  if (any(scope, ['entity.name.function', 'entity.name.type', 'entity.name.class', 'entity.name.struct', 'entity.name.enum',
    'entity.name.interface', 'entity.name.namespace', 'entity.name.module', 'entity.name.section', 'entity.other.inherited-class',
    'support.function', 'support.type', 'support.class', 'meta.diff.header', 'markup.heading'])) return 'type.identifier';
  if (any(scope, ['variable', 'entity.name', 'support.variable'])) return 'identifier';
  if (is(scope, 'punctuation')) return 'delimiter';
  return undefined;
}

/** Collapse TextMate's outer-to-inner scope stack without taking ownership of themes.
 * Literal contents keep their string/comment color until an embedded expression
 * starts; identifiers and keywords inside that expression use the code palette.
 */
export function textmateScopesToToken(scopes: readonly string[]): MonacoSyntaxToken {
  let token: MonacoSyntaxToken = '';
  let literal = false;
  for (const scope of scopes) {
    // Make's $(...) is itself named string.interpolated, while web grammars
    // normally put source.ts or meta.embedded inside the enclosing string.
    if (any(scope, ['source', 'meta.embedded', 'meta.interpolation', 'meta.template.expression',
      'string.interpolated', 'punctuation.section.embedded', 'punctuation.section.interpolation'])) {
      literal = false;
      token = is(scope, 'string.interpolated') ? 'string' : '';
    }
    if (literal) continue;
    const semantic = semanticToken(scope);
    if (!semantic) continue;
    // A punctuation capture inside a named token belongs to that token (for
    // example comment markers, quoted keys, and diff insertion/deletion signs).
    if (semantic !== 'delimiter' || !token) token = semantic;
    if (semantic === 'comment' || (semantic === 'string' && is(scope, 'string') && !is(scope, 'string.interpolated'))) literal = true;
  }
  return token;
}
