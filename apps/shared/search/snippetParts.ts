import type { FileSearchResult } from './types';

export interface SnippetToken { offset: number; type: string }
export interface SnippetPart { text: string; token: string; match: boolean }

/** Keep source UTF-16 offsets until slicing; a match stays one mark even across tokens. */
export function snippetParts(result: Pick<FileSearchResult, 'snippet' | 'snippetStartColumn' | 'matches'>, tokens: readonly SnippetToken[]): SnippetPart[] {
  const { snippet } = result;
  const parts: SnippetPart[] = [];
  const firstMatchOffset = Math.max(0, (result.matches[0]?.column ?? result.snippetStartColumn) - result.snippetStartColumn);
  const indentation = snippet.slice(0, firstMatchOffset).match(/^\s*/)?.[0].length ?? 0;
  // Retain the existing bounded context and keep the first match visible in narrow rows.
  let offset = firstMatchOffset > 80 ? Math.max(indentation, firstMatchOffset - 24) : indentation;
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(snippet[offset]) && /[\uD800-\uDBFF]/.test(snippet[offset - 1])) offset--;
  if (offset > indentation || result.snippetStartColumn > 1) parts.push({ text: '…', token: '', match: false });

  function appendCode(start: number, end: number) {
    if (start >= end) return;
    let cursor = start;
    let scope = '';
    for (const token of tokens) {
      if (token.offset <= cursor) { scope = token.type; continue; }
      if (token.offset >= end) break;
      parts.push({ text: snippet.slice(cursor, token.offset), token: scope, match: false });
      cursor = token.offset; scope = token.type;
    }
    parts.push({ text: snippet.slice(cursor, end), token: scope, match: false });
  }

  for (const match of result.matches) {
    const start = Math.max(0, match.column - result.snippetStartColumn);
    const end = Math.min(snippet.length, match.column - result.snippetStartColumn + match.length);
    if (end <= offset || start >= snippet.length) continue;
    appendCode(offset, start);
    parts.push({ text: snippet.slice(Math.max(offset, start), end), token: '', match: true });
    offset = end;
  }
  appendCode(offset, snippet.length);
  return parts;
}
