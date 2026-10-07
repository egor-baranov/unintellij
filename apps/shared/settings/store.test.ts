import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from './model';

const settingsKey = 'smart-diff:appearance:v1';
const untrackedKey = 'smart-diff:appearance:untracked-red:v1';
const deletedKey = 'smart-diff:appearance:deleted-muted:v1';
let values: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe('persisted tree palette migrations', () => {
  it.each([false, true])('upgrades deleted defaults when untracked migration already ran: %s', async alreadyMigrated => {
    const legacy = structuredClone(defaultSettings);
    legacy.colors.tree.deleted = legacy.colors.tree.untracked;
    if (alreadyMigrated) values.set(untrackedKey, '1');
    else legacy.colors.tree.untracked = legacy.colors.tree.ignored;
    values.set(settingsKey, JSON.stringify(legacy));

    const store = await import('./store');
    expect(store.getSettings().colors.tree).toEqual(defaultSettings.colors.tree);
    expect(JSON.parse(values.get(settingsKey)!).colors.tree).toEqual(defaultSettings.colors.tree);
    expect(values.get(untrackedKey)).toBe('1');
    expect(values.get(deletedKey)).toBe('1');

    // The marker preserves a deliberate red choice made after the upgrade.
    const chosen = structuredClone(store.getSettings());
    chosen.colors.tree.deleted = '#ea8d8a';
    store.saveSettings(chosen);
    vi.resetModules();
    expect((await import('./store')).getSettings().colors.tree.deleted).toBe('#ea8d8a');
  });

  it('leaves customized palettes intact and marks the migration complete', async () => {
    const custom = structuredClone(defaultSettings);
    custom.colors.tree.deleted = '#ea8d8a';
    custom.colors.tree.modified = '#123456';
    values.set(settingsKey, JSON.stringify(custom));
    expect((await import('./store')).getSettings()).toEqual(custom);
    expect(values.get(settingsKey)).toBe(JSON.stringify(custom));
    expect(values.get(deletedKey)).toBe('1');
  });
});
