import { useSyncExternalStore } from 'react';
import type { ComparisonSide, SaveTextResult } from '../../desktop/src/bridge';

export type SaveText = (repositoryId: string, editId: string, version: string, text: string) => Promise<SaveTextResult>;
export interface EditingBuffer {
  repositoryId: string; path: string; text: string; baseline: string; source: ComparisonSide;
  dirty: boolean; saving: boolean; error?: string; incoming?: ComparisonSide;
  save: SaveText; onSaved?: () => void;
}
export const editingKey = (repositoryId: string, path: string) => JSON.stringify([repositoryId, path]);
export const normalizeText = (text: string) => text.replace(/\r\n|\r/g, '\n');
const buffers = new Map<string, EditingBuffer>();
const consumers = new Map<string, number>();
const releasedBuffers = new Set<string>();
const listeners = new Set<() => void>();
const automaticSaveHolds = new Map<string, number>();
let revision = 0;
function emit() { revision++; for (const listener of listeners) listener(); }
export function subscribeEditing(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useEditingRevision() { return useSyncExternalStore(subscribeEditing, () => revision); }
export function getBuffer(key?: string) { return key ? buffers.get(key) : undefined; }
export function dirtyKeys() { return [...buffers].filter(([, value]) => value.dirty || value.saving).map(([key]) => key); }
export function automaticSavingPaused(key: string) { return automaticSaveHolds.has(key); }

function releaseCleanBuffer(key: string): boolean {
  const buffer = buffers.get(key);
  if (!releasedBuffers.has(key) || consumers.has(key) || buffer?.dirty || buffer?.saving) return false;
  releasedBuffers.delete(key);
  return buffers.delete(key);
}

/** A mounted editable surface owns a buffer, even when a split aliases its path.
 * Once the last surface leaves, clean text and its save callbacks are redundant
 * with the bounded endpoint cache. Drafts and in-flight writes remain until safe. */
export function retainEditingBuffer(key: string): () => void {
  consumers.set(key, (consumers.get(key) ?? 0) + 1);
  releasedBuffers.delete(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (consumers.get(key) ?? 1) - 1;
    if (remaining) consumers.set(key, remaining);
    else { consumers.delete(key); releasedBuffers.add(key); }
    if (releaseCleanBuffer(key)) emit();
  };
}
/** A pending discard decision must not race a delayed automatic write. */
export function pauseAutomaticSaving(keys: string[]): () => void {
  for (const key of keys) automaticSaveHolds.set(key, (automaticSaveHolds.get(key) ?? 0) + 1);
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const remaining = (automaticSaveHolds.get(key) ?? 1) - 1;
      if (remaining) automaticSaveHolds.set(key, remaining); else automaticSaveHolds.delete(key);
    }
    emit();
  };
}

/** Buffers outlive tab instances and are shared by project/diff/split views. */
export function receiveText(repositoryId: string, path: string, source: ComparisonSide, save: SaveText, onSaved?: () => void) {
  if (!source.editable) return;
  const key = editingKey(repositoryId, path), current = buffers.get(key), baseline = normalizeText(source.text);
  if (!current) {
    buffers.set(key, { repositoryId, path, text: baseline, baseline, source, dirty: false, saving: false, save, onSaved }); emit(); return;
  }
  current.save = save; current.onSaved = onSaved;
  if (current.source.editable?.version === source.editable.version) {
    current.source = source; return;
  }
  if (current.dirty || current.saving) {
    if (current.incoming?.editable?.version !== source.editable.version) {
      buffers.set(key, { ...current, incoming: source, error: 'This file changed on disk. Your edits are preserved. Reload to use the disk version, or copy your edits before resolving the conflict.' }); emit();
    }
    return;
  }
  buffers.set(key, { ...current, text: baseline, baseline, source, incoming: undefined, error: undefined }); emit();
}
export function changeText(key: string, text: string) {
  const current = buffers.get(key); if (!current) return;
  text = normalizeText(text);
  if (current.text === text) return;
  buffers.set(key, { ...current, text, dirty: text !== current.baseline }); releaseCleanBuffer(key); emit();
}
export async function saveBuffer(key: string): Promise<boolean> {
  const current = buffers.get(key);
  if (!current || !current.dirty) return !current?.saving;
  if (current.saving || !current.source.editable) return false;
  const submitted = current.text;
  buffers.set(key, { ...current, saving: true, error: undefined }); emit();
  try {
    const result = await current.save(current.repositoryId, current.source.editable.id, current.source.editable.version, submitted);
    const latest = buffers.get(key)!;
    if (result.state !== 'saved' || !result.content?.editable) {
      buffers.set(key, { ...latest, saving: false, error: result.message ?? 'Unable to save this file. Your edits are preserved.' }); emit(); return false;
    }
    const baseline = normalizeText(result.content.text);
    const incoming = latest.incoming?.editable?.version !== result.content.editable.version ? latest.incoming : undefined;
    buffers.set(key, { ...latest, source: result.content, baseline, dirty: latest.text !== baseline, saving: false, incoming,
      error: incoming ? 'This file changed on disk during the save. Your current editor contents are preserved. Reload to use the latest disk version.' : undefined });
    // Observers invalidate cached pre-save endpoints while the returned source
    // version is still available, before an inactive clean buffer is released.
    emit();
    current.onSaved?.();
    if (releaseCleanBuffer(key)) emit();
    return !buffers.get(key)?.dirty;
  } catch (error) {
    buffers.set(key, { ...buffers.get(key)!, saving: false, error: error instanceof Error ? error.message : String(error) }); emit(); return false;
  }
}
export function discardBuffer(key: string) {
  const current = buffers.get(key); if (!current || current.saving) return;
  const source = current.incoming ?? current.source, baseline = normalizeText(source.text);
  buffers.set(key, { ...current, source, text: baseline, baseline, dirty: false, incoming: undefined, error: undefined });
  emit();
  if (releaseCleanBuffer(key)) emit();
}
