import { describe, expect, it } from 'vitest';
import { isBazelSourceFile } from './bazel';

describe('Bazel source paths', () => {
  it.each(['BUILD', 'pkg/BUILD.bazel', 'WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel', 'modules/go.MODULE.bazel', 'rules/defs.bzl', 'C:\\repo\\BUILD', 'pkg/Build.Bazel'])('recognizes %s', path => {
    expect(isBazelSourceFile(path)).toBe(true);
  });
  it.each(['.bazelrc', '.bazelversion', 'MODULE.bazel.lock', 'BUILD.bazel.bak', 'build.sh', 'WORKSPACE.json', 'bazel/README.md', 'src/build.ts', 'defs.bzl.py'])('does not misclassify %s', path => {
    expect(isBazelSourceFile(path)).toBe(false);
  });
});
