/** Bazel's extensionless entrypoints and Starlark sources, including MODULE fragments.
 * .bazelrc, .bazelversion, and MODULE.bazel.lock are not Starlark programs.
 */
export function isBazelSourceFile(path: string): boolean {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  return name === 'build' || name === 'workspace' || /\.(?:bazel|bzl)$/.test(name);
}
