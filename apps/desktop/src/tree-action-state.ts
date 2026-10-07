import type { TreeAction } from './bridge';

/** Paths whose unsaved buffers must not be staged, moved, or reused as a destination. */
export function treeActionNeedsSavedPath(target: { path: string; kind: string; paths?: string[] }, action: TreeAction, bufferPath: string): boolean {
  if (target.kind === 'change-group') return action.kind === 'add' && !!target.paths?.includes(bufferPath);
  const contains = (root: string, directory: boolean) => bufferPath === root || directory && (!root || bufferPath.startsWith(`${root}/`));
  if ((action.kind === 'add' || action.kind === 'rename') && contains(target.path, target.kind === 'directory')) return true;
  if ('name' in action) {
    const parent = action.kind !== 'rename' && target.kind === 'directory' ? target.path : target.path.split('/').slice(0, -1).join('/');
    const destination = parent ? `${parent}/${action.name}` : action.name;
    return contains(destination, action.kind === 'create-directory' || action.kind === 'rename' && target.kind === 'directory');
  }
  return false;
}
