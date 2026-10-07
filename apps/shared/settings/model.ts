import type { AppSettings, SurfaceColors, SurfaceKey, SyntaxKey, SyntaxStyle } from './types';
import { referenceTreeTheme, treeThemeForSurface } from '../project/theme';

export const surfaceKeys: SurfaceKey[] = ['window', 'sidebar', 'tabs', 'popups'];
export const syntaxKeys: SyntaxKey[] = ['text', 'identifier', 'keyword', 'string', 'number', 'comment', 'type', 'operator', 'tag', 'attribute'];
const style = (foreground: string, italic = false, bold = false): SyntaxStyle => ({ foreground, italic, bold });
const surface = (background: string, foreground = '#bcbec4', muted = '#81858d', border = '#393b40', selection = '#2e436e', accent = '#3574f0'): SurfaceColors => ({ background, foreground, muted, border, selection, accent });

/** Host defaults match the existing reference presentation. Each normalizer call
 * returns a fresh object: editing a draft never changes a preset or another host. */
export const defaultSettings: AppSettings = {
  version: 1, name: 'Reference',
  ui: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: 13, scale: 1 },
  editor: { fontFamily: '"JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace', fontSize: 16, lineHeight: 23, ligatures: false, syntaxHighlight: true },
  colors: {
    window: surface('#25272a'), sidebar: surface('#181a1b'), tabs: surface('#1b1d1f'), popups: surface('#27292c'),
    tree: { ...referenceTreeTheme },
    editor: { background: '#101119', foreground: '#c3cee3', lineNumber: '#606b82', selection: '#39476d', caret: '#c3cee3' },
    diff: { added: '#264b33', removed: '#38232c', modified: '#10242e', addedInner: '#386947', removedInner: '#623440', modifiedInner: '#204454' },
    syntax: { text: style('#c3cee3'), identifier: style('#c3cee3'), keyword: style('#c085ff'), string: style('#c3e88d'), number: style('#ffcb6b'), comment: style('#69768f', true), type: style('#ffcb6b'), operator: style('#89ddff'), tag: style('#f07178'), attribute: style('#ffcb6b') },
  },
};

function preset(name: string, surfaces: SurfaceColors[], editor: AppSettings['colors']['editor'], diff: AppSettings['colors']['diff'], syntax: string[]): AppSettings {
  const result = structuredClone(defaultSettings); result.name = name;
  surfaceKeys.forEach((key, index) => { result.colors[key] = surfaces[index]; });
  result.colors.editor = editor; result.colors.diff = diff;
  result.colors.tree = treeThemeForSurface(surfaces[1].background, surfaces[1].foreground, surfaces[1].muted, surfaces[1].selection);
  syntaxKeys.forEach((key, index) => { result.colors.syntax[key] = style(syntax[index], key === 'comment'); });
  return result;
}
export const presets: Array<{ id: string; name: string; settings: AppSettings }> = [
  { id: 'reference', name: 'Reference', settings: structuredClone(defaultSettings) },
  { id: 'darcula', name: 'Darcula', settings: preset('Darcula', [surface('#3c3f41', '#bbbbbb'), surface('#313335', '#bbbbbb'), surface('#3c3f41', '#bbbbbb'), surface('#3c3f41', '#bbbbbb')],
    { background: '#2b2b2b', foreground: '#a9b7c6', lineNumber: '#606366', selection: '#214283', caret: '#bbbbbb' },
    { added: '#294436', removed: '#484a4a', modified: '#283b4d', addedInner: '#365f43', removedInner: '#656e76', modifiedInner: '#385570' },
    ['#a9b7c6', '#a9b7c6', '#cc7832', '#6a8759', '#6897bb', '#808080', '#a9b7c6', '#a9b7c6', '#e8bf6a', '#bababa']) },
  { id: 'light', name: 'Light', settings: preset('Light', [surface('#f2f3f5', '#25272a', '#676b73', '#c6c9cf', '#d4e2ff', '#255fca'), surface('#f7f8fa', '#25272a', '#676b73', '#c6c9cf', '#d4e2ff', '#255fca'), surface('#eceef2', '#25272a', '#676b73', '#c6c9cf', '#d4e2ff', '#255fca'), surface('#ffffff', '#25272a', '#676b73', '#c6c9cf', '#d4e2ff', '#255fca')],
    { background: '#ffffff', foreground: '#202124', lineNumber: '#7a7e86', selection: '#c8dcff', caret: '#202124' },
    { added: '#e0efdd', removed: '#f5dede', modified: '#ddebf5', addedInner: '#b6dab2', removedInner: '#e8b0b0', modifiedInner: '#b2d2e8' },
    ['#202124', '#202124', '#7a2997', '#287a25', '#1750a8', '#73777f', '#845500', '#175d74', '#9c3447', '#845500']) },
  { id: 'high-contrast', name: 'High Contrast', settings: preset('High Contrast', [surface('#000000', '#ffffff', '#c5c5c5', '#ababab', '#004b70', '#1aebff'), surface('#000000', '#ffffff', '#c5c5c5', '#ababab', '#004b70', '#1aebff'), surface('#101010', '#ffffff', '#c5c5c5', '#ababab', '#004b70', '#1aebff'), surface('#101010', '#ffffff', '#c5c5c5', '#ababab', '#004b70', '#1aebff')],
    { background: '#000000', foreground: '#ffffff', lineNumber: '#bcbcbc', selection: '#005b80', caret: '#ffffff' },
    { added: '#154f20', removed: '#641f26', modified: '#004561', addedInner: '#287d35', removedInner: '#a5353f', modifiedInner: '#007598' },
    ['#ffffff', '#ffffff', '#ffff00', '#00ff85', '#ffae52', '#b8b8b8', '#5bd6ff', '#ffffff', '#ff85c2', '#ffdc7a']) },
];

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const isColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);
export function isFontFamily(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f;{}<>\\()!@]/.test(value)) return false;
  return value.split(',').every(part => {
    const family = part.trim();
    if (!family) return false;
    if (family[0] === '"' || family[0] === "'") return family.length > 2 && family.at(-1) === family[0] && /^[\p{L}\p{N} ._-]+$/u.test(family.slice(1, -1));
    return /^[\p{L}\p{N} ._-]+$/u.test(family);
  });
}
const record = (value: unknown) => isRecord(value) ? value : {};
const number = (value: unknown, fallback: number, min: number, max: number, fractional = false) => typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value)) * (fractional ? 100 : 1)) / (fractional ? 100 : 1) : fallback;
const color = (value: unknown, fallback: string) => isColor(value) ? value.toLowerCase() : fallback;
const bool = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback;
export function isSchemeName(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 100 && !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value); }

/** Upgrade only an untouched built-in tree palette from the initial semantic
 * tree release. Call once from persistence, never from editing or imports. */
export function migrateUntrackedTreeColor(settings: AppSettings): AppSettings {
  for (const { settings: preset } of presets) {
    const tree = preset.colors.tree;
    const matches = (Object.keys(tree) as Array<keyof typeof tree>).every(key =>
      settings.colors.tree[key] === (key === 'untracked' ? tree.ignored : tree[key]));
    if (matches) return { ...settings, colors: { ...settings.colors, tree: { ...settings.colors.tree, untracked: tree.untracked } } };
  }
  return settings;
}

/** Run before the untracked migration so pre-red palettes can upgrade both
 * defaults. Only untouched built-in palettes qualify; customized palettes
 * remain intact. Imports do not call this persistence-only migration. */
export function migrateDeletedTreeColor(settings: AppSettings): AppSettings {
  for (const { settings: preset } of presets) {
    const tree = preset.colors.tree;
    const matches = (Object.keys(tree) as Array<keyof typeof tree>).every(key => {
      const saved = settings.colors.tree[key];
      if (key === 'deleted') return saved === tree.untracked;
      if (key === 'untracked') return saved === tree.untracked || saved === tree.ignored;
      return saved === tree[key];
    });
    if (matches) return { ...settings, colors: { ...settings.colors, tree: { ...settings.colors.tree, deleted: tree.deleted } } };
  }
  return settings;
}

/** Persistence is recoverable: invalid/missing fields use explicit safe defaults. */
export function normalizeSettings(input: unknown): AppSettings {
  const value = record(input); const ui = record(value.ui), editor = record(value.editor), colors = record(value.colors);
  const result = structuredClone(defaultSettings);
  if (isSchemeName(value.name)) result.name = value.name.trim();
  result.ui = { fontFamily: isFontFamily(ui.fontFamily) ? ui.fontFamily.trim() : result.ui.fontFamily, fontSize: number(ui.fontSize, result.ui.fontSize, 10, 20), scale: number(ui.scale, result.ui.scale, .75, 1.5, true) };
  result.editor = { fontFamily: isFontFamily(editor.fontFamily) ? editor.fontFamily.trim() : result.editor.fontFamily, fontSize: number(editor.fontSize, result.editor.fontSize, 10, 32), lineHeight: number(editor.lineHeight, result.editor.lineHeight, 14, 56), ligatures: bool(editor.ligatures, result.editor.ligatures), syntaxHighlight: bool(editor.syntaxHighlight, result.editor.syntaxHighlight) };
  for (const key of surfaceKeys) {
    const source = record(colors[key]);
    for (const field of Object.keys(result.colors[key]) as Array<keyof SurfaceColors>) result.colors[key][field] = color(source[field], result.colors[key][field]);
  }
  // Existing v1 settings predate semantic tokens. Keep their light/custom
  // sidebar surface readable while giving the reference preset its new palette.
  if (!isRecord(colors.tree) && JSON.stringify(result.colors.sidebar) !== JSON.stringify(defaultSettings.colors.sidebar)) {
    const sidebar = result.colors.sidebar;
    result.colors.tree = treeThemeForSurface(sidebar.background, sidebar.foreground, sidebar.muted, sidebar.selection);
  }
  for (const key of ['editor', 'diff', 'tree'] as const) {
    const source = record(colors[key]); const target = result.colors[key];
    for (const field of Object.keys(target)) (target as unknown as Record<string, string>)[field] = color(source[field], (target as unknown as Record<string, string>)[field]);
  }
  const syntax = record(colors.syntax);
  for (const key of syntaxKeys) {
    const source = record(syntax[key]); const fallback = result.colors.syntax[key];
    result.colors.syntax[key] = { foreground: color(source.foreground, fallback.foreground), bold: bool(source.bold, fallback.bold), italic: bool(source.italic, fallback.italic) };
  }
  return result;
}

/** Imports are intentionally stricter than persistence; corrupt schemes fail
 * visibly instead of silently turning into the default theme. */
export function validateNativeSettings(input: unknown): AppSettings {
  const fail = (field: string): never => { throw new Error(`Invalid unintellij scheme field: ${field}.`); };
  const shape = (value: unknown, fields: string[], path: string): Record<string, unknown> => {
    if (!isRecord(value) || fields.some(field => !Object.hasOwn(value, field)) || Object.keys(value).some(field => !fields.includes(field))) return fail(path);
    return value;
  };
  const value = shape(input, ['version', 'name', 'ui', 'editor', 'colors'], 'root');
  if (value.version !== 1) fail('version (supported: 1)');
  if (!isSchemeName(value.name)) fail('name');
  const ui = shape(value.ui, ['fontFamily', 'fontSize', 'scale'], 'ui');
  const editor = shape(value.editor, ['fontFamily', 'fontSize', 'lineHeight', 'ligatures', 'syntaxHighlight'], 'editor');
  for (const [part, label] of [[ui, 'ui'], [editor, 'editor']] as const) {
    if (!isFontFamily(part.fontFamily)) fail(`${label}.fontFamily`);
    for (const field of label === 'ui' ? ['fontSize', 'scale'] : ['fontSize', 'lineHeight']) if (typeof part[field] !== 'number' || !Number.isFinite(part[field])) fail(`${label}.${field}`);
  }
  for (const [value, field, min, max] of [[ui.fontSize, 'ui.fontSize', 10, 20], [ui.scale, 'ui.scale', .75, 1.5], [editor.fontSize, 'editor.fontSize', 10, 32], [editor.lineHeight, 'editor.lineHeight', 14, 56]] as const) {
    if (typeof value !== 'number' || value < min || value > max) fail(`${field} (allowed: ${min}–${max})`);
  }
  for (const field of ['ligatures', 'syntaxHighlight']) if (typeof editor[field] !== 'boolean') fail(`editor.${field}`);
  // Tree colors were added to v1; accept earlier exports and fill their defaults.
  const hasTree = isRecord(value.colors) && Object.hasOwn(value.colors, 'tree');
  const colors = shape(value.colors, [...surfaceKeys, 'editor', 'diff', 'syntax', ...(hasTree ? ['tree'] : [])], 'colors');
  for (const key of [...surfaceKeys, 'editor', 'diff', ...(hasTree ? ['tree' as const] : [])] as const) {
    const part = shape(colors[key], Object.keys(defaultSettings.colors[key]), `colors.${key}`);
    for (const field of Object.keys(part)) if (!isColor(part[field])) fail(`colors.${key}.${field}`);
  }
  const syntax = shape(colors.syntax, syntaxKeys, 'colors.syntax');
  for (const key of syntaxKeys) {
    const item = shape(syntax[key], ['foreground', 'bold', 'italic'], `colors.syntax.${key}`);
    if (!isColor(item.foreground)) fail(`colors.syntax.${key}.foreground`);
    if (typeof item.bold !== 'boolean' || typeof item.italic !== 'boolean') fail(`colors.syntax.${key}.fontStyle`);
  }
  return normalizeSettings(value);
}
