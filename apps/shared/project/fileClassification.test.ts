import { describe, expect, it } from 'vitest';
import { goTestFileScope, isGoTestFile } from './fileClassification';

describe('Go test file convention', () => {
  it('recognizes the basename without treating folders or ordinary Go files as tests', () => {
    for (const file of ['runtime_test.go', 'pkg/Runtime_test.go', 'pkg\\runtime_test.go', 'pkg/运行_test.go', 'pkg/runtime_linux_test.go']) {
      expect(isGoTestFile(file), file).toBe(true);
    }
    for (const file of ['runtime.go', 'test.go', 'runtime_test.go.txt', 'runtime_test.go/implementation.go', 'runtime_test.go/', 'runtime_TEST.go', 'runtime_test.GO', '_runtime_test.go', '.runtime_test.go', '_test.go', '']) {
      expect(isGoTestFile(file), file).toBe(false);
    }
  });

  it('classifies only real files with an explainable file-local scope', () => {
    const scope = goTestFileScope('pkg/runtime_test.go', 'file');
    expect(scope).toMatchObject({ kind: 'test', rootPath: 'pkg/runtime_test.go', reason: { source: 'detection', path: 'pkg/runtime_test.go' } });
    for (const kind of ['directory', 'symlink', 'submodule', 'unavailable'] as const) expect(goTestFileScope('pkg/runtime_test.go', kind)).toBeUndefined();
  });
});
