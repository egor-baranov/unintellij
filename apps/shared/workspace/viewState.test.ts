import { afterEach, describe, expect, it, vi } from 'vitest';
import type { editor } from 'monaco-editor';
import type { SmartDiff, ViewState } from 'monaco-smart-diff';
import { captureWorkspaceViews, decodeWorkspaceViews, getWorkspaceView, rememberWorkspaceView, restoreWorkspaceViews, subscribeWorkspaceViews, trackWorkspaceDiff, trackWorkspaceFile } from './viewState';
import { getMediaView, mediaViewChanged, trackMediaView, type MediaViewState } from '../media/viewState';

function fileView(line: number): editor.ICodeEditorViewState {
  return {
    cursorState: [{ inSelectionMode: true, selectionStart: { lineNumber: line, column: 3 }, position: { lineNumber: line + 2, column: 9 } }],
    viewState: { firstPosition: { lineNumber: line, column: 2 }, firstPositionDeltaTop: -7, scrollLeft: 120 },
    contributionsState: {},
  };
}
function diffView(line: number): ViewState {
  return {
    original: { anchor: { line, offset: 71, scrollLeft: 85 }, selections: [{ selectionStartLineNumber: Math.floor(line), selectionStartColumn: 3, positionLineNumber: Math.floor(line) + 2, positionColumn: 4 }] },
    modified: { anchor: { line: line + 5.5, offset: -1, scrollLeft: 10 }, selections: null },
    expandedRegions: ['unchanged-4-100-4-100'], currentChangeId: 'change-12', splitRatio: .63,
  };
}
function fakeEditor(read: () => editor.ICodeEditorViewState | null) {
  const callbacks = new Set<() => void>();
  const on = (callback: () => void) => { callbacks.add(callback); return { dispose: () => callbacks.delete(callback) }; };
  return {
    instance: { saveViewState: read, onDidScrollChange: on, onDidChangeCursorSelection: on, onDidChangeHiddenAreas: on, onDidLayoutChange: on } as unknown as editor.IStandaloneCodeEditor,
    change: () => { for (const callback of callbacks) callback(); },
    callbacks,
  };
}
afterEach(() => vi.useRealTimers());

describe('durable editor views', () => {
  it('persists Markdown layout and reading position independently from the source editor', () => {
    const markdown = { mode: 'preview' as const, ratio: .62, scrollTop: 540, sync: false };
    restoreWorkspaceViews({ 'markdown-original': { file: fileView(40), markdown: { ...markdown, html: '<h1>not durable</h1>' } } });
    const view = getWorkspaceView('markdown-original')!;
    expect(view).toEqual({ file: fileView(40), markdown });
    rememberWorkspaceView('markdown-copy', view);
    rememberWorkspaceView('markdown-copy', { markdown: { ...markdown, mode: 'code' } });
    expect(getWorkspaceView('markdown-original')?.markdown?.mode).toBe('preview');
    expect(getWorkspaceView('markdown-copy')?.markdown?.mode).toBe('code');
    const restored = decodeWorkspaceViews(JSON.parse(JSON.stringify(captureWorkspaceViews(['markdown-original', 'markdown-copy']))));
    expect(restored['markdown-original']).toEqual(view);
    expect(decodeWorkspaceViews({ bad: { markdown: { mode: 'unknown' } } })).toEqual({});
    expect(decodeWorkspaceViews({ bounded: { markdown: { mode: 'split', ratio: Infinity, scrollTop: -5, sync: 'yes' } } }).bounded.markdown)
      .toEqual({ mode: 'split', ratio: .5, scrollTop: 0, sync: true });
  });

  it('restores inline preferences while accepting older views and rejecting unknown modes', () => {
    const common = { layout: 'compact', sync: true, collapse: true, whitespace: false, wrap: false };
    const views = decodeWorkspaceViews({
      inline: { preferences: { ...common, viewMode: 'inline' } },
      split: { preferences: { ...common, viewMode: 'side-by-side' } },
      legacy: { preferences: common },
      invalid: { preferences: { ...common, viewMode: 'unknown' } },
    });
    expect(views.inline.preferences?.viewMode).toBe('inline');
    expect(views.split.preferences?.viewMode).toBe('side-by-side');
    expect(views.legacy.preferences).toEqual(common);
    expect(views.invalid.preferences).toEqual(common);
  });
  it('round-trips independent file and diff positions while omitting transient model-bound contributions', () => {
    const file = fileView(250);
    file.contributionsState = {
      'editor.contrib.folding': { collapsedRegions: [{ startLineNumber: 30, endLineNumber: 80, isCollapsed: true, source: 1, checksum: 415 }], lineCount: 600, foldedImports: true },
      'editor.contrib.wordHighlighter': { model: 'inmemory://old-model', ranges: ['stale'] },
    };
    const input = { durable: { file, diff: diffView(89.5), preferences: { layout: 'aligned', sync: false, collapse: true, whitespace: false, wrap: true, splitRatio: .63 }, modelId: 'obsolete', content: 'unsaved text' } };
    const decoded = decodeWorkspaceViews(JSON.parse(JSON.stringify(input)));
    expect(decoded.durable.file).toEqual({ ...file, contributionsState: { 'editor.contrib.folding': file.contributionsState['editor.contrib.folding'] } });
    expect(decoded.durable.diff).toEqual(input.durable.diff);
    expect(decoded.durable.preferences).toEqual(input.durable.preferences);
    expect(decoded.durable).not.toHaveProperty('modelId');
    expect(decoded.durable).not.toHaveProperty('content');
    input.durable.diff.original.anchor.line = 1;
    expect(decoded.durable.diff?.original.anchor.line).toBe(89.5);
  });

  it('rejects malformed positions and limits hostile persisted arrays and keys', () => {
    const malformed = fileView(10); malformed.viewState.scrollLeft = Infinity;
    const diff = diffView(10); diff.modified.anchor.line = -4;
    const excessive = diffView(10); excessive.expandedRegions = Array.from({ length: 1500 }, (_, index) => `unchanged-${index}`);
    const decoded = decodeWorkspaceViews({ ...JSON.parse('{"__proto__":{"preferences":{"layout":"aligned"}}}'), badFile: { file: malformed }, badDiff: { diff }, bounded: { diff: excessive }, invalidPreferences: { preferences: { wrap: 'yes' } } });
    expect(Object.keys(decoded)).toEqual(['bounded']);
    expect(decoded.bounded.diff?.expandedRegions).toHaveLength(1000);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(decodeWorkspaceViews({ file: { file: { viewState: null, cursorState: [null] } } })).toEqual({});
  });

  it('keeps inactive tabs and split copies independent and retains both surface kinds', () => {
    restoreWorkspaceViews({ first: { file: fileView(120), diff: diffView(70) }, second: { file: fileView(300) } });
    let current = fileView(180);
    const first = fakeEditor(() => current);
    const stop = trackWorkspaceFile('first', first.instance);
    expect(captureWorkspaceViews(['first', 'second'])).toMatchObject({ first: { file: fileView(180), diff: diffView(70) }, second: { file: fileView(300) } });
    current = fileView(190);
    stop();
    rememberWorkspaceView('first', { preferences: { layout: 'compact', sync: true, collapse: false, whitespace: false, wrap: false } });
    expect(captureWorkspaceViews(['first'])).toMatchObject({ first: { file: fileView(190), diff: diffView(70) } });
    expect(first.callbacks.size).toBe(0);
    expect(captureWorkspaceViews(['second']).second.file).toEqual(fileView(300));
    expect(captureWorkspaceViews(['unknown'])).toEqual({});
  });

  it('captures the latest scroll synchronously and coalesces ongoing view changes', () => {
    vi.useFakeTimers();
    const listener = vi.fn(), unsubscribe = subscribeWorkspaceViews(listener);
    let current = fileView(1);
    const file = fakeEditor(() => current), stop = trackWorkspaceFile('live-file', file.instance);
    current = fileView(456);
    file.change(); file.change();
    expect(listener).not.toHaveBeenCalled();
    // beforeunload does not wait for the persistence debounce or unmount.
    expect(captureWorkspaceViews(['live-file'])['live-file'].file).toEqual(fileView(456));
    vi.advanceTimersByTime(150);
    expect(listener).toHaveBeenCalledTimes(1);
    file.change(); vi.advanceTimersByTime(150);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe(); stop();
    vi.advanceTimersByTime(150);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not replace a restored diff with its temporary initial worker state', () => {
    restoreWorkspaceViews({ pending: { diff: diffView(500) } });
    let comparison: object | undefined, state = diffView(1);
    const original = fakeEditor(() => null), modified = fakeEditor(() => null);
    const viewer = { getComparison: () => comparison, saveViewState: () => state, getEditors: () => ({ original: original.instance, modified: modified.instance }) } as unknown as SmartDiff;
    const stop = trackWorkspaceDiff('pending', viewer);
    expect(getWorkspaceView('pending')?.diff).toEqual(diffView(500));
    comparison = {}; state = diffView(500);
    expect(getWorkspaceView('pending')?.diff).toEqual(diffView(500));
    // Later content recomputation must still capture new reading positions.
    comparison = undefined; state = diffView(550);
    expect(getWorkspaceView('pending')?.diff).toEqual(diffView(550));
    stop();
    expect(getWorkspaceView('pending')?.diff).toEqual(diffView(550));
  });

  it('includes media zoom and both pans without storing media bytes or URLs', () => {
    const media: MediaViewState = { zoom: { mode: 'scale', scale: 2 }, checkerboard: false, scroll: { original: { left: 14, top: 35 }, modified: { left: 75, top: 99 } } };
    restoreWorkspaceViews({ image: { media: { ...media, base64: 'private', url: 'blob:old-document' } } });
    expect(getMediaView('tab:image')).toEqual(media);
    const stop = trackMediaView('tab:image', () => ({ ...media, scroll: { ...media.scroll, modified: { left: 111, top: 222 } } }));
    const snapshot = captureWorkspaceViews(['image']);
    expect(snapshot.image.media?.scroll.modified).toEqual({ left: 111, top: 222 });
    expect(snapshot.image.media).not.toHaveProperty('base64');
    expect(snapshot.image.media).not.toHaveProperty('url');
    stop();
    expect(captureWorkspaceViews(['image'])).toEqual(snapshot);
    expect(decodeWorkspaceViews({ invalid: { media: { ...media, zoom: { mode: 'scale', scale: Infinity } } } })).toEqual({});
  });

  it('notifies persistence of media view changes while a tab remains mounted', () => {
    vi.useFakeTimers();
    const listener = vi.fn(), unsubscribe = subscribeWorkspaceViews(listener);
    mediaViewChanged(); vi.advanceTimersByTime(150);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
