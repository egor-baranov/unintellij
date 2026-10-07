import type { Fixture } from './fixtures';

export const bazelSource = `# Bazel library and test targets
load("@rules_go//go:def.bzl", "go_library", "go_test")

go_library(
    name = "controlplane",
    srcs = glob(["*.go"], exclude = ["*_test.go"]),
    importpath = "example.com/controlplane",
    visibility = ["//visibility:public"],
    deps = ["//internal/config"],
)

go_test(
    name = "controlplane_test",
    srcs = ["execution_test.go"],
    embed = [":controlplane"],
    shard_count = 1,
    flaky = False,
)
`;

export const bazelMacro = `"""Shared build macros.
Loads targets without executing any project code in the editor.
"""
load("@rules_go//go:def.bzl", "go_library")

def service_library(name, srcs = None):
    """Declare a service library."""
    sources = srcs if srcs != None else glob(["*.go"])
    labels = [":" + file for file in sources if not file.endswith("_test.go")]
    pattern = r"\\w+\\.go" # A raw string with an inline comment
    go_library(name = name, srcs = sources, deps = labels)
`;

export const bazelFixture: Fixture = {
  id: 'bazel', name: 'Bazel build targets', path: 'controlplane/BUILD.bazel',
  original: bazelSource, modified: bazelSource.replace('shard_count = 1', 'shard_count = 2').replace('flaky = False', 'flaky = True'),
  description: 'Starlark loads, rules, attributes, strings, constants, and comments use shared syntax colors.',
};
