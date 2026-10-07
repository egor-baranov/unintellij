import type { TreeTheme } from '../project/theme';
export type SurfaceKey = 'window' | 'sidebar' | 'tabs' | 'popups';
export interface SurfaceColors {
  background: string; foreground: string; muted: string; border: string; selection: string; accent: string;
}
export type SyntaxKey = 'text' | 'identifier' | 'keyword' | 'string' | 'number' | 'comment' | 'type' | 'operator' | 'tag' | 'attribute';
export interface SyntaxStyle { foreground: string; bold: boolean; italic: boolean }
export interface EditorColors { background: string; foreground: string; lineNumber: string; selection: string; caret: string }
export interface DiffColors { added: string; removed: string; modified: string; addedInner: string; removedInner: string; modifiedInner: string }
export interface AppSettings {
  version: 1;
  name: string;
  ui: { fontFamily: string; fontSize: number; scale: number };
  editor: { fontFamily: string; fontSize: number; lineHeight: number; ligatures: boolean; syntaxHighlight: boolean };
  colors: Record<SurfaceKey, SurfaceColors> & { editor: EditorColors; diff: DiffColors; tree: TreeTheme; syntax: Record<SyntaxKey, SyntaxStyle> };
}
export interface SchemeImport { settings: AppSettings; warnings: string[]; format: 'smart-diff' | 'intellij-editor' | 'intellij-theme' }
