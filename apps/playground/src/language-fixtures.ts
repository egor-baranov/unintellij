import type { Fixture } from './fixtures';
import { helmYaml, plainYaml } from './yaml-fixture';

export interface LanguageSyntaxSample {
  key: string;
  name: string;
  path: string;
  language: string;
  source: string;
  probes: { text: string; token: 'keyword' | 'string' | 'comment' | 'number' | 'tag' | 'type' }[];
}

/** Small real programs shared by the file browser, diff fixtures, and syntax tests. */
export const languageSyntaxSamples: LanguageSyntaxSample[] = [
  { key: 'yaml', name: 'YAML', path: 'languages/Chart.yaml', language: 'yaml', source: plainYaml, probes: [{ text: 'Chart configuration', token: 'comment' }, { text: 'apiVersion', token: 'type' }, { text: '1.0.0', token: 'string' }, { text: 'true', token: 'keyword' }] },
  { key: 'helm-yaml', name: 'Helm YAML', path: 'languages/chart/templates/check.yaml', language: 'yaml', source: helmYaml, probes: [{ text: 'if', token: 'keyword' }, { text: 'fail', token: 'type' }, { text: 'identity', token: 'string' }, { text: 'apiVersion', token: 'type' }, { text: 'true', token: 'keyword' }] },
  { key: 'c', name: 'C', path: 'languages/main.c', language: 'c', source: '// C sample\nint main(void) { return 42; }\n', probes: [{ text: 'return', token: 'keyword' }, { text: '42', token: 'number' }] },
  { key: 'cpp', name: 'C++', path: 'languages/main.cpp', language: 'cpp', source: '// C++ sample\nclass Worker { public: int count = 42; };\n', probes: [{ text: 'class', token: 'keyword' }, { text: '42', token: 'number' }] },
  { key: 'csharp', name: 'C#', path: 'languages/Worker.cs', language: 'csharp', source: '// C# sample\npublic class Worker { string message = "ready"; }\n', probes: [{ text: 'public', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'java', name: 'Java', path: 'languages/Worker.java', language: 'java', source: '// Java sample\npublic class Worker { String message = "ready"; }\n', probes: [{ text: 'public', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'kotlin', name: 'Kotlin', path: 'languages/Main.kt', language: 'kotlin', source: '// Kotlin sample\nfun main() { val message = "ready" }\n', probes: [{ text: 'fun', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'sql', name: 'SQL', path: 'languages/query.sql', language: 'sql', source: '-- SQL sample\nSELECT name FROM workers WHERE state = \'ready\';\n', probes: [{ text: 'SELECT', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'protobuf', name: 'Protocol Buffers', path: 'languages/service.proto', language: 'proto', source: 'syntax = "proto3";\n// Protocol Buffers sample\nmessage Worker { string name = 42; }\n', probes: [{ text: 'Protocol Buffers sample', token: 'comment' }, { text: 'proto3', token: 'string' }] },
  { key: 'xml', name: 'XML', path: 'languages/settings.xml', language: 'xml', source: '<!-- XML sample -->\n<worker status="ready">42</worker>\n', probes: [{ text: 'XML sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'rust', name: 'Rust', path: 'languages/main.rs', language: 'rust', source: '// Rust sample\nfn main() { let message = "ready"; }\n', probes: [{ text: 'fn', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'swift', name: 'Swift', path: 'languages/main.swift', language: 'swift', source: '// Swift sample\nlet message = "ready"\nfunc run() { print(message) }\n', probes: [{ text: 'let', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'lua', name: 'Lua', path: 'languages/main.lua', language: 'lua', source: '-- Lua sample\nlocal message = "ready"\nreturn message\n', probes: [{ text: 'local', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'powershell', name: 'PowerShell', path: 'languages/build.ps1', language: 'powershell', source: '# PowerShell sample\nfunction Build { $message = "ready"; return $message }\n', probes: [{ text: 'function', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'scss', name: 'SCSS', path: 'languages/styles.scss', language: 'scss', source: '// SCSS sample\n$accent: #aabbcc;\n.card::after { content: "ready"; color: $accent; }\n', probes: [{ text: 'SCSS sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'less', name: 'Less', path: 'languages/styles.less', language: 'less', source: '// Less sample\n@accent: #aabbcc;\n.card::after { content: "ready"; color: @accent; }\n', probes: [{ text: 'Less sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'dart', name: 'Dart', path: 'languages/main.dart', language: 'dart', source: '// Dart sample\nvoid main() { final message = "ready"; }\n', probes: [{ text: 'final', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'ruby', name: 'Ruby', path: 'languages/main.rb', language: 'ruby', source: '# Ruby sample\ndef run\n  message = "ready"\nend\n', probes: [{ text: 'def', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'php', name: 'PHP', path: 'languages/index.php', language: 'php', source: '<?php\n// PHP sample\nfunction run() { return "ready"; }\n', probes: [{ text: 'function', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'scala', name: 'Scala', path: 'languages/Main.scala', language: 'scala', source: '// Scala sample\nobject Main { val message = "ready" }\n', probes: [{ text: 'object', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'r', name: 'R', path: 'languages/main.r', language: 'r', source: '# R sample\nmessage <- "ready"\ncount <- 42\n', probes: [{ text: 'R sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'perl', name: 'Perl', path: 'languages/main.pl', language: 'perl', source: '# Perl sample\nmy $message = "ready";\nprint $message;\n', probes: [{ text: 'Perl sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'dockerfile', name: 'Dockerfile', path: 'languages/Dockerfile.production', language: 'dockerfile', source: '# Docker sample\nFROM node:22\nENV MESSAGE="ready"\n', probes: [{ text: 'Docker sample', token: 'comment' }, { text: 'FROM', token: 'keyword' }] },
  { key: 'mdx', name: 'MDX', path: 'languages/components.mdx', language: 'mdx', source: 'import Panel from "./Panel";\n\n# Review\n\n<Panel title="ready" />\n', probes: [{ text: 'import', token: 'keyword' }, { text: './Panel', token: 'string' }] },
  { key: 'vue', name: 'Vue', path: 'languages/Worker.vue', language: 'textmate-vue', source: '<script setup lang="ts">\nconst message = "ready";\n</script>\n<template><h1>{{ message }}</h1></template>\n', probes: [{ text: 'const', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'svelte', name: 'Svelte', path: 'languages/Worker.svelte', language: 'textmate-svelte', source: '<script lang="ts">\nconst message = "ready";\n</script>\n<h1>{message}</h1>\n', probes: [{ text: 'const', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'toml', name: 'TOML', path: 'languages/Cargo.toml', language: 'textmate-toml', source: '# TOML sample\n[package]\nname = "ready"\nversion = "1.0.0"\n', probes: [{ text: 'TOML sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'make', name: 'Makefile', path: 'languages/Makefile', language: 'textmate-make', source: '# Make sample\nMESSAGE := ready\nbuild:\n\t@echo $(MESSAGE)\n', probes: [{ text: 'Make sample', token: 'comment' }, { text: 'build', token: 'type' }] },
  { key: 'cmake', name: 'CMake', path: 'languages/CMakeLists.txt', language: 'textmate-cmake', source: '# CMake sample\ncmake_minimum_required(VERSION 3.20)\nproject(Review)\nset(MESSAGE "ready")\n', probes: [{ text: 'CMake sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'groovy', name: 'Groovy', path: 'languages/build.gradle', language: 'textmate-groovy', source: '// Groovy sample\nclass Worker { String message = "ready" }\n', probes: [{ text: 'class', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'json5', name: 'JSON5', path: 'languages/settings.json5', language: 'textmate-json5', source: '// JSON5 sample\n{ message: \'ready\', count: 42, }\n', probes: [{ text: 'JSON5 sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'diff', name: 'Unified diff', path: 'languages/changes.patch', language: 'textmate-diff', source: '--- a/message.txt\n+++ b/message.txt\n@@ -1 +1 @@\n-old value\n+ready\n', probes: [{ text: 'old value', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'sass', name: 'Sass', path: 'languages/styles.sass', language: 'textmate-sass', source: '// Sass sample\n$accent: #aabbcc\n.card\n  content: "ready"\n  color: $accent\n', probes: [{ text: 'Sass sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'fish', name: 'Fish shell', path: 'languages/build.fish', language: 'textmate-fish', source: '# Fish sample\nfunction greet\n  echo "ready"\nend\n', probes: [{ text: 'function', token: 'keyword' }, { text: 'ready', token: 'string' }] },
  { key: 'haskell', name: 'Haskell', path: 'languages/Main.hs', language: 'textmate-haskell', source: '-- Haskell sample\nmodule Main where\nmessage = "ready"\n', probes: [{ text: 'Haskell sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'erlang', name: 'Erlang', path: 'languages/main.erl', language: 'textmate-erlang', source: '% Erlang sample\n-module(main).\nrun() -> "ready".\n', probes: [{ text: 'Erlang sample', token: 'comment' }, { text: 'ready', token: 'string' }] },
  { key: 'prisma', name: 'Prisma', path: 'languages/schema.prisma', language: 'textmate-prisma', source: '// Prisma sample\ndatasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\nmodel Worker {\n  id Int @id\n}\n', probes: [{ text: 'Prisma sample', token: 'comment' }, { text: 'postgresql', token: 'string' }] },
  { key: 'astro', name: 'Astro', path: 'languages/index.astro', language: 'textmate-astro', source: '---\nconst message = "ready";\n---\n<h1>{message}</h1>\n', probes: [{ text: 'const', token: 'keyword' }, { text: 'ready', token: 'string' }] },
];

export const languageFixtures: Fixture[] = languageSyntaxSamples.map(sample => ({
  id: `language-${sample.key}`,
  name: `${sample.name} syntax`,
  path: sample.path,
  original: sample.source,
  modified: sample.source.includes('ready')
    ? sample.source.replace('ready', 'running')
    : sample.source.includes('42') ? sample.source.replace('42', '43') : sample.source.replace('sample', 'review sample'),
  description: `${sample.name} highlighting in both comparison panes, including lazy grammar loading and ordinary edits.`,
}));
