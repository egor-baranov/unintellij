import { describe, expect, it } from 'vitest';
import { defaultSettings, isFontFamily, migrateDeletedTreeColor, migrateUntrackedTreeColor, normalizeSettings, presets, validateNativeSettings } from './model';

describe('appearance settings model', () => {
  it('mutes legacy deleted defaults without changing custom palettes, imports, or other Git colors', () => {
    for (const { settings } of presets) {
      const legacy = structuredClone(settings);
      legacy.colors.tree.deleted = settings.colors.tree.untracked;
      legacy.editor.fontSize = 18;
      const migrated = migrateDeletedTreeColor(legacy);
      expect(migrated.colors.tree).toEqual(settings.colors.tree);
      expect(migrated.editor.fontSize).toBe(18);
      expect(validateNativeSettings(legacy).colors.tree.deleted).toBe(legacy.colors.tree.deleted);
      legacy.colors.tree.foreground = '#123456';
      expect(migrateDeletedTreeColor(legacy)).toBe(legacy);
      legacy.colors.tree.foreground = settings.colors.tree.foreground;
      legacy.colors.tree.deleted = '#987654';
      expect(migrateDeletedTreeColor(legacy)).toBe(legacy);
    }
  });
  it('restores red untracked defaults in saved built-in palettes without altering custom palettes or imports', () => {
    for (const { id, settings } of presets) {
      const legacy = structuredClone(settings);
      legacy.ui.fontSize = 15;
      legacy.colors.tree.untracked = legacy.colors.tree.ignored;
      const migrated = migrateUntrackedTreeColor(legacy);
      expect(migrated.colors.tree.untracked).toBe(id === 'light' ? '#a93a39' : '#ea8d8a');
      expect(migrated.colors.tree.ignored).toBe(legacy.colors.tree.ignored);
      expect(migrated.ui.fontSize).toBe(15);
      expect(normalizeSettings(legacy).colors.tree.untracked).toBe(legacy.colors.tree.untracked);
      legacy.colors.tree.foreground = '#123456';
      expect(migrateUntrackedTreeColor(legacy)).toEqual(legacy);
    }
  });
  it('provides independent complete presets and fresh normalized defaults', () => {
    expect(presets.map(preset => preset.id)).toEqual(['reference', 'darcula', 'light', 'high-contrast']);
    for (const preset of presets) expect(validateNativeSettings(preset.settings)).toEqual(preset.settings);
    const first = normalizeSettings(null); first.colors.sidebar.background = '#ffffff';
    expect(normalizeSettings(undefined).colors.sidebar.background).toBe(defaultSettings.colors.sidebar.background);
    expect(presets[0].settings.colors.sidebar.background).toBe(defaultSettings.colors.sidebar.background);
  });
  it('clamps finite numbers and rejects invalid persisted values without propagating them', () => {
    const settings = normalizeSettings({ version: 99, ui: { fontSize: 1, scale: 10 }, editor: { fontSize: 100, lineHeight: 0, syntaxHighlight: 'false', ligatures: false }, colors: { editor: { background: '#AbCdEf90', foreground: 'url(evil)' }, syntax: { keyword: { bold: 'yes', italic: true, foreground: '#123456' } } } });
    expect(settings.ui).toMatchObject({ fontSize: 10, scale: 1.5 });
    expect(settings.editor).toMatchObject({ fontSize: 32, lineHeight: 14, syntaxHighlight: true, ligatures: false });
    expect(settings.colors.editor.background).toBe('#abcdef90');
    expect(settings.colors.editor.foreground).toBe(defaultSettings.colors.editor.foreground);
    expect(settings.colors.syntax.keyword).toEqual({ foreground: '#123456', bold: false, italic: true });
    expect(normalizeSettings({ ui: { fontSize: NaN, scale: Infinity }, editor: { lineHeight: '23' } })).toEqual(defaultSettings);
  });
  it('accepts ordinary font stacks and rejects CSS/control/URL injection', () => {
    for (const value of ['"JetBrains Mono", Menlo, monospace', 'Fira Code', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 'メイリオ, monospace']) expect(isFontFamily(value), value).toBe(true);
    for (const value of ['font; color:red', 'url(https://host/font)', 'var(--x)', 'Arial\nbody{}', 'Arial!important', '"broken', 'Arial,,monospace', 'x'.repeat(201), '\\65 vil', '<style>']) expect(isFontFamily(value), value).toBe(false);
  });
  it('strictly rejects malformed native schemes, unknown fields and prototype keys', () => {
    for (const mutate of [(value: Record<string, unknown>) => { value.version = 2; }, (value: Record<string, unknown>) => { value.name = ''; }, (value: Record<string, unknown>) => { delete value.colors; }, (value: Record<string, unknown>) => { value.extra = true; }]) {
      const value = structuredClone(defaultSettings) as unknown as Record<string, unknown>; mutate(value);
      expect(() => validateNativeSettings(value)).toThrow('Invalid unintellij');
    }
    const value = structuredClone(defaultSettings); value.ui.fontSize = 100;
    expect(() => validateNativeSettings(value)).toThrow('ui.fontSize');
    expect(() => validateNativeSettings(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
    expect(Object.hasOwn({}, 'polluted')).toBe(false);
  });
  it('migrates older v1 schemes and persists independent semantic tree colors', () => {
    const legacy = structuredClone(defaultSettings) as unknown as { colors: Record<string, unknown> };
    delete legacy.colors.tree;
    expect(validateNativeSettings(legacy).colors.tree).toEqual(defaultSettings.colors.tree);
    const lightLegacy = structuredClone(presets[2].settings) as unknown as { colors: Record<string, unknown> };
    delete lightLegacy.colors.tree;
    expect(validateNativeSettings(lightLegacy).colors.tree).toEqual(presets[2].settings.colors.tree);
    const custom = structuredClone(defaultSettings);
    custom.colors.tree.ignored = '#123456'; custom.colors.tree.untracked = '#654321';
    expect(normalizeSettings(custom).colors.tree).toEqual(custom.colors.tree);
    expect(validateNativeSettings(custom).colors.sidebar).toEqual(defaultSettings.colors.sidebar);
    custom.colors.tree.testBackground = 'url(unsafe)';
    expect(() => validateNativeSettings(custom)).toThrow('colors.tree.testBackground');
  });
});
