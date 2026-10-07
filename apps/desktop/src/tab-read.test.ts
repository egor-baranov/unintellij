import { describe, expect, it } from 'vitest';
import type { FileComparison, ProjectFile } from './bridge';
import { initialTabContent, PendingComparisonReads, PendingTabRead, verifiedComparisonContent } from './tab-read';

const comparison = { repositoryId: 'repository', documentId: 'comparison:file.ts', capabilityId: 'unchanged-endpoints', kind: 'comparison' as const, generation: 1 };

describe('shared pending comparison reads', () => {
  it('reuses a read across split panes or rapid navigation, then revalidates after completion', async () => {
    const reads = new PendingComparisonReads();
    let complete!: (value: FileComparison) => void;
    let calls = 0;
    const content: FileComparison = { repositoryId: 'repo', changeId: 'change', path: 'file.ts', generation: 1, state: 'text' };
    const load = () => { calls++; return new Promise<FileComparison>(resolve => { complete = resolve; }); };
    const first = reads.read('repo', 'change', load);
    expect(reads.read('repo', 'change', load)).toBe(first);
    complete(content);
    expect(await first).toBe(content);
    const next = reads.read('repo', 'change', load);
    expect(next).not.toBe(first);
    expect(calls).toBe(2);
    complete(content); await next;
  });

  it('isolates new endpoint capabilities and repositories while a read is pending', async () => {
    const reads = new PendingComparisonReads();
    const content: FileComparison = { repositoryId: 'repo', changeId: 'change', path: 'file.ts', generation: 1, state: 'text' };
    const first = reads.read('repo', 'change', async () => content);
    const renamed = reads.read('repo', 'new-change', async () => content);
    const other = reads.read('another-repo', 'change', async () => content);
    expect(renamed).not.toBe(first); expect(other).not.toBe(first);
    await Promise.all([first, renamed, other]);
  });

  it('does not retain a failed read or poison a retry', async () => {
    const reads = new PendingComparisonReads();
    const failed = reads.read('repo', 'change', async () => { throw new Error('Read failed'); });
    expect(reads.read('repo', 'change', () => { throw new Error('Duplicate request'); })).toBe(failed);
    await expect(failed).rejects.toThrow('Read failed');
    await expect(reads.read('repo', 'change', async () => ({ repositoryId: 'repo', changeId: 'change', generation: 1, path: 'file.ts', state: 'text' }))).resolves.toMatchObject({ state: 'text' });
  });
});

describe('pending tab reads', () => {
  it('accepts a slow comparison while unrelated snapshots continue arriving', () => {
    const reads = new PendingTabRead();
    const first = reads.begin(comparison)!;
    for (let generation = 2; generation <= 20; generation++) {
      expect(reads.begin({ ...comparison, generation })).toBeUndefined();
      expect(reads.isCurrent(first)).toBe(true);
    }
    expect(reads.finish(first)).toBe(true);
    // An explicit refresh after completion can still retry a failed read.
    expect(reads.begin({ ...comparison, generation: 21 })).toBeGreaterThan(first);
  });

  it('immediately replaces a read when the comparison endpoints change', () => {
    const reads = new PendingTabRead();
    const old = reads.begin(comparison)!;
    const current = reads.begin({ ...comparison, capabilityId: 'new-endpoints', generation: 2 })!;
    expect(reads.isCurrent(old)).toBe(false);
    expect(reads.finish(old)).toBe(false);
    expect(reads.begin({ ...comparison, capabilityId: 'new-endpoints', generation: 3 })).toBeUndefined();
    expect(reads.finish(current)).toBe(true);
  });

  it('still invalidates project file reads for a newer filesystem generation', () => {
    const reads = new PendingTabRead();
    const file = { ...comparison, kind: 'file' as const };
    const old = reads.begin(file)!;
    const current = reads.begin({ ...file, generation: 2 })!;
    expect(reads.isCurrent(old)).toBe(false);
    expect(reads.isCurrent(current)).toBe(true);
  });

  it('rejects late completions after a tab closes or switches document', () => {
    const reads = new PendingTabRead();
    const old = reads.begin(comparison)!;
    const other = reads.begin({ ...comparison, documentId: 'comparison:other.ts' })!;
    expect(reads.finish(old)).toBe(false);
    reads.cancel();
    expect(reads.isCurrent(other)).toBe(false);
    expect(reads.finish(other)).toBe(false);
    expect(reads.begin(comparison)).toBeGreaterThan(other);
  });
});

describe('initial tab content', () => {
  const cached: FileComparison = { repositoryId: 'repository', path: 'file.ts', changeId: 'unchanged-endpoints', generation: 1, state: 'text' };
  const target = { repositoryId: cached.repositoryId, path: cached.path, kind: 'comparison' as const, changeId: cached.changeId };

  it('immediately reuses a clean comparison with the current endpoint capability', () => {
    expect(initialTabContent(cached, target, false)).toBe(cached);
    expect(verifiedComparisonContent(cached, { ...target, generation: 1 })).toBe(cached);
  });

  it('requires revalidation after a repository refresh even if its endpoint capability survived', () => {
    expect(initialTabContent(cached, target, false)).toBe(cached);
    expect(verifiedComparisonContent(cached, { ...target, generation: 2 })).toBeUndefined();
    expect(verifiedComparisonContent({ ...cached, state: 'stale' }, { ...target, generation: 1 })).toBeUndefined();
    expect(verifiedComparisonContent(cached, { ...target, changeId: 'new-endpoints', generation: 1 })).toBeUndefined();
  });

  it('does not display an old comparison after endpoints change or disappear', () => {
    expect(initialTabContent(cached, { ...target, changeId: 'new-endpoints' }, false)).toBeUndefined();
    expect(initialTabContent(cached, { ...target, changeId: undefined }, false)).toBeUndefined();
  });

  it('preserves the original draft comparison but never crosses a repository or document', () => {
    expect(initialTabContent(cached, { ...target, changeId: 'new-endpoints' }, true)).toBe(cached);
    expect(initialTabContent(cached, { ...target, repositoryId: 'other' }, true)).toBeUndefined();
    expect(initialTabContent(cached, { ...target, path: 'other.ts' }, true)).toBeUndefined();
    expect(initialTabContent(cached, { ...target, kind: 'file' }, true)).toBeUndefined();
  });

  it('reloads clean project files because entry capabilities do not version their contents', () => {
    const file: ProjectFile = { repositoryId: cached.repositoryId, path: cached.path, entryId: 'path-capability', state: 'text' };
    expect(initialTabContent(file, { ...target, kind: 'file' }, false)).toBeUndefined();
    expect(initialTabContent(file, { ...target, kind: 'file' }, true)).toBe(file);
    expect(verifiedComparisonContent(file, { ...target, kind: 'file', generation: 1 })).toBeUndefined();
  });
});
