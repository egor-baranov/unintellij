import type { AppSettings, SchemeImport, SurfaceColors, SurfaceKey, SyntaxKey } from './types';
import { treeThemeForSurface } from '../project/theme';
import { isFontFamily, isRecord, isSchemeName, normalizeSettings, presets, surfaceKeys, syntaxKeys, validateNativeSettings } from './model';

const MAX_BYTES = 1024 * 1024;
const XML_LIMITATION = 'IntelliJ editor schemes map general editor colors, primary editor font, font size/line spacing, ligatures, general syntax foreground/bold/italic and diff backgrounds. UI colors, language-specific styles, effects, gutter/status colors and external parent schemes are not imported.';
const THEME_LIMITATION = 'IntelliJ UI themes map window, tool-window, tab and popup colors. UI fonts, geometry, icons, images, plugin resources and linked editorScheme files are not loaded; import an .icls file separately for editor colors.';
function warnings() {
  const values = new Set<string>(); let omitted = 0;
  return { add(message: string) { if (values.has(message)) return; if (values.size < 100) values.add(message); else omitted++; }, finish() { return [...values, ...(omitted ? [`${omitted} additional unsupported settings were omitted.`] : [])]; } };
}
type Warnings = ReturnType<typeof warnings>;
function inputLimit(text: string, filename: string): void {
  if (typeof text !== 'string' || typeof filename !== 'string') throw new Error('Choose a text scheme file.');
  if (/\.(jar|zip)$/i.test(filename) || text.startsWith('PK\u0003\u0004')) throw new Error('JAR/ZIP theme plugins are not imported or executed. Export the editor scheme as .icls, or import a standalone .theme.json file.');
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('Scheme files must be 1 MiB or smaller. The file was not imported.');
  if (!text.trim()) throw new Error('The scheme file is empty.');
  if (text.includes('\0')) throw new Error('The scheme is not a supported text file.');
}
function ideaColor(value: unknown, legacy = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.replace(/^#/, '');
  if (/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return `#${raw.toLowerCase()}`;
  // Older IntelliJ schemes use unpadded Integer.toHexString RGB values ("0", "ff").
  if (legacy && /^[0-9a-f]{1,6}$/i.test(raw)) return `#${raw.padStart(6, '0').toLowerCase()}`;
}
function colorOrWarn(value: unknown, key: string, notices: Warnings, legacy = false): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const color = ideaColor(value, legacy);
  if (!color) notices.add(`Ignored invalid color at ${key}. Only RGB/RGBA hexadecimal colors are supported.`);
  return color;
}
function children(element: Element): Element[] {
  const result: Element[] = [];
  for (let child = element.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) result.push(child as Element);
  return result;
}
const syntaxOptions: Record<string, SyntaxKey> = {
  TEXT: 'text', DEFAULT_TEXT: 'text', DEFAULT_IDENTIFIER: 'identifier', DEFAULT_KEYWORD: 'keyword', DEFAULT_STRING: 'string', DEFAULT_NUMBER: 'number',
  DEFAULT_LINE_COMMENT: 'comment', DEFAULT_BLOCK_COMMENT: 'comment', DEFAULT_DOC_COMMENT: 'comment', DEFAULT_CLASS_NAME: 'type', DEFAULT_INTERFACE_NAME: 'type',
  DEFAULT_OPERATION_SIGN: 'operator', DEFAULT_TAG: 'tag', DEFAULT_ATTRIBUTE: 'attribute', XML_TAG_NAME: 'tag', XML_ATTRIBUTE_NAME: 'attribute',
};
const exportSyntax: Record<SyntaxKey, string> = { text: 'TEXT', identifier: 'DEFAULT_IDENTIFIER', keyword: 'DEFAULT_KEYWORD', string: 'DEFAULT_STRING', number: 'DEFAULT_NUMBER', comment: 'DEFAULT_LINE_COMMENT', type: 'DEFAULT_CLASS_NAME', operator: 'DEFAULT_OPERATION_SIGN', tag: 'XML_TAG_NAME', attribute: 'XML_ATTRIBUTE_NAME' };
const diffOptions = { DIFF_INSERTED: 'added', DIFF_DELETED: 'removed', DIFF_MODIFIED: 'modified' } as const;
const editorOptions: Record<string, keyof AppSettings['colors']['editor']> = { BACKGROUND: 'background', FOREGROUND: 'foreground', LINE_NUMBERS_COLOR: 'lineNumber', SELECTION_BACKGROUND: 'selection', CARET_COLOR: 'caret' };
interface Attributes { base?: string; values: Record<string, string | null> }

function importEditor(text: string, current: AppSettings): SchemeImport {
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('XML DTD and entity declarations are not allowed in schemes.');
  if (typeof DOMParser === 'undefined') throw new Error('XML scheme parsing requires a browser DOMParser.');
  let document: Document;
  try { document = new DOMParser().parseFromString(text, 'application/xml'); }
  catch { throw new Error('The IntelliJ editor scheme is malformed XML.'); }
  if (document.doctype || document.getElementsByTagName('parsererror').length || !document.documentElement) throw new Error('The IntelliJ editor scheme is malformed XML.');
  if (document.getElementsByTagName('*').length > 20000) throw new Error('The XML scheme contains too many elements.');
  const root = document.documentElement;
  if (root.tagName !== 'scheme' || root.namespaceURI) throw new Error('Expected an IntelliJ <scheme> XML document (.icls or .xml). Plugin manifests and application settings are not editor schemes.');
  const notices = warnings(); notices.add(XML_LIMITATION);
  const result = normalizeSettings(current);
  const schemeName = root.getAttribute('name');
  if (isSchemeName(schemeName)) result.name = schemeName.trim(); else notices.add('Scheme name is missing or invalid; kept the current name.');
  const parent = root.getAttribute('parent_scheme');
  if (parent) {
    const parentId = ({ Darcula: 'darcula', Default: 'light', 'IntelliJ Light': 'light', 'High contrast': 'high-contrast' } as Record<string, string>)[parent];
    const base = presets.find(preset => preset.id === parentId);
    if (base) {
      result.colors.editor = structuredClone(base.settings.colors.editor); result.colors.syntax = structuredClone(base.settings.colors.syntax); result.colors.diff = structuredClone(base.settings.colors.diff);
      notices.add(`Used unintellij's ${base.name} preset for inherited editor values from ${parent}.`);
    } else notices.add(`Parent scheme "${parent}" is unavailable; unspecified values keep the current editor settings.`);
  }
  const attributes = new Map<string, Attributes>();
  let spacing: number | undefined;
  let fontScale = 1;
  let hasFontSize = false;
  let extendedFontCount = 0;
  const inlineMetadata: Partial<AppSettings['colors']['diff']> = {};
  for (const section of children(root)) {
    if (section.tagName === 'option') {
      const key = section.getAttribute('name') ?? '', raw = section.getAttribute('value');
      if (key === 'EDITOR_FONT_NAME' || key === 'FONT_FAMILY') {
        if (isFontFamily(raw)) result.editor.fontFamily = raw.trim(); else notices.add(`Ignored invalid editor font at ${key}.`);
      } else if (key === 'EDITOR_FONT_SIZE' || key === 'FONT_SIZE') {
        const size = Number(raw);
        if (raw && Number.isFinite(size) && size > 0) { result.editor.fontSize = size; hasFontSize = true; } else notices.add(`Ignored invalid number at ${key}.`);
      } else if (key === 'FONT_SCALE') {
        const scale = Number(raw);
        if (raw && Number.isFinite(scale) && scale > 0 && scale <= 8) fontScale = scale; else notices.add('Ignored invalid FONT_SCALE.');
      } else if (key === 'LINE_SPACING') {
        const size = Number(raw);
        if (raw && Number.isFinite(size) && size > 0 && size < 10) spacing = size; else notices.add('Ignored invalid LINE_SPACING.');
      } else if (key === 'EDITOR_LIGATURES' || key === 'USE_LIGATURES') {
        if (raw === 'true' || raw === 'false') result.editor.ligatures = raw === 'true'; else notices.add(`Ignored invalid boolean at ${key}.`);
      } else notices.add(`Unsupported editor option: ${key || '(unnamed)'}.`);
    } else if (section.tagName === 'font') {
      const fontOptions = new Map(children(section).filter(child => child.tagName === 'option').map(child => [child.getAttribute('name'), child.getAttribute('value')]));
      const family = fontOptions.get('EDITOR_FONT_NAME');
      if (!isFontFamily(family)) { notices.add('Ignored invalid extended editor font family.'); continue; }
      const stack = extendedFontCount ? `${result.editor.fontFamily}, ${family}` : family;
      if (!isFontFamily(stack)) { notices.add(`Omitted fallback font ${family}: font-family limit is 200 characters.`); continue; }
      result.editor.fontFamily = stack;
      const size = Number(fontOptions.get('EDITOR_FONT_SIZE'));
      if (extendedFontCount === 0 && Number.isFinite(size) && size > 0) { result.editor.fontSize = size; hasFontSize = true; }
      else if (extendedFontCount > 0 && size > 0 && size !== result.editor.fontSize) notices.add(`Fallback font ${family} has a separate size; unintellij uses the primary editor font size for all fallbacks.`);
      for (const key of fontOptions.keys()) if (key !== 'EDITOR_FONT_NAME' && key !== 'EDITOR_FONT_SIZE') notices.add(`Unsupported extended font option: ${key}.`);
      extendedFontCount++;
    } else if (section.tagName === 'colors') {
      for (const option of children(section)) {
        const key = option.getAttribute('name') ?? '';
        if (option.tagName !== 'option' || !Object.hasOwn(editorOptions, key)) { notices.add(`Unsupported editor color: ${key || option.tagName}.`); continue; }
        const color = colorOrWarn(option.getAttribute('value'), `colors.${key}`, notices, true);
        if (color) result.colors.editor[editorOptions[key]] = color;
      }
    } else if (section.tagName === 'attributes') {
      for (const option of children(section)) {
        const key = option.getAttribute('name');
        if (option.tagName !== 'option' || !key) { notices.add(`Unsupported attributes element: ${option.tagName}.`); continue; }
        const value = children(option).find(child => child.tagName === 'value');
        const values: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
        if (value) for (const item of children(value)) {
          const property = item.getAttribute('name');
          if (item.tagName === 'option' && property) values[property] = item.getAttribute('value');
          else notices.add(`Unsupported syntax element at ${key}: ${item.tagName}.`);
        }
        attributes.set(key, { base: option.getAttribute('baseAttributes') ?? undefined, values });
      }
    } else if (section.tagName === 'metaInfo') {
      for (const property of children(section)) {
        const key = property.getAttribute('name') ?? '';
        if (key.startsWith('smartDiff.diff.')) {
          const field = key.slice('smartDiff.diff.'.length);
          if (['addedInner', 'removedInner', 'modifiedInner'].includes(field)) {
            const color = colorOrWarn(property.textContent, key, notices);
            if (color) inlineMetadata[field as keyof AppSettings['colors']['diff']] = color;
          } else notices.add(`Unsupported unintellij metadata: ${key}.`);
        }
      }
    } else notices.add(`Unsupported editor scheme section: ${section.tagName}.`);
  }
  const resolve = (key: string, visited = new Set<string>()): Record<string, string | null> => {
    const item = attributes.get(key);
    if (!item) { notices.add(`Inherited attribute "${key}" is unavailable.`); return {}; }
    if (visited.has(key) || visited.size >= 32) { notices.add(`Cyclic or excessive attribute inheritance at ${key}.`); return {}; }
    visited.add(key);
    return { ...(item.base ? resolve(item.base, visited) : {}), ...item.values };
  };
  const ordered = [...attributes.keys()].sort((a, b) => Number(a === 'DEFAULT_LINE_COMMENT') - Number(b === 'DEFAULT_LINE_COMMENT'));
  for (const key of ordered) {
    if (!Object.hasOwn(syntaxOptions, key) && !Object.hasOwn(diffOptions, key)) { notices.add(`Unsupported syntax attribute: ${key}.`); continue; }
    const values = resolve(key);
    if (Object.hasOwn(diffOptions, key)) {
      const field = diffOptions[key as keyof typeof diffOptions];
      const color = colorOrWarn(values.BACKGROUND, `attributes.${key}.BACKGROUND`, notices, true);
      if (color) { result.colors.diff[field] = color; result.colors.diff[`${field}Inner`] = stronger(color, result.colors.editor.foreground); }
      for (const property of Object.keys(values)) if (property !== 'BACKGROUND' && values[property]) notices.add(`Unsupported diff attribute property: ${key}.${property}.`);
      continue;
    }
    const field = syntaxOptions[key], item = result.colors.syntax[field];
    const foreground = colorOrWarn(values.FOREGROUND, `attributes.${key}.FOREGROUND`, notices, true);
    if (foreground) { item.foreground = foreground; if (key === 'TEXT') result.colors.editor.foreground = foreground; }
    if (key === 'TEXT') {
      const background = colorOrWarn(values.BACKGROUND, 'attributes.TEXT.BACKGROUND', notices, true);
      if (background) result.colors.editor.background = background;
    }
    if (Object.hasOwn(values, 'FONT_TYPE')) {
      if (values.FONT_TYPE && /^[0-3]$/.test(values.FONT_TYPE)) { const type = Number(values.FONT_TYPE); item.bold = !!(type & 1); item.italic = !!(type & 2); }
      else if (values.FONT_TYPE !== null && values.FONT_TYPE !== '') notices.add(`Ignored invalid font style at ${key}.FONT_TYPE.`);
    }
    for (const property of Object.keys(values)) if (!['FOREGROUND', 'FONT_TYPE', ...(key === 'TEXT' ? ['BACKGROUND'] : [])].includes(property) && values[property]) notices.add(`Unsupported syntax property: ${key}.${property}.`);
  }
  Object.assign(result.colors.diff, inlineMetadata);
  if (hasFontSize && fontScale !== 1) { result.editor.fontSize /= fontScale; notices.add(`Converted editor font size from IntelliJ FONT_SCALE ${fontScale} to CSS pixels. App UI scale is unchanged.`); }
  if (spacing) result.editor.lineHeight = Math.round(result.editor.fontSize * spacing);
  const normalized = normalizeSettings(result);
  if (normalized.editor.fontSize !== result.editor.fontSize) notices.add(`Editor font size was adjusted to the supported 10–32 pixel range (${normalized.editor.fontSize}px).`);
  if (normalized.editor.lineHeight !== result.editor.lineHeight) notices.add(`Editor line height was adjusted to the supported 14–56 pixel range (${normalized.editor.lineHeight}px).`);
  notices.add('Inner diff colors are derived from each diff background unless unintellij inline-color metadata is present. IntelliJ uses its own inner-highlighting calculation.');
  return { settings: normalized, warnings: notices.finish(), format: 'intellij-editor' };
}
function stronger(background: string, foreground: string): string {
  return `#${[0, 1, 2].map(index => {
    const offset = 1 + index * 2;
    return Math.round(parseInt(background.slice(offset, offset + 2), 16) * .78 + parseInt(foreground.slice(offset, offset + 2), 16) * .22).toString(16).padStart(2, '0');
  }).join('')}${background.length === 9 ? background.slice(7) : ''}`;
}

type Target = [SurfaceKey, keyof SurfaceColors];
const themeMapping: Record<string, Target[]> = {
  'Panel.background': [['window', 'background']], 'Panel.foreground': [['window', 'foreground']], 'Label.foreground': [['window', 'foreground']], 'Label.disabledForeground': [['window', 'muted']],
  'Component.borderColor': [['window', 'border']], 'Component.accentColor': [['window', 'accent']], 'Component.focusColor': [['window', 'accent']], 'List.selectionBackground': [['window', 'selection']],
  'ToolWindow.background': [['sidebar', 'background']], 'ToolWindow.foreground': [['sidebar', 'foreground']], 'ToolWindow.borderColor': [['sidebar', 'border']],
  'Tree.background': [['sidebar', 'background']], 'Tree.foreground': [['sidebar', 'foreground']], 'Tree.selectionBackground': [['sidebar', 'selection']], 'Tree.disabledForeground': [['sidebar', 'muted']],
  'Tree.selectionBorderColor': [['sidebar', 'accent']],
  'DefaultTabs.background': [['tabs', 'background']], 'DefaultTabs.foreground': [['tabs', 'foreground']], 'DefaultTabs.underlineColor': [['tabs', 'accent']],
  'EditorTabs.background': [['tabs', 'background']], 'EditorTabs.foreground': [['tabs', 'foreground']], 'EditorTabs.selectedForeground': [['tabs', 'foreground']],
  'EditorTabs.inactiveForeground': [['tabs', 'muted']], 'EditorTabs.borderColor': [['tabs', 'border']], 'EditorTabs.underlinedTabBackground': [['tabs', 'selection']], 'EditorTabs.selectedBackground': [['tabs', 'selection']], 'EditorTabs.underlineColor': [['tabs', 'accent']],
  'PopupMenu.background': [['popups', 'background']], 'PopupMenu.foreground': [['popups', 'foreground']], 'PopupMenu.borderColor': [['popups', 'border']],
  'MenuItem.disabledForeground': [['popups', 'muted']], 'MenuItem.selectionBackground': [['popups', 'selection']], 'PopupMenu.selectionBackground': [['popups', 'selection']], 'PopupMenu.selectionBorderColor': [['popups', 'accent']],
};
function importTheme(input: Record<string, unknown>, current: AppSettings): SchemeImport {
  if (!isRecord(input.ui)) throw new Error('IntelliJ UI themes must contain a ui object.');
  if (input.colors !== undefined && !isRecord(input.colors)) throw new Error('The named colors section must be an object.');
  const result = normalizeSettings(current), notices = warnings(); notices.add(THEME_LIMITATION);
  if (isSchemeName(input.name)) result.name = input.name.trim();
  else if (input.name !== undefined) notices.add('Theme name is invalid; kept the current name.');
  const named = isRecord(input.colors) ? input.colors : {};
  const resolve = (value: unknown, key: string, seen = new Set<string>()): string | undefined => {
    if (typeof value !== 'string') { notices.add(`Ignored non-color UI value: ${key}.`); return; }
    const direct = ideaColor(value);
    if (direct) return direct;
    if (Object.hasOwn(named, value)) {
      if (seen.has(value) || seen.size >= 32) { notices.add(`Cyclic or excessive named-color reference: ${value}.`); return; }
      seen.add(value); return resolve(named[value], key, seen);
    }
    notices.add(`Unresolved named color or invalid hexadecimal color at ${key}: ${value.slice(0, 100)}.`);
  };
  const flattened = new Map<string, unknown>();
  const flatten = (value: Record<string, unknown>, prefix = '', depth = 0) => {
    if (depth > 20) throw new Error('The UI theme is nested too deeply.');
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) { notices.add(`Ignored unsafe UI key: ${prefix}${key}.`); continue; }
      const full = prefix ? `${prefix}.${key}` : key;
      if (isRecord(item)) flatten(item, full, depth + 1); else flattened.set(full, item);
    }
  };
  flatten(input.ui);
  // Wildcards precede specific controls, regardless of source JSON property order.
  for (const [key, value] of flattened) {
    if (!key.startsWith('*.')) continue;
    const field = key.slice(2);
    if (!['background', 'foreground', 'disabledForeground', 'borderColor', 'selectionBackground', 'accentColor'].includes(field)) { notices.add(`Unsupported UI key: ${key}.`); continue; }
    const mapped = ({ disabledForeground: 'muted', borderColor: 'border', selectionBackground: 'selection', accentColor: 'accent' } as Record<string, string>)[field] ?? field;
    const color = resolve(value, `ui.${key}`);
    if (color) for (const surface of surfaceKeys) result.colors[surface][mapped as keyof SurfaceColors] = color;
  }
  const priority = (key: string) => /^(Tree|Label|EditorTabs|MenuItem)\./.test(key) ? 1 : 0;
  for (const [key, value] of [...flattened].sort(([a], [b]) => priority(a) - priority(b))) {
    if (key.startsWith('*.')) continue;
    const targets = Object.hasOwn(themeMapping, key) ? themeMapping[key] : undefined;
    if (!targets) { notices.add(`Unsupported UI key: ${key}.`); continue; }
    const color = resolve(value, `ui.${key}`);
    if (color) for (const [surface, field] of targets) result.colors[surface][field] = color;
  }
  // Tree roles/Git colors remain independent tokens. Imported UI surface
  // colors also establish a readable base for the semantic Project tree.
  const sidebar = result.colors.sidebar;
  result.colors.tree = treeThemeForSurface(sidebar.background, sidebar.foreground, sidebar.muted, sidebar.selection);
  for (const key of Object.keys(input)) if (!['name', 'dark', 'author', 'id', 'colors', 'ui'].includes(key)) notices.add(`Unsupported theme section: ${key}. External resources are not loaded.`);
  return { settings: normalizeSettings(result), warnings: notices.finish(), format: 'intellij-theme' };
}

export function importScheme(text: string, filename: string, current: AppSettings): SchemeImport {
  inputLimit(text, filename);
  const value = text.replace(/^\uFEFF/, '').trim();
  if (value.startsWith('<') || /\.(icls|xml)$/i.test(filename)) return importEditor(value, current);
  let input: unknown;
  try { input = JSON.parse(value); } catch { throw new Error('The scheme file is not valid JSON or IntelliJ editor XML.'); }
  if (!isRecord(input)) throw new Error('A scheme must be a JSON object.');
  if (Object.hasOwn(input, 'version') || /\.smart-diff\.json$/i.test(filename)) return { settings: validateNativeSettings(input), warnings: [], format: 'smart-diff' };
  if (/\.theme\.json$/i.test(filename) || Object.hasOwn(input, 'ui')) return importTheme(input, current);
  throw new Error('Unrecognized scheme format. Import unintellij JSON, an IntelliJ .icls/.xml editor scheme, or .theme.json. JAR/plugin files are not supported.');
}
export function exportNativeScheme(settings: AppSettings): string { return `${JSON.stringify(validateNativeSettings(settings), null, 2)}\n`; }
const escapeXml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
const xmlColor = (value: string) => value.slice(1).toUpperCase();
const xmlOption = (name: string, value: string, indent = '    ') => `${indent}<option name="${escapeXml(name)}" value="${escapeXml(value)}" />`;

export function exportIntelliJScheme(input: AppSettings): string {
  const settings = validateNativeSettings(input);
  const font = settings.editor.fontFamily.split(',')[0].trim().replace(/^(["'])(.*)\1$/, '$2');
  const options = [xmlOption('FONT_SCALE', '1.0', '  '), xmlOption('EDITOR_FONT_NAME', font, '  '), xmlOption('EDITOR_FONT_SIZE', String(settings.editor.fontSize), '  '), xmlOption('LINE_SPACING', String(settings.editor.lineHeight / settings.editor.fontSize), '  '), xmlOption('EDITOR_LIGATURES', String(settings.editor.ligatures), '  ')];
  const colors = Object.entries(editorOptions).filter(([key]) => key !== 'BACKGROUND' && key !== 'FOREGROUND').map(([key, field]) => xmlOption(key, xmlColor(settings.colors.editor[field])));
  const attributes: string[] = [];
  for (const key of syntaxKeys) {
    const style = settings.colors.syntax[key];
    attributes.push(`    <option name="${exportSyntax[key]}">`, '      <value>', xmlOption('FOREGROUND', xmlColor(style.foreground), '        '), xmlOption('FONT_TYPE', String(Number(style.bold) + Number(style.italic) * 2), '        '));
    if (key === 'text') attributes.push(xmlOption('BACKGROUND', xmlColor(settings.colors.editor.background), '        '));
    attributes.push('      </value>', '    </option>');
  }
  for (const [key, field] of Object.entries(diffOptions)) attributes.push(`    <option name="${key}">`, '      <value>', xmlOption('BACKGROUND', xmlColor(settings.colors.diff[field]), '        '), '      </value>', '    </option>');
  const metadata = (['addedInner', 'removedInner', 'modifiedInner'] as const).map(key => `    <property name="smartDiff.diff.${key}">${settings.colors.diff[key]}</property>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', `<scheme name="${escapeXml(settings.name)}" version="142" parent_scheme="Darcula">`,
    '  <!-- unintellij exports general editor styles; IntelliJ calculates its own inline diff highlighting. -->', '  <metaInfo>', ...metadata, '  </metaInfo>', ...options, '  <colors>', ...colors, '  </colors>', '  <attributes>', ...attributes, '  </attributes>', '</scheme>', ''].join('\n');
}

/** A standalone theme description, never a plugin/JAR or an executable resource. */
export function exportIntelliJTheme(input: AppSettings): string {
  const settings = validateNativeSettings(input);
  const ui: Record<string, string> = {};
  const exportKeys: Record<SurfaceKey, Record<keyof SurfaceColors, string>> = {
    window: { background: 'Panel.background', foreground: 'Label.foreground', muted: 'Label.disabledForeground', border: 'Component.borderColor', selection: 'List.selectionBackground', accent: 'Component.focusColor' },
    sidebar: { background: 'ToolWindow.background', foreground: 'Tree.foreground', muted: 'Tree.disabledForeground', border: 'ToolWindow.borderColor', selection: 'Tree.selectionBackground', accent: 'Tree.selectionBorderColor' },
    tabs: { background: 'EditorTabs.background', foreground: 'EditorTabs.foreground', muted: 'EditorTabs.inactiveForeground', border: 'EditorTabs.borderColor', selection: 'EditorTabs.underlinedTabBackground', accent: 'EditorTabs.underlineColor' },
    popups: { background: 'PopupMenu.background', foreground: 'PopupMenu.foreground', muted: 'MenuItem.disabledForeground', border: 'PopupMenu.borderColor', selection: 'MenuItem.selectionBackground', accent: 'PopupMenu.selectionBorderColor' },
  };
  for (const surface of surfaceKeys) for (const [field, key] of Object.entries(exportKeys[surface])) ui[key] = settings.colors[surface][field as keyof SurfaceColors];
  const background = settings.colors.window.background;
  const brightness = parseInt(background.slice(1, 3), 16) * .2126 + parseInt(background.slice(3, 5), 16) * .7152 + parseInt(background.slice(5, 7), 16) * .0722;
  return `${JSON.stringify({ name: settings.name, dark: brightness < 128, author: 'unintellij', ui }, null, 2)}\n`;
}
