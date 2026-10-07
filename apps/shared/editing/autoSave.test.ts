import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonSide, SaveTextResult } from '../../desktop/src/bridge';
import { AUTO_SAVE_DELAY_MS, AutoSaveController } from './autoSave';
import { changeText, dirtyKeys, discardBuffer, editingKey, getBuffer, pauseAutomaticSaving, receiveText, saveBuffer, type SaveText } from './store';

const source = (text: string, version = '1'): ComparisonSide => ({ label: 'Working tree', text,
  metadata: { bytes: text.length, encoding: 'utf-8', lineEnding: 'LF', finalNewline: text.endsWith('\n') }, editable: { id: 'edit-capability', version } });
function fixture(write?: SaveText) {
  const repositoryId = crypto.randomUUID(), path = 'file.ts', key = editingKey(repositoryId, path);
  let version = 1;
  const save = vi.fn(write ?? (async (id, _edit, _version, text) => ({ repositoryId: id, path, state: 'saved' as const, content: source(text, String(++version)) })));
  receiveText(repositoryId, path, source('initial\n'), save);
  return { key, repositoryId, path, save };
}

describe('automatic working-file saving', () => {
  let controller: AutoSaveController;
  beforeEach(() => { vi.useFakeTimers(); controller = new AutoSaveController(); controller.setEnabled(true); });
  afterEach(() => { controller.dispose(); dirtyKeys().forEach(discardBuffer); vi.useRealTimers(); });

  it('debounces typing per file without postponing unrelated pending saves', async () => {
    const first = fixture(), second = fixture();
    changeText(first.key, 'first');
    await vi.advanceTimersByTimeAsync(600);
    changeText(second.key, 'other');
    changeText(second.key, 'other final');
    await vi.advanceTimersByTimeAsync(400);
    expect(first.save).toHaveBeenCalledExactlyOnceWith(first.repositoryId, 'edit-capability', '1', 'first');
    expect(second.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(second.save).toHaveBeenCalledExactlyOnceWith(second.repositoryId, 'edit-capability', '1', 'other final');
    expect(getBuffer(first.key)?.dirty).toBe(false);
    expect(getBuffer(second.key)?.dirty).toBe(false);
  });

  it('resets the deadline on each edit and cancels an edit undone to its baseline', async () => {
    const { key, save } = fixture();
    changeText(key, 'first');
    await vi.advanceTimersByTimeAsync(800);
    changeText(key, 'second');
    await vi.advanceTimersByTimeAsync(800);
    expect(save).not.toHaveBeenCalled();
    changeText(key, 'initial\n');
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).not.toHaveBeenCalled();
  });

  it('cancels pending writes on disable and schedules existing drafts on enable', async () => {
    const { key, save } = fixture();
    changeText(key, 'draft');
    await vi.advanceTimersByTimeAsync(500);
    controller.setEnabled(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(save).not.toHaveBeenCalled();
    expect(getBuffer(key)?.dirty).toBe(true);
    controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('serializes changes made during a slow save using the returned version', async () => {
    let finish!: (result: SaveTextResult) => void;
    const entry = fixture(() => new Promise(resolve => { finish = resolve; }));
    changeText(entry.key, 'first');
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    changeText(entry.key, 'second');
    await vi.advanceTimersByTimeAsync(5000);
    expect(entry.save).toHaveBeenCalledTimes(1);
    finish({ repositoryId: entry.repositoryId, path: entry.path, state: 'saved', content: source('first', '2') });
    await vi.advanceTimersByTimeAsync(0);
    entry.save.mockImplementation(async (repositoryId, _id, _version, text) => ({ repositoryId, path: entry.path, state: 'saved', content: source(text, '3') }));
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    expect(entry.save).toHaveBeenLastCalledWith(entry.repositoryId, 'edit-capability', '2', 'second');
    expect(getBuffer(entry.key)).toMatchObject({ text: 'second', baseline: 'second', dirty: false, saving: false });
  });

  it('manual saves consume pending automatic work and remain available while disabled', async () => {
    const { key, save } = fixture();
    changeText(key, 'manual');
    await saveBuffer(key);
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
    controller.setEnabled(false);
    changeText(key, 'manual again');
    expect(await saveBuffer(key)).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending save when the disk version changes without overwriting the draft', async () => {
    const entry = fixture();
    changeText(entry.key, 'draft');
    receiveText(entry.repositoryId, entry.path, source('external', '2'), entry.save);
    await vi.advanceTimersByTimeAsync(3000);
    expect(entry.save).not.toHaveBeenCalled();
    expect(getBuffer(entry.key)).toMatchObject({ text: 'draft', dirty: true, incoming: { text: 'external' } });
    discardBuffer(entry.key);
    changeText(entry.key, 'resolved');
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    expect(entry.save).toHaveBeenCalledExactlyOnceWith(entry.repositoryId, 'edit-capability', '2', 'resolved');
  });

  it.each(['stale', 'rejected'] as const)('preserves %s save failures and never retries them in a loop', async kind => {
    const entry = fixture(async repositoryId => {
      if (kind === 'rejected') throw new Error('Write denied');
      return { repositoryId, path: 'file.ts', state: 'stale', message: 'Changed externally' };
    });
    changeText(entry.key, 'draft');
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    expect(getBuffer(entry.key)).toMatchObject({ dirty: true, saving: false, text: 'draft' });
    expect(getBuffer(entry.key)?.error).toBeTruthy();
    changeText(entry.key, 'later draft');
    controller.setEnabled(false); controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(entry.save).toHaveBeenCalledTimes(1);
  });

  it('pauses pending automatic writes while a save/discard decision is open', async () => {
    const { key, save } = fixture();
    changeText(key, 'draft');
    const release = pauseAutomaticSaving([key]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(save).not.toHaveBeenCalled();
    release(); release();
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    changeText(key, 'discard me');
    const discardDecision = pauseAutomaticSaving([key]);
    discardBuffer(key); discardDecision();
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('disposes timers/listeners and prevents a completed in-flight write from scheduling more', async () => {
    let finish!: (result: SaveTextResult) => void;
    const pending = fixture(), writing = fixture(() => new Promise(resolve => { finish = resolve; }));
    changeText(writing.key, 'submitted');
    await vi.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS);
    changeText(writing.key, 'new draft'); changeText(pending.key, 'pending');
    controller.dispose();
    finish({ repositoryId: writing.repositoryId, path: writing.path, state: 'saved', content: source('submitted', '2') });
    await vi.advanceTimersByTimeAsync(5000);
    expect(writing.save).toHaveBeenCalledTimes(1); expect(pending.save).not.toHaveBeenCalled();
    expect(getBuffer(writing.key)?.text).toBe('new draft');
  });
});
