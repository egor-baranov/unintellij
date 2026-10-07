import { describe, expect, it } from 'vitest';
import { CompactPathSet } from './compact-path-set';
import { nodeGitFacts, projectGitSnapshot } from './project-facts';

describe('compact tracked paths', () => {
  it('preserves insertion order, exact membership and duplicates for unsorted Unicode paths', () => {
    const paths = ['z/last.ts', 'src/名 café\tline\n.ts', 'a/first.ts', 'src/名 cafe.ts', '', 'src/😀.ts', 'src/名 café\tline\n.ts'];
    const expected = new Set(paths);
    const actual = new CompactPathSet();
    for (const value of paths) expect(actual.add(value)).toBe(actual);
    expect(actual.size).toBe(expected.size);
    expect([...actual]).toEqual([...expected]);
    for (const value of paths) expect(actual.has(value), value).toBe(true);
    for (const value of ['src/名 café', 'z/last.tsx', 'src/😁.ts', 'SRC/😀.ts', 'missing']) expect(actual.has(value), value).toBe(false);
  });

  it('compares actual path bytes when FNV-1a hashes collide', () => {
    // Both strings deliberately have the same 32-bit FNV-1a hash (0x5e4daa9d).
    const actual = new CompactPathSet().add('costarring');
    expect(actual.has('liquid')).toBe(false);
    actual.add('liquid').add('costarring');
    expect(actual.size).toBe(2);
    expect([...actual]).toEqual(['costarring', 'liquid']);
    expect(actual.has('costarring')).toBe(true);
    expect(actual.has('liquid')).toBe(true);
  });

  it('handles block anchors and lookup growth while preserving a compact iterator', () => {
    const paths = Array.from({ length: 4097 }, (_, index) => `workspace/${(index * 31) % 4097}/src/名-${index}.ts`);
    const actual = new CompactPathSet();
    for (const value of paths) actual.add(value);
    actual.compact();
    for (const value of paths) expect(actual.has(value), value).toBe(true);
    expect([...actual]).toEqual(paths);
    for (const value of paths) actual.add(value);
    actual.add('removed/from-index.ts');
    expect(actual.size).toBe(paths.length + 1);
    expect([...actual].at(-1)).toBe('removed/from-index.ts');
    expect(actual.has('removed/from-index.ts')).toBe(true);
  });

  it('allows lookups and additions during iteration without corrupting reconstructed paths', () => {
    const actual = new CompactPathSet().add('deep/shared/a').add('deep/shared/b');
    const iterator = actual[Symbol.iterator]();
    expect(iterator.next().value).toBe('deep/shared/a');
    expect(actual.has('deep/shared/b')).toBe(true);
    actual.add('deep/shared/c');
    expect([...iterator]).toEqual(['deep/shared/b', 'deep/shared/c']);
  });

  it('retains staged-deletion identity when project facts add a path absent from the index', () => {
    const actual = new CompactPathSet().add('kept/source.ts').compact();
    const facts = projectGitSnapshot([{
      kind: 'ordinary', xy: 'D.', path: 'deleted/source.ts', submodule: 'N...',
      headMode: '100644', indexMode: '000000', workMode: '000000', headOid: 'a'.repeat(40), indexOid: '0'.repeat(40),
    }], actual);
    expect(actual.size).toBe(2);
    expect([...actual]).toEqual(['kept/source.ts', 'deleted/source.ts']);
    expect(facts.trackedDirectories.has('deleted')).toBe(true);
    expect(nodeGitFacts(facts, 'deleted/source.ts', false, undefined, true)).toMatchObject({ tracked: true, index: 'deleted' });
  });

  it('shares long byte prefixes without splitting Unicode during reconstruction', () => {
    const prefix = 'nested/'.repeat(8000);
    const paths = [`${prefix}名.ts`, `${prefix}各.ts`, `${prefix}😀.ts`];
    const actual = new CompactPathSet();
    for (const value of paths) actual.add(value);
    expect([...actual]).toEqual(paths);
    for (const value of paths) expect(actual.has(value)).toBe(true);
    expect(() => actual.add('a'.repeat(65536))).toThrow('filename safety limit');
  });
});
