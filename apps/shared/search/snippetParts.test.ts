import { describe, expect, it } from 'vitest';
import { snippetParts, type SnippetPart } from './snippetParts';

const text = (parts: SnippetPart[]) => parts.map(part => part.text).join('');
const marks = (parts: SnippetPart[]) => parts.filter(part => part.match).map(part => part.text);

describe('Find in Files syntax snippet parts', () => {
  it('preserves UTF-16 match columns after emoji and highlights every occurrence', () => {
    const snippet = '😀 const café = "café";';
    const parts = snippetParts({ snippet, snippetStartColumn: 1, matches: [{ column: 10, length: 4 }, { column: 18, length: 4 }] }, [
      { offset: 0, type: '' }, { offset: 3, type: 'keyword.ts' }, { offset: 8, type: '' },
      { offset: 9, type: 'identifier.ts' }, { offset: 13, type: '' }, { offset: 16, type: 'string.ts' }, { offset: 22, type: 'delimiter.ts' },
    ]);
    expect(text(parts)).toBe(snippet);
    expect(marks(parts)).toEqual(['café', 'café']);
    expect(parts).toContainEqual({ text: '😀 ', token: '', match: false });
    expect(parts).toContainEqual({ text: 'const', token: 'keyword.ts', match: false });
    expect(parts.filter(part => !part.match && part.token === 'string.ts').map(part => part.text)).toEqual(['"', '"']);
  });

  it('renders a match spanning identifiers, operators and numbers as one mark', () => {
    const snippet = 'return value + 1;';
    const parts = snippetParts({ snippet, snippetStartColumn: 1, matches: [{ column: 8, length: 9 }] }, [
      { offset: 0, type: 'keyword' }, { offset: 6, type: '' }, { offset: 7, type: 'identifier' },
      { offset: 12, type: '' }, { offset: 13, type: 'operator' }, { offset: 14, type: '' },
      { offset: 15, type: 'number' }, { offset: 16, type: 'delimiter' },
    ]);
    expect(parts).toEqual([
      { text: 'return', token: 'keyword', match: false }, { text: ' ', token: '', match: false },
      { text: 'value + 1', token: '', match: true }, { text: ';', token: 'delimiter', match: false },
    ]);
    expect(text(parts)).toBe(snippet);
  });

  it('maps cropped snippets from original source columns and keeps all visible matches', () => {
    const snippet = 'prefix wanted suffix wanted';
    const parts = snippetParts({ snippet, snippetStartColumn: 101, matches: [{ column: 108, length: 6 }, { column: 122, length: 6 }] }, [
      { offset: 0, type: 'comment.ts' },
    ]);
    expect(text(parts)).toBe(`…${snippet}`);
    expect(marks(parts)).toEqual(['wanted', 'wanted']);
    expect(parts.filter(part => !part.match && part.text !== '…').every(part => part.token === 'comment.ts')).toBe(true);
  });

  it('clips boundary-crossing matches to the available snippet without losing text', () => {
    const snippet = 'tail untouched star';
    const parts = snippetParts({ snippet, snippetStartColumn: 101, matches: [{ column: 97, length: 8 }, { column: 116, length: 8 }] }, [
      { offset: 0, type: 'string' },
    ]);
    expect(text(parts)).toBe(`…${snippet}`);
    expect(marks(parts)).toEqual(['tail', 'star']);
    expect(parts).toContainEqual({ text: ' untouched ', token: 'string', match: false });
  });

  it('does not split a surrogate pair when trimming long leading context', () => {
    const snippet = `${'x'.repeat(90)}😀${'a'.repeat(23)}MATCH tail`;
    const parts = snippetParts({ snippet, snippetStartColumn: 1, matches: [{ column: 116, length: 5 }] }, [
      { offset: 0, type: 'identifier' }, { offset: 90, type: 'string' }, { offset: 115, type: 'keyword' },
    ]);
    expect(text(parts)).toBe(`…😀${'a'.repeat(23)}MATCH tail`);
    expect(marks(parts)).toEqual(['MATCH']);
    expect(parts).toContainEqual({ text: `😀${'a'.repeat(23)}`, token: 'string', match: false });
  });

  it('trims indentation without shifting the source match or subsequent token boundaries', () => {
    const snippet = '    const value = 42;';
    const parts = snippetParts({ snippet, snippetStartColumn: 1, matches: [{ column: 11, length: 5 }] }, [
      { offset: 0, type: '' }, { offset: 4, type: 'keyword' }, { offset: 9, type: '' },
      { offset: 10, type: 'identifier' }, { offset: 15, type: '' }, { offset: 18, type: 'number' }, { offset: 20, type: 'delimiter' },
    ]);
    expect(text(parts)).toBe('const value = 42;');
    expect(marks(parts)).toEqual(['value']);
    expect(parts).toContainEqual({ text: '42', token: 'number', match: false });
    expect(parts[0]).toEqual({ text: 'const', token: 'keyword', match: false });
  });

  it('retains separate adjacent occurrences and unstyled source when no tokens are available', () => {
    const snippet = '😀😀 tail';
    const parts = snippetParts({ snippet, snippetStartColumn: 1, matches: [{ column: 1, length: 2 }, { column: 3, length: 2 }] }, []);
    expect(text(parts)).toBe(snippet);
    expect(marks(parts)).toEqual(['😀', '😀']);
    expect(parts.at(-1)).toEqual({ text: ' tail', token: '', match: false });
  });

  it('preserves ordinary tokenized text when the snippet has no matches', () => {
    const snippet = 'const size = 3;';
    const parts = snippetParts({ snippet, snippetStartColumn: 1, matches: [] }, [
      { offset: 0, type: 'keyword' }, { offset: 5, type: '' }, { offset: 6, type: 'identifier' },
      { offset: 10, type: '' }, { offset: 13, type: 'number' }, { offset: 14, type: 'delimiter' },
    ]);
    expect(text(parts)).toBe(snippet);
    expect(marks(parts)).toEqual([]);
    expect(parts).toContainEqual({ text: 'const', token: 'keyword', match: false });
    expect(parts).toContainEqual({ text: '3', token: 'number', match: false });
  });
});
