import { migrateDeletedTreeColor, migrateUntrackedTreeColor, normalizeSettings } from './model';
import type { AppSettings } from './types';

export const SETTINGS_KEY = 'smart-diff:appearance:v1';
const listeners = new Set<() => void>();
const TREE_COLOR_MIGRATION_KEY = 'smart-diff:appearance:untracked-red:v1';
const DELETED_COLOR_MIGRATION_KEY = 'smart-diff:appearance:deleted-muted:v1';
function load(): AppSettings {
  try {
    const settings = normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
    const migrateDeleted = !localStorage.getItem(DELETED_COLOR_MIGRATION_KEY);
    const migrateUntracked = !localStorage.getItem(TREE_COLOR_MIGRATION_KEY);
    if (!migrateDeleted && !migrateUntracked) return settings;
    let migrated = migrateDeleted ? migrateDeletedTreeColor(settings) : settings;
    if (migrateUntracked) migrated = migrateUntrackedTreeColor(migrated);
    try {
      if (migrated !== settings) localStorage.setItem(SETTINGS_KEY, JSON.stringify(migrated));
      if (migrateDeleted) localStorage.setItem(DELETED_COLOR_MIGRATION_KEY, '1');
      if (migrateUntracked) localStorage.setItem(TREE_COLOR_MIGRATION_KEY, '1');
    } catch { /* A storage failure must not discard the rest of the settings. */ }
    return migrated;
  }
  catch { return normalizeSettings({}); }
}
let saved = load();
let current = saved;
let previewing = false;
function notify() { for (const listener of listeners) listener(); }
export function getSettings(): AppSettings { return current; }
export function subscribeSettings(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function previewSettings(settings: AppSettings): void { current = normalizeSettings(settings); previewing = true; notify(); }
export function saveSettings(settings: AppSettings): void {
  const value = normalizeSettings(settings);
  // Keep the applied snapshot intact when persistence is denied or out of space.
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(value)); }
  catch { throw new Error('Settings could not be saved. Local storage is unavailable or full.'); }
  saved = value; current = saved; previewing = false; notify();
}
export function cancelSettingsPreview(): void { current = saved; previewing = false; notify(); }
function onStorage(event: StorageEvent) {
  if (event.key !== SETTINGS_KEY && event.key !== null) return;
  saved = load();
  if (!previewing) { current = saved; notify(); }
}
window.addEventListener('storage', onStorage);
if (import.meta.hot) import.meta.hot.dispose(() => { window.removeEventListener('storage', onStorage); listeners.clear(); });
