import type { TreeNodeFacts, TreeScope } from './semantics';

/** Go recognizes the case-sensitive _test.go suffix and ignores source names
 * beginning with a dot or underscore. A containing directory is not a test root. */
export function isGoTestFile(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1) ?? '';
  return name.endsWith('_test.go') && !name.startsWith('.') && !name.startsWith('_');
}

/** A file-only scope; it does not alter inclusion, root roles, or Git state. */
export function goTestFileScope(path: string, kind: TreeNodeFacts['identity']['kind']): TreeScope | undefined {
  if (kind !== 'file' || !isGoTestFile(path)) return undefined;
  return {
    id: `go-test-file:${path}`, kind: 'test', rootPath: path,
    reason: { source: 'detection', description: 'Go test source (_test.go)', path },
  };
}
