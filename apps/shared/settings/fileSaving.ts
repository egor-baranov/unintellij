export interface FileSavingSettings { autoSave: boolean }

export const defaultFileSavingSettings: FileSavingSettings = Object.freeze({ autoSave: true });
const storageKey = 'smart-diff:file-saving:v1';
const listeners = new Set<() => void>();

function normalize(value: unknown): FileSavingSettings {
  const autoSave = value && typeof value === 'object' && 'autoSave' in value ? value.autoSave : undefined;
  return Object.freeze({ autoSave: typeof autoSave === 'boolean' ? autoSave : defaultFileSavingSettings.autoSave });
}

function load(): FileSavingSettings {
  try { return normalize(JSON.parse(localStorage.getItem(storageKey) ?? '{}')); }
  catch { return defaultFileSavingSettings; }
}

let current = load();
function update(settings: FileSavingSettings) {
  if (settings.autoSave === current.autoSave) return;
  current = settings;
  for (const listener of listeners) listener();
}

export function getFileSavingSettings(): FileSavingSettings { return current; }
export function subscribeFileSavingSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function saveFileSavingSettings(settings: FileSavingSettings): void {
  const value = normalize(settings);
  // A failed write must not enable or disable saving for the current session.
  try { localStorage.setItem(storageKey, JSON.stringify(value)); }
  catch { throw new Error('File saving settings could not be saved. Local storage is unavailable or full.'); }
  update(value);
}

function onStorage(event: StorageEvent) {
  if (event.key !== storageKey && event.key !== null) return;
  if (event.storageArea && event.storageArea !== localStorage) return;
  update(load());
}
window.addEventListener('storage', onStorage);
if (import.meta.hot) import.meta.hot.dispose(() => { window.removeEventListener('storage', onStorage); listeners.clear(); });
