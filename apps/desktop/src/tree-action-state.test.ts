import { describe, expect, it } from 'vitest';
import { treeActionNeedsSavedPath as needsSave } from './tree-action-state';

describe('tree actions with unsaved editors', () => {
  it('protects descendant drafts during folder Add and Rename without matching sibling prefixes', () => {
    for (const action of [{ kind: 'add' } as const, { kind: 'rename', name: 'new' } as const]) {
      expect(needsSave({ path: 'src/a', kind: 'directory' }, action, 'src/a/deep/file.ts')).toBe(true);
      expect(needsSave({ path: 'src/a', kind: 'directory' }, action, 'src/abc/file.ts')).toBe(false);
    }
    expect(needsSave({ path: '', kind: 'directory' }, { kind: 'add' }, 'src/file.ts')).toBe(true);
  });
  it('protects a dirty destination editor even when its file has disappeared from disk', () => {
    expect(needsSave({ path: 'src/old.ts', kind: 'file' }, { kind: 'rename', name: 'new.ts' }, 'src/new.ts')).toBe(true);
    expect(needsSave({ path: 'src/old', kind: 'directory' }, { kind: 'rename', name: 'new' }, 'src/new/file.ts')).toBe(true);
    expect(needsSave({ path: 'src/old', kind: 'directory' }, { kind: 'rename', name: 'new' }, 'src/newer/file.ts')).toBe(false);
  });
  it('protects new file destinations in a directory or beside a file', () => {
    expect(needsSave({ path: 'src', kind: 'directory' }, { kind: 'create-file', name: 'new.ts' }, 'src/new.ts')).toBe(true);
    expect(needsSave({ path: 'src/old.ts', kind: 'file' }, { kind: 'create-file', name: 'new.ts' }, 'src/new.ts')).toBe(true);
  });
  it('does not block untracking because local content stays intact', () => {
    expect(needsSave({ path: 'src', kind: 'directory' }, { kind: 'remove' }, 'src/file.ts')).toBe(false);
  });
  it('protects only captured group members when staging a change group', () => {
    const group = { kind: 'change-group', path: '', paths: ['src/a.ts', 'src/deep/b.ts'] };
    expect(needsSave(group, { kind: 'add' }, 'src/a.ts')).toBe(true);
    expect(needsSave(group, { kind: 'add' }, 'src/deep/b.ts')).toBe(true);
    expect(needsSave(group, { kind: 'add' }, 'src/another.ts')).toBe(false);
    expect(needsSave(group, { kind: 'add' }, 'src/a.ts/child')).toBe(false);
    expect(needsSave(group, { kind: 'remove' }, 'src/a.ts')).toBe(false);
  });
});
