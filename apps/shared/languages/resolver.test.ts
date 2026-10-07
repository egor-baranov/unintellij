import { describe, expect, it } from 'vitest';
import { applicationLanguageDefinitions, monacoLanguageDefinitions } from './registry';
import { createLanguageResolver } from './resolver';

const resolve = createLanguageResolver(applicationLanguageDefinitions);

describe('language filename resolution', () => {
  it.each([
    ['src/view.tsx', 'smart-diff-tsx'], ['src/view.jsx', 'smart-diff-tsx'],
    ['index.ts', 'typescript'], ['index.mts', 'typescript'], ['index.cts', 'typescript'],
    ['index.js', 'javascript'], ['index.mjs', 'javascript'], ['index.cjs', 'javascript'],
    ['style.scss', 'scss'], ['style.less', 'less'], ['style.css', 'css'],
    ['main.c', 'c'], ['main.C', 'cpp'], ['main.h', 'c'], ['main.H', 'cpp'],
    ['main.cc', 'cpp'], ['main.c++', 'cpp'], ['main.mm', 'objective-c'],
    ['Cargo.rs', 'rust'], ['App.java', 'java'], ['Main.kt', 'kotlin'],
    ['Controller.cs', 'csharp'], ['main.swift', 'swift'], ['main.go', 'go'],
    ['index.php', 'php'], ['mix.exs', 'elixir'], ['main.pl', 'perl'],
    ['main.lua', 'lua'], ['Main.scala', 'scala'], ['main.pas', 'pascal'],
    ['main.pp', 'pascal'], ['queries.graphql', 'graphql'], ['messages.proto', 'proto'],
    ['README.md', 'markdown'], ['components.mdx', 'mdx'], ['guide.rst', 'restructuredtext'],
    ['config.yaml', 'yaml'], ['config.yml', 'yaml'], ['pom.xml', 'xml'],
    ['Dockerfile', 'dockerfile'], ['dockerfile', 'dockerfile'], ['Dockerfile.production', 'dockerfile'],
    ['Containerfile', 'dockerfile'], ['Containerfile.dev', 'dockerfile'], ['dev.dockerfile', 'dockerfile'],
    ['Gemfile', 'ruby'], ['Rakefile', 'ruby'], ['Vagrantfile', 'ruby'],
    ['.bashrc', 'shell'], ['.zshrc', 'shell'], ['deploy.zsh', 'shell'],
    ['C:\\repo\\scripts\\build.ps1', 'powershell'], ['C:\\repo\\App.TSX', 'smart-diff-tsx'],
    ['BUILD', 'starlark'], ['WORKSPACE', 'starlark'], ['MODULE.bazel', 'starlark'],
    ['BUILD.bazel', 'starlark'], ['rules.bzl', 'starlark'], ['MODULE.bazel.lock', 'json'],
    ['main.tf', 'hcl'], ['production.tfvars', 'hcl'], ['.terraform.lock.hcl', 'hcl'],
    ['main.tf.json', 'json'], ['production.tfvars.json', 'json'], ['terraform.tfstate.backup', 'json'],
    ['tsconfig.json', 'json'], ['settings.jsonc', 'json'], ['notebook.ipynb', 'json'],
    ['.editorconfig', 'ini'], ['.gitconfig', 'ini'], ['local.properties', 'ini'],
  ])('%s uses %s', (path, language) => {
    expect(resolve(path)).toBe(language);
  });

  it('covers all Monaco metadata except explicit custom, ambiguous, and binary overrides', () => {
    const extensionOverrides: Record<string, string> = { '.tsx': 'smart-diff-tsx', '.jsx': 'smart-diff-tsx', '.pp': 'pascal', '.svgz': 'plaintext' };
    const filenameOverrides: Record<string, string> = { config: 'plaintext', '.gitattributes': 'plaintext' };
    for (const definition of monacoLanguageDefinitions) {
      for (const extension of definition.extensions ?? []) {
        expect(resolve(`example${extension}`), extension).toBe(extensionOverrides[extension] ?? definition.id);
      }
      for (const filename of definition.filenames ?? []) {
        expect(resolve(filename), filename).toBe(filenameOverrides[filename] ?? definition.id);
      }
    }
  });

  it('prefers exact filenames and longest suffixes, preserving earlier providers on collisions', () => {
    const custom = createLanguageResolver([
      { id: 'exact', filenames: ['settings.theme.ts'] },
      { id: 'compound', extensions: ['.theme.ts'] },
      { id: 'typescript', extensions: ['.ts'] },
      { id: 'second', extensions: ['.ts'] },
    ]);
    expect(custom('settings.theme.ts')).toBe('exact');
    expect(custom('other.theme.ts')).toBe('compound');
    expect(custom('other.ts')).toBe('typescript');
    expect(custom('settings.theme.ts/different')).toBe('plaintext');
  });

  it.each(['', 'folder/', 'README', 'LICENSE', 'notes.txt', 'data.csv', 'image.png', 'font.woff2', 'archive.zip', 'icon.svgz', 'program.unknown', '.bazelrc', '.bazelversion', 'config'])('%s falls back to plain text', (path) => {
    expect(resolve(path)).toBe('plaintext');
  });

  it('does not invent grammars absent from the supplied registry', () => {
    for (const path of ['Makefile', 'GNUmakefile', 'styles.sass', 'deploy.fish', 'settings.json5', 'Cargo.toml']) {
      expect(resolve(path)).toBe('plaintext');
    }
  });

  it.each([
    ['#!/usr/bin/env python3', 'python'], ['#!/usr/bin/python3.12 -u', 'python'],
    ['#!/usr/bin/env -S node --experimental-strip-types', 'javascript'],
    ['#!/bin/bash', 'shell'], ['#!/usr/bin/env zsh', 'shell'],
    ['#!/usr/bin/env ruby', 'ruby'], ['#!/usr/bin/perl', 'perl'],
    ['#!/usr/bin/env pwsh', 'powershell'],
  ])('uses optional first-line information: %s', (line, language) => {
    expect(resolve('scripts/launch', line)).toBe(language);
  });

  it('keeps filename evidence and explicit plaintext/binary suffixes ahead of content', () => {
    expect(resolve('main.ts', '#!/usr/bin/python3')).toBe('typescript');
    expect(resolve('notes.txt', '#!/usr/bin/python3')).toBe('plaintext');
    expect(resolve('image.png', '#!/usr/bin/python3')).toBe('plaintext');
    expect(resolve('scripts/run', '#!/usr/bin/python3\0')).toBe('plaintext');
    expect(resolve('scripts/run', 'some text\n#!/usr/bin/python3')).toBe('plaintext');
  });
});
