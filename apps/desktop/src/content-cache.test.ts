import { describe, expect, it } from 'vitest';
import type { FileComparison, ProjectFile } from './bridge';
import { contentBytes, TabContentCache } from './content-cache';

const side = (text: string) => ({ label: 'Working tree', text, metadata: {
  bytes: new TextEncoder().encode(text).length, encoding: 'utf-8' as const, lineEnding: 'none' as const, finalNewline: false,
} });
const file = (path: string, text = 'contents'): ProjectFile => ({ repositoryId: 'repo', entryId: path, path, state: 'text', content: side(text) });
const comparison = (path: string, original: string, modified: string): FileComparison => ({ repositoryId: 'repo', changeId: path, generation: 1, path, state: 'text', original: side(original), modified: side(modified) });

describe('renderer tab endpoint cache', () => {
  it('bounds retained text by bytes even when the number of opened files is small', () => {
    const entry = comparison('a', 'a'.repeat(1000), 'b'.repeat(1000));
    const cache = new TabContentCache(() => false, contentBytes(entry) * 2, 200);
    cache.set('a', entry); cache.set('b', { ...entry, path: 'b' }); cache.set('c', { ...entry, path: 'c' });
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.retainedBytes).toBeLessThanOrEqual(contentBytes(entry) * 2);
  });

  it('retains recently revisited files instead of using insertion order', () => {
    const cache = new TabContentCache(() => false, 1024 * 1024, 2);
    cache.set('a', file('a')); cache.set('b', file('b'));
    expect(cache.get('a')?.path).toBe('a');
    cache.set('c', file('c'));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')?.path).toBe('a');
    expect(cache.get('c')?.path).toBe('c');
  });

  it('protects dirty or saving endpoints and reclaims them when draft protection ends', () => {
    const protectedPaths = new Set(['draft']);
    const cache = new TabContentCache(value => protectedPaths.has(value.path), 2048, 1);
    cache.set('draft', file('draft', 'x'.repeat(5000)));
    cache.set('clean', file('clean'));
    expect(cache.size).toBe(2);
    expect(cache.get('draft')).toMatchObject({ content: { text: 'x'.repeat(5000) } });
    protectedPaths.clear(); cache.prune();
    expect(cache.retainedBytes).toBeLessThanOrEqual(2048);
    expect(cache.get('draft')).toBeUndefined();
  });

  it('does not retain a single clean file larger than the cache budget', () => {
    const cache = new TabContentCache(() => false, 2048);
    cache.set('large', file('large', 'x'.repeat(5000)));
    expect(cache.size).toBe(0);
    expect(cache.retainedBytes).toBe(0);
  });

  it('accounts for replacing entries and deletes stale/non-text content', () => {
    const cache = new TabContentCache(() => false, 10000);
    cache.set('same', file('same', 'x'.repeat(1000)));
    cache.set('same', file('same', 'x'));
    expect(cache.retainedBytes).toBe(contentBytes(file('same', 'x')));
    cache.set('same', { ...file('same'), state: 'unavailable', content: undefined });
    expect(cache.size).toBe(0);
    cache.set('a', file('a')); cache.delete('a');
    expect(cache.retainedBytes).toBe(0);
  });

  it('invalidates old saved versions without discarding unrelated warm files', () => {
    const cache = new TabContentCache(() => false);
    cache.set('a', file('a')); cache.set('b', file('b'));
    cache.invalidate(content => content.path === 'a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')?.path).toBe('b');
    expect(cache.retainedBytes).toBe(contentBytes(file('b')));
  });

  it('counts both sides of a comparison and non-ASCII text without relying on disk byte size', () => {
    const value = comparison('unicode', 'é'.repeat(100), '你好'.repeat(50));
    expect(contentBytes(value)).toBe(1024 + 400);
  });
});
