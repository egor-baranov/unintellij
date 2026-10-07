import { describe, expect, it } from 'vitest';
import { defaultSettings } from './model';
import { syntaxStyleForToken } from './syntax';

describe('shared syntax styles for Monaco and search snippets', () => {
  it('maps YAML punctuation and document markers to the configurable operator style', () => {
    const settings = structuredClone(defaultSettings);
    settings.colors.syntax.operator = { foreground: '#123456', bold: true, italic: false };
    for (const token of ['operators.yaml', 'operators.directivesEnd.yaml', 'operators.documentEnd.yaml', 'operator.yaml']) {
      expect(syntaxStyleForToken(token, settings)).toEqual(settings.colors.syntax.operator);
    }
  });

  it('uses the JSON key scope ahead of the broader string scope', () => {
    const settings = structuredClone(defaultSettings);
    settings.colors.syntax.attribute = { foreground: '#123456', bold: true, italic: false };
    settings.colors.syntax.string = { foreground: '#abcdef', bold: false, italic: true };
    for (const token of ['string.key.json', 'string.key.json.embedded']) expect(syntaxStyleForToken(token, settings)).toEqual(settings.colors.syntax.attribute);
    for (const token of ['string', 'string.json', 'string.value.json']) expect(syntaxStyleForToken(token, settings)).toEqual(settings.colors.syntax.string);
  });

  it('resolves qualified type identifiers and broad types without confusing identifiers', () => {
    const settings = structuredClone(defaultSettings);
    settings.colors.syntax.type = { foreground: '#123456', bold: true, italic: true };
    settings.colors.syntax.identifier = { foreground: '#abcdef', bold: false, italic: false };
    for (const token of ['type.identifier', 'type.identifier.ts', 'type', 'type.ts']) expect(syntaxStyleForToken(token, settings)).toEqual(settings.colors.syntax.type);
    expect(syntaxStyleForToken('identifier.ts', settings)).toEqual(settings.colors.syntax.identifier);
  });

  it('requires dot-delimited scope prefixes rather than matching arbitrary string prefixes', () => {
    const settings = structuredClone(defaultSettings);
    settings.colors.syntax.text = { foreground: '#101010', bold: false, italic: false };
    settings.colors.syntax.string = { foreground: '#202020', bold: true, italic: false };
    settings.colors.syntax.attribute = { foreground: '#303030', bold: false, italic: true };
    for (const token of ['typeidentifier', 'keywordish', 'identifierSuffix', 'unknown.scope']) expect(syntaxStyleForToken(token, settings)).toEqual(settings.colors.syntax.text);
    expect(syntaxStyleForToken('string.key.jsonish', settings)).toEqual(settings.colors.syntax.string);
    expect(syntaxStyleForToken('attribute.name.jsx', settings)).toEqual(settings.colors.syntax.attribute);
  });

  it('uses the editor foreground without bold or italic when syntax highlighting is disabled', () => {
    const settings = structuredClone(defaultSettings);
    settings.editor.syntaxHighlight = false;
    settings.colors.editor.foreground = '#345678';
    settings.colors.syntax.keyword = { foreground: '#ffffff', bold: true, italic: true };
    const before = structuredClone(settings);
    for (const token of ['', 'keyword.ts', 'string.key.json', 'type.identifier', 'comment', 'unknown.scope']) {
      expect(syntaxStyleForToken(token, settings)).toEqual({ foreground: '#345678', bold: false, italic: false });
    }
    expect(settings).toEqual(before);
  });

  it('preserves all custom style properties and reflects subsequent settings changes', () => {
    const settings = structuredClone(defaultSettings);
    settings.colors.syntax.keyword = { foreground: '#a1b2c3', bold: true, italic: true };
    expect(syntaxStyleForToken('keyword.control.ts', settings)).toEqual({ foreground: '#a1b2c3', bold: true, italic: true });
    settings.colors.syntax.keyword = { foreground: '#d4e5f6', bold: false, italic: true };
    expect(syntaxStyleForToken('keyword.control.ts', settings)).toEqual({ foreground: '#d4e5f6', bold: false, italic: true });
  });

  it('uses the configured plain-text style for empty scopes, JSX text and unknown scopes', () => {
    const settings = structuredClone(defaultSettings);
    settings.colors.syntax.text = { foreground: '#789abc', bold: true, italic: true };
    for (const token of ['', 'jsx.text', 'jsx.text.tsx', 'invalid']) expect(syntaxStyleForToken(token, settings)).toEqual(settings.colors.syntax.text);
  });
});
