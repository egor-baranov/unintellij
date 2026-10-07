import { describe, expect, it } from 'vitest';
import { computeComparison } from './engine';
import type { DiffRequest } from './model';
import { DiffResultCache } from './result-cache';

const request = (original = 'before', modified = 'after'): DiffRequest => ({
  requestId: 1, originalVersion: 2, modifiedVersion: 3, original, modified,
  ignoreTrimWhitespace: false, maxComputationTimeMs: 100,
});
function remember(cache: DiffResultCache, input: DiffRequest) { cache.put(input, computeComparison(input)); }

describe('completed comparison cache', () => {
  it('rebinds request identities without sharing mutable correspondence between viewers', () => {
    const cache = new DiffResultCache();
    const input = request('const x = 1;\n', 'const x = 2;\n');
    const result = computeComparison(input);
    cache.put(input, result);
    result.changes[0].original.start = 999;
    const next = { ...input, requestId: 20, originalVersion: 7, modifiedVersion: 8 };
    const hit = cache.get(next)!;
    expect(hit).toMatchObject({ requestId: 20, originalVersion: 7, modifiedVersion: 8, status: 'complete' });
    expect(hit.changes[0].original.start).toBe(1);
    hit.changes[0].innerChanges.length = 0;
    expect(cache.get(next)!.changes[0].innerChanges.length).toBeGreaterThan(0);
  });

  it('requires exact contents and comparison options, including CRLF and Unicode', () => {
    const cache = new DiffResultCache();
    const input = request('café 😀\r\n', 'café 😃\r\n');
    remember(cache, input);
    expect(cache.get(input)).toBeDefined();
    for (const changed of [
      { original: 'café 😀\n' }, { modified: 'café 😃\n' }, { original: 'café 😀\r\n' },
      { ignoreTrimWhitespace: true }, { maxComputationTimeMs: 200 },
    ]) expect(cache.get({ ...input, ...changed })).toBeUndefined();
  });

  it('never stores incomplete or mismatched worker results', () => {
    const cache = new DiffResultCache();
    const input = request(), result = computeComparison(input);
    for (const changed of [
      { status: 'timeout' as const }, { requestId: 2 }, { originalVersion: 99 }, { modifiedVersion: 99 },
    ]) {
      cache.put(input, { ...result, ...changed });
      expect(cache.get(input)).toBeUndefined();
    }
  });

  it('bounds entry count and evicts the least recently used comparison', () => {
    const cache = new DiffResultCache(2);
    const a = request('a', 'A'), b = request('b', 'B'), c = request('c', 'C');
    remember(cache, a); remember(cache, b);
    expect(cache.get(a)).toBeDefined();
    remember(cache, c);
    expect(cache.get(b)).toBeUndefined();
    expect(cache.get(a)).toBeDefined(); expect(cache.get(c)).toBeDefined();
  });

  it('bounds combined input bytes, counts UTF-16 units, and does not retain oversized inputs', () => {
    const cache = new DiffResultCache(10, 12);
    const a = request('a', 'A'), b = request('😀', '😃'), c = request('c', 'C');
    remember(cache, a); remember(cache, b); // 4 + 8 bytes, exactly the budget.
    expect(cache.get(a)).toBeDefined(); expect(cache.get(b)).toBeDefined();
    remember(cache, c);
    expect(cache.get(a)).toBeUndefined();
    expect(cache.get(b)).toBeDefined(); expect(cache.get(c)).toBeDefined();
    const oversized = request('1234', '5678');
    remember(cache, oversized);
    expect(cache.get(oversized)).toBeUndefined();
    expect(cache.get(b)).toBeDefined(); expect(cache.get(c)).toBeDefined();
    cache.clear();
    expect(cache.get(c)).toBeUndefined();
  });

  it('replacing the same entry does not consume its input budget twice', () => {
    const cache = new DiffResultCache(3, 8);
    const a = request('a', 'A'), b = request('b', 'B');
    remember(cache, a); remember(cache, b); remember(cache, a);
    expect(cache.get(a)).toBeDefined(); expect(cache.get(b)).toBeDefined();
  });

  it('bounds retained result ranges separately from the source text budget', () => {
    const cache = new DiffResultCache(10, 1024, 2);
    const a = request('a', 'a'), b = request('b', 'b'), c = request('c', 'c');
    remember(cache, a); remember(cache, b); remember(cache, c); // One unchanged correspondence each.
    expect(cache.get(a)).toBeUndefined();
    expect(cache.get(b)).toBeDefined(); expect(cache.get(c)).toBeDefined();
    const changed = request('one\ntwo\nthree\nfour\n', 'ONE\ntwo\nTHREE\nfour\n');
    remember(cache, changed);
    expect(cache.get(changed)).toBeUndefined();
    expect(cache.get(b)).toBeDefined(); expect(cache.get(c)).toBeDefined();
  });
});
