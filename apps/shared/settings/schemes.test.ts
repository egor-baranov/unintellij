import { DOMParser as XmlDOMParser } from '@xmldom/xmldom';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { defaultSettings, normalizeSettings, presets } from './model';
import { exportIntelliJScheme, exportIntelliJTheme, exportNativeScheme, importScheme } from './schemes';

// Production uses the browser's strict native XML parser. xmldom is a pinned
// test-only DOM implementation; promote its recovery warnings/errors to the
// browser's parsererror document so malformed XML is tested consistently.
class BrowserLikeDOMParser {
  parseFromString(text: string, type: string): Document {
    const errors: string[] = [];
    const report = (message: string) => { errors.push(message); };
    const parser = new XmlDOMParser({ errorHandler: { warning: report, error: report, fatalError: report } });
    try {
      const result = parser.parseFromString(text, type);
      if (errors.length) return new XmlDOMParser().parseFromString('<parsererror/>', 'application/xml');
      return result;
    } catch { return new XmlDOMParser().parseFromString('<parsererror/>', 'application/xml'); }
  }
}
beforeAll(() => vi.stubGlobal('DOMParser', BrowserLikeDOMParser));
afterAll(() => vi.unstubAllGlobals());

describe('scheme import/export', () => {
  it('roundtrips the complete native schema without losing UI/editor/diff settings', () => {
    const settings = structuredClone(presets[3].settings);
    settings.name = 'Personal & safe'; settings.ui.scale = 1.25; settings.editor.ligatures = true;
    settings.colors.syntax.keyword = { foreground: '#12345678', bold: true, italic: true };
    const imported = importScheme(exportNativeScheme(settings), 'personal.smart-diff.json', defaultSettings);
    expect(imported).toEqual({ settings, warnings: [], format: 'smart-diff' });
  });
  it('rejects invalid native scheme fields instead of quietly replacing them with defaults', () => {
    const settings = structuredClone(defaultSettings); settings.colors.diff.added = 'green';
    expect(() => importScheme(JSON.stringify(settings), 'invalid.json', defaultSettings)).toThrow('colors.diff.added');
    expect(() => importScheme('{"version":4}', 'invalid.json', defaultSettings)).toThrow('Invalid unintellij');
    expect(() => importScheme('{"ui":{}}', 'invalid.smart-diff.json', defaultSettings)).toThrow('Invalid unintellij');
  });
  it('imports actual IntelliJ option/value structure, short RGB notation, font styles and attribute inheritance', () => {
    const xml = `<scheme name="Imported" version="142"><option name="EDITOR_FONT_NAME" value="Fira Code"/><option name="EDITOR_FONT_SIZE" value="20"/><option name="LINE_SPACING" value="1.4"/><option name="EDITOR_LIGATURES" value="true"/>
      <colors><option name="LINE_NUMBERS_COLOR" value="999999"/><option name="CARET_COLOR" value="ff"/><option name="SELECTION_BACKGROUND" value="AABBCC80"/></colors>
      <attributes><option name="TEXT"><value><option name="FOREGROUND" value="ffffff"/><option name="BACKGROUND" value="0"/></value></option>
      <option name="DEFAULT_KEYWORD"><value><option name="FOREGROUND" value="cc7832"/><option name="FONT_TYPE" value="3"/></value></option>
      <option name="DEFAULT_STRING" baseAttributes="DEFAULT_KEYWORD"/><option name="DIFF_INSERTED"><value><option name="BACKGROUND" value="294436"/></value></option></attributes></scheme>`;
    const imported = importScheme(xml, 'sample.icls', defaultSettings);
    expect(imported.format).toBe('intellij-editor');
    expect(imported.settings.editor).toMatchObject({ fontFamily: 'Fira Code', fontSize: 20, lineHeight: 28, ligatures: true });
    expect(imported.settings.colors.editor).toEqual({ background: '#000000', foreground: '#ffffff', lineNumber: '#999999', selection: '#aabbcc80', caret: '#0000ff' });
    expect(imported.settings.colors.syntax.keyword).toEqual({ foreground: '#cc7832', bold: true, italic: true });
    expect(imported.settings.colors.syntax.string).toEqual(imported.settings.colors.syntax.keyword);
    expect(imported.settings.colors.diff.added).toBe('#294436');
    expect(imported.settings.colors.diff.addedInner).not.toBe('#294436');
    expect(imported.settings.colors.sidebar).toEqual(defaultSettings.colors.sidebar);
  });
  it('semantically roundtrips supported IntelliJ editor fonts, syntax, colors and diff metadata', () => {
    const settings = normalizeSettings(defaultSettings); settings.name = 'Roundtrip <&> "scheme"';
    settings.editor.fontFamily = 'Fira Code'; settings.editor.fontSize = 19; settings.editor.lineHeight = 28; settings.editor.ligatures = true;
    settings.colors.syntax.keyword.bold = true; settings.colors.syntax.keyword.italic = true;
    settings.colors.editor.selection = '#11223388'; settings.colors.diff.modifiedInner = '#55667799';
    const exported = exportIntelliJScheme(settings);
    expect(exported).toContain('name="Roundtrip &lt;&amp;&gt; &quot;scheme&quot;"');
    expect(exported).toContain('name="DIFF_INSERTED"');
    expect(exported).toContain('name="FONT_SCALE" value="1.0"');
    const imported = importScheme(exported, 'roundtrip.icls', defaultSettings).settings;
    expect(imported.name).toBe(settings.name);
    expect(imported.editor).toEqual(settings.editor);
    expect(imported.colors.editor).toEqual(settings.colors.editor);
    expect(imported.colors.syntax).toEqual(settings.colors.syntax);
    expect(imported.colors.diff).toEqual(settings.colors.diff);
  });
  it('supports IntelliJ extended fallback fonts and HiDPI font scale', () => {
    const xml = '<scheme name="Fonts"><option name="FONT_SCALE" value="2"/><option name="LINE_SPACING" value="1.5"/><font><option name="EDITOR_FONT_NAME" value="Fira Code"/><option name="EDITOR_FONT_SIZE" value="36"/></font><font><option name="EDITOR_FONT_NAME" value="Menlo"/><option name="EDITOR_FONT_SIZE" value="36"/></font></scheme>';
    const result = importScheme(xml, 'fonts.icls', defaultSettings);
    expect(result.settings.editor).toMatchObject({ fontFamily: 'Fira Code, Menlo', fontSize: 18, lineHeight: 27 });
    expect(result.warnings.join('\n')).toContain('FONT_SCALE 2');
  });
  it('warns about unmapped styles/effects/parents and safely handles cyclic inheritance', () => {
    const result = importScheme(`<scheme name="Partial" parent_scheme="External"><attributes><option name="DEFAULT_KEYWORD" baseAttributes="DEFAULT_STRING"/><option name="DEFAULT_STRING" baseAttributes="DEFAULT_KEYWORD"/><option name="PY.KEYWORD"><value><option name="FOREGROUND" value="ffffff"/></value></option><option name="DEFAULT_COMMENT"><value><option name="EFFECT_TYPE" value="2"/></value></option></attributes><unknown/></scheme>`, 'partial.xml', defaultSettings);
    expect(result.warnings.join('\n')).toContain('Parent scheme "External" is unavailable');
    expect(result.warnings.join('\n')).toContain('PY.KEYWORD');
    expect(result.warnings.join('\n')).toContain('Cyclic');
    expect(result.warnings.join('\n')).toContain('unknown');
  });
  it('rejects malformed XML, DTD/XXE/entity payloads and plugin manifests', () => {
    for (const xml of ['<scheme><colors></scheme>', '<scheme name="x">', '<!DOCTYPE scheme [<!ENTITY ext SYSTEM "file:///etc/passwd">]><scheme name="&ext;"/>', '<!ENTITY x "evil"><scheme/>', '<scheme name="&undefined;"/>', '<idea-plugin><id>plugin</id></idea-plugin>']) expect(() => importScheme(xml, 'bad.icls', defaultSettings), xml).toThrow();
  });
  it('imports named colors, nested/dotted keys and wildcard precedence without executing resources', () => {
    const theme = { name: 'Nested theme', colors: { background: '#112233', alias: 'background', selection: '#22446688' },
      ui: { 'Tree.background': '#334455', '*': { background: 'alias', foreground: '#eeeeee' }, Panel: { background: '#445566' }, Tree: { selectionBackground: 'selection' }, EditorTabs: { underlineColor: '#ff0000', underlinedTabBackground: '#552200' }, 'DefaultTabs.underlineColor': '#00ff00', 'Button.arc': 12 },
      editorScheme: 'https://evil/scheme.xml', icons: { '/actions/icon.svg': 'file:///secret.svg' }, background: { image: 'https://evil/image' } };
    const result = importScheme(JSON.stringify(theme), 'nested.theme.json', defaultSettings);
    expect(result.settings.colors.window.background).toBe('#445566');
    expect(result.settings.colors.sidebar.background).toBe('#334455');
    expect(result.settings.colors.popups.background).toBe('#112233');
    expect(result.settings.colors.sidebar.selection).toBe('#22446688');
    expect(result.settings.colors.tabs.accent).toBe('#ff0000');
    expect(result.settings.colors.tabs.selection).toBe('#552200');
    expect(result.settings.colors.editor).toEqual(defaultSettings.colors.editor);
    for (const key of ['Button.arc', 'editorScheme', 'icons', 'background']) expect(result.warnings.join('\n')).toContain(key);
  });
  it('preserves every supported UI surface color through standalone .theme.json roundtrip', () => {
    const expected = presets[2].settings;
    const result = importScheme(exportIntelliJTheme(expected), 'light.theme.json', defaultSettings);
    for (const key of ['window', 'sidebar', 'tabs', 'popups'] as const) expect(result.settings.colors[key]).toEqual(expected.colors[key]);
    expect(JSON.parse(exportIntelliJTheme(expected)).dark).toBe(false);
  });
  it('rejects unsafe theme color values and prototype keys without polluting objects', () => {
    const result = importScheme('{"name":"Unsafe","colors":{"a":"b","b":"a"},"ui":{"__proto__":{"polluted":"#ffffff"},"Panel.background":"url(https://evil)","Tree.background":"a","PopupMenu.background":"<style>"}}', 'unsafe.theme.json', defaultSettings);
    expect(result.settings.colors.window.background).toBe(defaultSettings.colors.window.background);
    expect(result.settings.colors.sidebar.background).toBe(defaultSettings.colors.sidebar.background);
    expect(result.warnings.join('\n')).toContain('Cyclic');
    expect(result.warnings.join('\n')).toContain('unsafe UI key');
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });
  it('enforces size and format limits and clearly declines archive/plugin imports', () => {
    expect(() => importScheme(' '.repeat(1024 * 1024 + 1), 'big.json', defaultSettings)).toThrow('1 MiB');
    expect(() => importScheme('{}', 'plugin.jar', defaultSettings)).toThrow('JAR/ZIP');
    expect(() => importScheme('PK\u0003\u0004binary', 'file', defaultSettings)).toThrow('JAR/ZIP');
    expect(() => importScheme('[]', 'array.json', defaultSettings)).toThrow('JSON object');
    expect(() => importScheme('{', 'invalid.json', defaultSettings)).toThrow('not valid JSON');
    expect(() => importScheme('{}', 'unknown.json', defaultSettings)).toThrow('Unrecognized');
  });
});
