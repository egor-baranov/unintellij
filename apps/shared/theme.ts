import type { editor } from 'monaco-editor/esm/vs/editor/editor.api.js';

/** Presentation owned by these hosts; importing the viewer package never installs a theme. */
export const referenceThemeName = 'smart-diff-reference';
export const referenceEditorOptions: editor.IStandaloneEditorConstructionOptions = {
  fontFamily: '"JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 16,
  lineHeight: 23,
  fontWeight: '400',
  letterSpacing: 0,
  fontLigatures: false,
  minimap: { enabled: false },
  stickyScroll: { enabled: false },
  padding: { top: 0, bottom: 0 },
  guides: { indentation: false, bracketPairs: false },
  bracketPairColorization: { enabled: false },
  renderLineHighlight: 'none',
  scrollbar: {
    verticalScrollbarSize: 6, horizontalScrollbarSize: 6,
    useShadows: false, verticalHasArrows: false, horizontalHasArrows: false,
  },
};

export const referenceTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: '', foreground: 'C3CEE3', fontStyle: '' },
    { token: 'identifier', foreground: 'C3CEE3', fontStyle: '' },
    { token: 'type.identifier', foreground: 'FFCB6B', fontStyle: '' },
    { token: 'comment', foreground: '69768F', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'C085FF', fontStyle: '' },
    { token: 'string', foreground: 'C3E88D', fontStyle: '' },
    { token: 'number', foreground: 'FFCB6B', fontStyle: '' },
    { token: 'delimiter', foreground: '89DDFF', fontStyle: '' },
    { token: 'delimiter.bracket', foreground: '89DDFF', fontStyle: '' },
    { token: 'operator', foreground: '89DDFF', fontStyle: '' },
    { token: 'operators', foreground: '89DDFF', fontStyle: '' },
    { token: 'tag', foreground: 'F07178', fontStyle: '' },
    { token: 'attribute.name', foreground: 'FFCB6B', fontStyle: '' },
    { token: 'jsx.text', foreground: 'C3CEE3', fontStyle: '' },
  ],
  colors: {
    'editor.background': '#101119', 'editor.foreground': '#C3CEE3',
    'editorLineNumber.foreground': '#606B82', 'editorLineNumber.activeForeground': '#ABB6CB',
    'editor.lineHighlightBackground': '#101119', 'editor.selectionBackground': '#39476D',
    'editor.inactiveSelectionBackground': '#29324D', 'editorCursor.foreground': '#C3CEE3',
    'editor.findMatchBackground': '#796C365C', 'editor.findMatchBorder': '#D2B15F',
    'editor.findMatchHighlightBackground': '#796C363A',
    'editorIndentGuide.background1': '#202432', 'editorIndentGuide.activeBackground1': '#31384B',
    'editorBracketHighlight.foreground1': '#89DDFF', 'editorBracketHighlight.foreground2': '#89DDFF',
    'editorBracketHighlight.foreground3': '#89DDFF', 'editorBracketHighlight.foreground4': '#89DDFF',
    'editorBracketHighlight.foreground5': '#89DDFF', 'editorBracketHighlight.foreground6': '#89DDFF',
    'editorWidget.background': '#212326', 'editorWidget.border': '#393E49',
    'editorGutter.background': '#101119',
    'scrollbarSlider.background': '#75819A32', 'scrollbarSlider.hoverBackground': '#75819A65',
    'scrollbarSlider.activeBackground': '#75819A85', 'scrollbar.shadow': '#00000000',
    'focusBorder': '#758CB6',
  },
};
