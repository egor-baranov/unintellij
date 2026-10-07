import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { referenceEditorOptions } from '../theme';
import { getSettings, subscribeSettings } from './store';
import { syntaxTokenNames } from './syntax';
import type { AppSettings, SyntaxKey } from './types';
import './appearance.css';

export function editorAppearance(): Monaco.editor.IStandaloneEditorConstructionOptions {
  const { editor, ui } = getSettings();
  return { ...referenceEditorOptions, fontFamily: editor.fontFamily, fontSize: editor.fontSize * ui.scale,
    lineHeight: Math.max(editor.fontSize, editor.lineHeight) * ui.scale, fontLigatures: editor.ligatures };
}
const light = (hex: string) => {
  const components = hex.slice(1, 7).match(/../g)!.map(value => parseInt(value, 16));
  return components[0] * .2126 + components[1] * .7152 + components[2] * .0722 > 145;
};
export function editorTheme(settings: AppSettings): Monaco.editor.IStandaloneThemeData {
  const { editor, syntax, diff } = settings.colors;
  const rules = settings.editor.syntaxHighlight
    ? (Object.entries(syntaxTokenNames) as Array<[SyntaxKey, string[]]>).flatMap(([key, tokens]) => tokens.map(token => ({
      token, foreground: syntax[key].foreground.slice(1, 7), fontStyle: [syntax[key].bold ? 'bold' : '', syntax[key].italic ? 'italic' : ''].filter(Boolean).join(' '),
    }))) : [{ token: '', foreground: editor.foreground.slice(1, 7), fontStyle: '' }];
  return { base: light(editor.background) ? 'vs' : 'vs-dark', inherit: false, rules,
    colors: {
      'editor.background': editor.background, 'editor.foreground': editor.foreground,
      'editorLineNumber.foreground': editor.lineNumber, 'editorLineNumber.activeForeground': editor.foreground,
      'editor.lineHighlightBackground': editor.background, 'editor.selectionBackground': editor.selection,
      'editor.inactiveSelectionBackground': editor.selection, 'editorCursor.foreground': editor.caret,
      'editorGutter.background': editor.background, 'editorWidget.background': settings.colors.popups.background,
      'editorWidget.foreground': settings.colors.popups.foreground, 'editorWidget.border': settings.colors.popups.border,
      'input.background': settings.colors.popups.background, 'input.foreground': settings.colors.popups.foreground,
      'input.border': settings.colors.popups.border, 'focusBorder': settings.colors.popups.accent,
      'editor.findMatchBackground': settings.colors.diff.modifiedInner, 'editor.findMatchBorder': editor.caret,
      'editor.findMatchHighlightBackground': settings.colors.diff.modified, 'scrollbar.shadow': '#00000000',
      // Native inline diffs require translucent fills so selections and search
      // matches remain visible beneath overlapping character decorations.
      'diffEditor.insertedLineBackground': `${diff.added.slice(0, 7)}cc`,
      'diffEditor.removedLineBackground': `${diff.removed.slice(0, 7)}cc`,
      'diffEditor.insertedTextBackground': `${diff.addedInner.slice(0, 7)}99`,
      'diffEditor.removedTextBackground': `${diff.removedInner.slice(0, 7)}99`,
      'diffEditorGutter.insertedLineBackground': diff.added,
      'diffEditorGutter.removedLineBackground': diff.removed,
      'diffEditor.unchangedRegionBackground': settings.colors.window.background,
      'diffEditor.unchangedRegionForeground': settings.colors.window.muted,
      'diffEditor.unchangedRegionShadow': '#00000000',
      'diffEditor.unchangedCodeBackground': '#00000000',
      'scrollbarSlider.background': `${editor.lineNumber.slice(0, 7)}55`, 'scrollbarSlider.hoverBackground': `${editor.lineNumber.slice(0, 7)}88`,
      'scrollbarSlider.activeBackground': `${editor.lineNumber.slice(0, 7)}aa`,
    } };
}

/** Installed only by the hosts. The reusable diff package owns no global theme. */
export function installAppearance(monaco: typeof Monaco): () => void {
  const root = document.documentElement;
  const apply = () => {
    const settings = getSettings();
    root.dataset.appearance = 'custom';
    root.style.colorScheme = light(settings.colors.window.background) ? 'light' : 'dark';
    root.dataset.iconTheme = light(settings.colors.window.background) ? 'light' : 'dark';
    const set = (key: string, value: string | number) => root.style.setProperty(`--${key}`, String(value));
    set('ui-scale', settings.ui.scale);
    set('ui-row-scale', settings.ui.scale * Math.max(1, settings.ui.fontSize / 13));
    set('ui-text-scale', settings.ui.scale * settings.ui.fontSize / 13);
    set('ui-font-family', settings.ui.fontFamily); set('ui-font-size', `${settings.ui.fontSize * settings.ui.scale}px`);
    set('code-font-family', settings.editor.fontFamily);
    for (const key of ['window', 'sidebar', 'tabs', 'popups', 'editor', 'diff', 'tree'] as const) {
      for (const [field, value] of Object.entries(settings.colors[key])) set(`${key}-${field.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value);
    }
    for (const [field, value] of Object.entries(settings.colors.popups)) set(`settings-${field}`, value);
    // Icon files are bundled dark variants. Only neutral action/folder icons are
    // adjusted on light surfaces; language/status icon colors stay intact.
    for (const key of ['window', 'sidebar', 'tabs', 'popups'] as const) set(`${key}-icon-filter`, light(settings.colors[key].background) ? 'brightness(.48)' : 'none');
    const lightSidebar = light(settings.colors.sidebar.background);
    set('status-added', lightSidebar ? '#287537' : '#72bc79'); set('status-modified', lightSidebar ? '#235f98' : '#91b8e3'); set('status-untracked', lightSidebar ? '#a93a39' : '#ea8d8a');
    monaco.editor.defineTheme('smart-diff-custom', editorTheme(settings));
    monaco.editor.setTheme('smart-diff-custom');
  };
  apply();
  return subscribeSettings(apply);
}
