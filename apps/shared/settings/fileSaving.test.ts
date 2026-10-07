import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const key = 'smart-diff:file-saving:v1';
let values: Map<string, string>;
let events: EventTarget;
let storage: Pick<Storage, 'getItem' | 'setItem'>;
const loadStore = () => import('./fileSaving');

function storageEvent(changedKey: string | null, storageArea: unknown = storage) {
  events.dispatchEvent(Object.assign(new Event('storage'), { key: changedKey, storageArea }));
}

beforeEach(() => {
  vi.resetModules();
  values = new Map();
  events = new EventTarget();
  storage = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => { values.set(name, value); }),
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', events);
});
afterEach(() => vi.unstubAllGlobals());

describe('file saving settings', () => {
  it('enables automatic saving by default without writing settings', async () => {
    const store = await loadStore();
    expect(store.defaultFileSavingSettings).toEqual({ autoSave: true });
    expect(store.getFileSavingSettings()).toEqual({ autoSave: true });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('persists an explicit disabled value independently of theme schemes', async () => {
    values.set('smart-diff:appearance:v1', '{"name":"Custom scheme"}');
    const store = await loadStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribeFileSavingSettings(listener);
    store.saveFileSavingSettings({ autoSave: false });
    expect(values.get(key)).toBe('{"autoSave":false}');
    expect(values.get('smart-diff:appearance:v1')).toBe('{"name":"Custom scheme"}');
    expect(store.getFileSavingSettings()).toEqual({ autoSave: false });
    expect(listener).toHaveBeenCalledTimes(1);
    store.saveFileSavingSettings({ autoSave: false });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.saveFileSavingSettings({ autoSave: true });
    expect(listener).toHaveBeenCalledTimes(1);
    vi.resetModules();
    expect((await loadStore()).getFileSavingSettings()).toEqual({ autoSave: true });
  });

  it.each(['{', 'null', '[]', '{}', '{"autoSave":"false"}', '{"autoSave":0}'])('falls back to enabled for malformed stored settings: %s', async value => {
    values.set(key, value);
    expect((await loadStore()).getFileSavingSettings()).toEqual({ autoSave: true });
  });

  it('loads a saved false value without coercing it to the default', async () => {
    values.set(key, '{"autoSave":false}');
    expect((await loadStore()).getFileSavingSettings()).toEqual({ autoSave: false });
  });

  it('applies cross-window changes and storage clearing, ignoring unrelated settings and session storage', async () => {
    const store = await loadStore();
    const listener = vi.fn();
    store.subscribeFileSavingSettings(listener);
    values.set(key, '{"autoSave":false}');
    storageEvent('smart-diff:appearance:v1');
    storageEvent(key, {});
    expect(store.getFileSavingSettings()).toEqual({ autoSave: true });
    expect(listener).not.toHaveBeenCalled();
    storageEvent(key);
    expect(store.getFileSavingSettings()).toEqual({ autoSave: false });
    expect(listener).toHaveBeenCalledTimes(1);
    values.clear();
    storageEvent(null);
    expect(store.getFileSavingSettings()).toEqual({ autoSave: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps the applied value when persistence fails', async () => {
    const store = await loadStore();
    const listener = vi.fn();
    store.subscribeFileSavingSettings(listener);
    vi.mocked(storage.setItem).mockImplementation(() => { throw new Error('Quota exceeded'); });
    expect(() => store.saveFileSavingSettings({ autoSave: false })).toThrow('File saving settings could not be saved');
    expect(store.getFileSavingSettings()).toEqual({ autoSave: true });
    expect(listener).not.toHaveBeenCalled();
  });

  it('uses the default if storage cannot be read', async () => {
    vi.mocked(storage.getItem).mockImplementation(() => { throw new Error('Access denied'); });
    expect((await loadStore()).getFileSavingSettings()).toEqual({ autoSave: true });
  });
});
