export interface ChangeFile {
  id: string;
  path: string;
  status: string;
  group: 'working' | 'staged' | 'unstaged' | 'untracked';
  oldPath?: string;
  unsupported?: string;
}

export interface ChangeNode {
  id: string;
  label: string;
  kind: 'group' | 'folder' | 'file';
  children: ChangeNode[];
  fileIds: string[];
  file?: ChangeFile;
  parentId?: string;
}
export interface VisibleNode { node: ChangeNode; depth: number; position: number; siblings: number }

/** IPC IDs are snapshot-scoped; a local review selection follows its comparison across refreshes. */
export function reviewKey(file: Pick<ChangeFile, 'group' | 'path'>): string {
  return JSON.stringify([file.group, file.path]);
}

/** Carry existing per-index review choices into the unified whole-file row. */
export function isReviewed(file: Pick<ChangeFile, 'group' | 'path'>, selected: ReadonlySet<string>): boolean {
  return selected.has(reviewKey(file)) || file.group === 'working' &&
    (selected.has(reviewKey({ ...file, group: 'staged' })) || selected.has(reviewKey({ ...file, group: 'unstaged' })));
}

function branch(id: string, label: string, kind: 'folder' | 'group', parentId?: string): ChangeNode {
  return { id, label, kind, children: [], fileIds: [], parentId };
}

function appendFiles(parent: ChangeNode, files: ChangeFile[]): void {
  for (const file of files) {
    let directory = parent;
    directory.fileIds.push(file.id);
    const parts = file.path.split('/');
    const name = parts.pop() ?? file.path;
    let path = '';
    for (const part of parts) {
      path += `/${part}`;
      const id = `${parent.id}:directory:${path}`;
      let child = directory.children.find(candidate => candidate.id === id);
      if (!child) {
        child = branch(id, part, 'folder', directory.id);
        directory.children.push(child);
      }
      child.fileIds.push(file.id);
      directory = child;
    }
    directory.children.push({ id: `file:${file.id}`, label: name, kind: 'file', children: [], fileIds: [file.id], file, parentId: directory.id });
  }
  const sort = (node: ChangeNode) => {
    node.children.sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    node.children.forEach(sort);
  };
  sort(parent);
}

/** Tracked files share one folder hierarchy, regardless of their index state. */
export function buildChangeTree(files: ChangeFile[]): ChangeNode[] {
  const roots: ChangeNode[] = [];
  const tracked = files.filter(file => file.group !== 'untracked');
  if (tracked.length) {
    const changes = branch('group:changes', 'Changes', 'group');
    appendFiles(changes, tracked);
    roots.push(changes);
  }
  const untracked = files.filter(file => file.group === 'untracked');
  if (untracked.length) {
    const group = branch('group:untracked', 'Unversioned Files', 'group');
    appendFiles(group, untracked);
    roots.push(group);
  }
  return roots;
}

export function flattenTree(roots: ChangeNode[], expanded?: ReadonlySet<string>, depth = 0): VisibleNode[] {
  return roots.flatMap((node, index) => [
    { node, depth, position: index + 1, siblings: roots.length },
    ...(node.children.length && (!expanded || expanded.has(node.id)) ? flattenTree(node.children, expanded, depth + 1) : []),
  ]);
}

export function checkState(fileIds: readonly string[], selected: ReadonlySet<string>): 'false' | 'true' | 'mixed' {
  const count = fileIds.filter(id => selected.has(id)).length;
  return count === 0 ? 'false' : count === fileIds.length ? 'true' : 'mixed';
}

export function toggleSelection(fileIds: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  const remove = checkState(fileIds, selected) === 'true';
  fileIds.forEach(id => remove ? next.delete(id) : next.add(id));
  return next;
}

export function ancestorIds(roots: ChangeNode[], id: string): string[] {
  for (const root of roots) {
    if (root.id === id) return [];
    if (flattenTree(root.children).some(item => item.node.id === id)) return [root.id, ...ancestorIds(root.children, id)];
  }
  return [];
}

export function reviewSummary(files: ChangeFile[], selected: ReadonlySet<string>, draft: string): string {
  const groups = ['working', 'staged', 'unstaged', 'untracked'] as const;
  return [draft.trim(), ...groups.flatMap(group => {
    const members = files.filter(file => file.group === group && selected.has(file.id));
    return members.length ? [`${group === 'working' ? 'Changes' : `${group[0].toUpperCase()}${group.slice(1)}`} (${members.length})\n${members.map(file => `  ${file.status} ${JSON.stringify(file.path)}${file.oldPath ? ` ← ${JSON.stringify(file.oldPath)}` : ''}`).join('\n')}`] : [];
  })].filter(Boolean).join('\n\n');
}
