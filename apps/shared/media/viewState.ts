export type MediaSideName = 'original' | 'modified';
export type MediaZoom = { mode: 'fit' } | { mode: 'scale'; scale: number };
export interface MediaScrollPosition { left: number; top: number }
export interface MediaViewState { zoom: MediaZoom; checkerboard: boolean; scroll: Record<MediaSideName, MediaScrollPosition> }

const viewStates = new Map<string, MediaViewState>();
const liveViews = new Map<string, () => MediaViewState>();
const listeners = new Set<() => void>();
const maximumViews = 200;

export function subscribeMediaViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function mediaViewChanged(): void { for (const listener of listeners) listener(); }

export function restoreMediaView(key: string, state: MediaViewState): void {
  viewStates.delete(key); viewStates.set(key, structuredClone(state));
  while (viewStates.size > maximumViews) viewStates.delete(viewStates.keys().next().value!);
}
export function getMediaView(key: string): MediaViewState | undefined {
  const state = liveViews.get(key)?.() ?? viewStates.get(key);
  return state ? structuredClone(state) : undefined;
}
export function initialMediaView(key: string): MediaViewState {
  return getMediaView(key) ?? { zoom: { mode: 'fit' }, checkerboard: true, scroll: { original: { left: 0, top: 0 }, modified: { left: 0, top: 0 } } };
}
export function trackMediaView(key: string, capture: () => MediaViewState): () => void {
  liveViews.set(key, capture); mediaViewChanged();
  return () => {
    if (liveViews.get(key) !== capture) return;
    restoreMediaView(key, capture()); liveViews.delete(key); mediaViewChanged();
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function scrollPosition(value: unknown): MediaScrollPosition | undefined {
  const input = object(value);
  if (!input || typeof input.left !== 'number' || !Number.isFinite(input.left) || input.left < 0 || input.left > 1_000_000_000 || typeof input.top !== 'number' || !Number.isFinite(input.top) || input.top < 0 || input.top > 1_000_000_000) return;
  return { left: input.left, top: input.top };
}
export function decodeMediaView(value: unknown): MediaViewState | undefined {
  const input = object(value), zoom = object(input?.zoom), scroll = object(input?.scroll);
  const original = scrollPosition(scroll?.original), modified = scrollPosition(scroll?.modified);
  if (!input || !zoom || !original || !modified || typeof input.checkerboard !== 'boolean') return;
  if (zoom.mode !== 'fit' && (zoom.mode !== 'scale' || typeof zoom.scale !== 'number' || !Number.isFinite(zoom.scale) || zoom.scale < .05 || zoom.scale > 8)) return;
  return { zoom: zoom.mode === 'fit' ? { mode: 'fit' } : { mode: 'scale', scale: zoom.scale as number }, checkerboard: input.checkerboard, scroll: { original, modified } };
}
