import { describe, expect, it } from 'vitest';
import type { ComparisonSide, SaveTextResult } from '../../desktop/src/bridge';
import { changeText, discardBuffer, editingKey, getBuffer, receiveText, retainEditingBuffer, saveBuffer, subscribeEditing, type SaveText } from './store';

function source(text: string, version = '1'): ComparisonSide {
  return { label: 'Working tree', text, metadata: { bytes: text.length, encoding: 'utf-8', lineEnding: 'LF', finalNewline: text.endsWith('\n') }, editable: { id: 'capability', version } };
}
function fixture(save: SaveText = async (repositoryId, _id, _version, text) => ({ repositoryId, path: 'file.ts', state: 'saved', content: source(text, '2') })) {
  const repositoryId = crypto.randomUUID(), key = editingKey(repositoryId, 'file.ts');
  receiveText(repositoryId, 'file.ts', source('initial\n'), save);
  return { repositoryId, key, save };
}
describe('working text buffers', () => {
  it('shares drafts across aliases, preserves them on refresh, and reloads the newer disk version explicitly', () => {
    const { repositoryId, key, save } = fixture();
    changeText(key, 'draft\n');
    receiveText(repositoryId, 'file.ts', source('initial\n'), save);
    expect(getBuffer(key)?.text).toBe('draft\n');
    receiveText(repositoryId, 'file.ts', source('external\n', 'external-version'), save);
    expect(getBuffer(key)).toMatchObject({ text: 'draft\n', dirty: true });
    expect(getBuffer(key)?.error).toContain('changed on disk');
    discardBuffer(key);
    expect(getBuffer(key)).toMatchObject({ text: 'external\n', dirty: false, error: undefined });
  });
  it('keeps edits typed while an asynchronous save is in flight dirty', async () => {
    let finish!: (result: SaveTextResult) => void;
    const { key, repositoryId } = fixture(() => new Promise(resolve => { finish = resolve; }));
    changeText(key, 'first edit');
    const saving = saveBuffer(key);
    expect(getBuffer(key)?.saving).toBe(true);
    changeText(key, 'second edit');
    finish({ repositoryId, path: 'file.ts', state: 'saved', content: source('first edit', '2') });
    expect(await saving).toBe(false);
    expect(getBuffer(key)).toMatchObject({ text: 'second edit', baseline: 'first edit', dirty: true, saving: false });
    discardBuffer(key);
  });
  it('does not retry or discard stale saves, and isolates same-named files across repositories', async () => {
    const one = fixture(async repositoryId => ({ repositoryId, path: 'file.ts', state: 'stale', message: 'Changed externally' }));
    const two = fixture();
    changeText(one.key, 'mine');
    expect(await saveBuffer(one.key)).toBe(false);
    expect(getBuffer(one.key)).toMatchObject({ dirty: true, text: 'mine', error: 'Changed externally', saving: false });
    expect(getBuffer(two.key)?.text).toBe('initial\n');
    discardBuffer(one.key);
  });
  it('retains a newer external version observed while the save response is pending', async () => {
    let finish!: (result: SaveTextResult) => void;
    const { key, repositoryId, save } = fixture(() => new Promise(resolve => { finish = resolve; }));
    changeText(key, 'saved edit');
    const saving = saveBuffer(key);
    receiveText(repositoryId, 'file.ts', source('new external edit', '3'), save);
    finish({ repositoryId, path: 'file.ts', state: 'saved', content: source('saved edit', '2') });
    await saving;
    expect(getBuffer(key)?.incoming?.text).toBe('new external edit');
    expect(getBuffer(key)?.error).toContain('during the save');
    discardBuffer(key);
    expect(getBuffer(key)?.text).toBe('new external edit');
  });
  it('marks a successful save clean and keeps final-newline edits deliberate', async () => {
    const { key } = fixture();
    changeText(key, 'no final newline');
    expect(await saveBuffer(key)).toBe(true);
    expect(getBuffer(key)).toMatchObject({ dirty: false, text: 'no final newline', baseline: 'no final newline' });
  });

  it('releases clean text when its last surface closes, retaining shared split aliases', () => {
    const { key } = fixture();
    const releaseFirst = retainEditingBuffer(key), releaseSecond = retainEditingBuffer(key);
    releaseFirst(); releaseFirst();
    expect(getBuffer(key)?.text).toBe('initial\n');
    releaseSecond();
    expect(getBuffer(key)).toBeUndefined();
  });

  it('keeps an inactive draft through a remount and releases it after a later clean close', () => {
    const { key, repositoryId, save } = fixture();
    const release = retainEditingBuffer(key);
    changeText(key, 'unsaved draft'); release();
    expect(getBuffer(key)).toMatchObject({ text: 'unsaved draft', dirty: true });
    const releaseReopened = retainEditingBuffer(key);
    receiveText(repositoryId, 'file.ts', source('initial\n'), save);
    expect(getBuffer(key)?.text).toBe('unsaved draft');
    discardBuffer(key);
    expect(getBuffer(key)?.text).toBe('initial\n');
    releaseReopened();
    expect(getBuffer(key)).toBeUndefined();
  });

  it('protects an in-flight save after unmount and frees its completed clean buffer', async () => {
    let finish!: (result: SaveTextResult) => void;
    const { key, repositoryId } = fixture(() => new Promise(resolve => { finish = resolve; }));
    const release = retainEditingBuffer(key);
    changeText(key, 'submitted');
    const saving = saveBuffer(key);
    release();
    expect(getBuffer(key)).toMatchObject({ text: 'submitted', saving: true });
    finish({ repositoryId, path: 'file.ts', state: 'saved', content: source('submitted', '2') });
    expect(await saving).toBe(true);
    expect(getBuffer(key)).toBeUndefined();
  });

  it('reports the final save version to cache observers before freeing inactive text', async () => {
    const { key } = fixture();
    const release = retainEditingBuffer(key);
    changeText(key, 'saved version'); release();
    const versions: Array<string | undefined> = [];
    const stop = subscribeEditing(() => versions.push(getBuffer(key)?.source.editable?.version));
    try {
      expect(await saveBuffer(key)).toBe(true);
      expect(versions).toContain('2');
      expect(versions.at(-1)).toBeUndefined();
    } finally { stop(); }
  });

  it('does not discard edits typed during a save when their final surface unmounts', async () => {
    let finish!: (result: SaveTextResult) => void;
    const { key, repositoryId } = fixture(() => new Promise(resolve => { finish = resolve; }));
    const release = retainEditingBuffer(key);
    changeText(key, 'submitted');
    const saving = saveBuffer(key);
    changeText(key, 'newer draft'); release();
    finish({ repositoryId, path: 'file.ts', state: 'saved', content: source('submitted', '2') });
    expect(await saving).toBe(false);
    expect(getBuffer(key)).toMatchObject({ text: 'newer draft', baseline: 'submitted', dirty: true });
    discardBuffer(key);
    expect(getBuffer(key)).toBeUndefined();
  });

  it('preserves failed inactive saves and can discard them without retaining old text', async () => {
    const { key } = fixture(async repositoryId => ({ repositoryId, path: 'file.ts', state: 'stale', message: 'External edit' }));
    const release = retainEditingBuffer(key);
    changeText(key, 'draft'); release();
    expect(await saveBuffer(key)).toBe(false);
    expect(getBuffer(key)).toMatchObject({ text: 'draft', dirty: true, error: 'External edit' });
    discardBuffer(key);
    expect(getBuffer(key)).toBeUndefined();
  });
});
