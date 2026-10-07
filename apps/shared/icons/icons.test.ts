import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import manifest from './manifest.json';
import { iconUrls } from './assetUrls';
import { iconNameForPath } from './fileTypes';
import { applicationLanguageDefinitions } from '../languages/registry';

describe('vendored IntelliJ artwork', () => {
  it('retains exactly the recorded source bytes, licensing and a complete local registry', async () => {
    const names = Object.keys(manifest);
    expect(Object.keys(iconUrls).sort()).toEqual(names.sort());
    expect((await readdir(new URL('./assets/', import.meta.url))).sort()).toEqual(names.map(name => `${name}.svg`).sort());
    for (const [name, entry] of Object.entries(manifest)) {
      const contents = await readFile(new URL(`./assets/${name}.svg`, import.meta.url));
      expect(createHash('sha256').update(contents).digest('hex'), name).toBe(entry.sha256);
      expect(['Apache-2.0', 'MIT', 'NOASSERTION']).toContain(entry.license);
      const upstream = /^https:\/\/raw\.githubusercontent\.com\/(?:JetBrains\/(?:intellij-(?:community|plugins)|hirschgarten|Rplugin|resharper-fsharp)|intellij-rust\/intellij-rust|tomblachut\/svelte-intellij)\/[a-f\d]{40}\//;
      expect(upstream.test(entry.source) || entry.source.startsWith('https://intellij-icons.jetbrains.design/icons/'), name).toBe(true);
      expect(contents.toString()).toMatch(/<svg\s/);
      if (entry.license === 'NOASSERTION') {
        // These exact requested catalogue assets have no published license header.
        // Keep that uncertainty explicit rather than attributing Apache to all icons.
        expect(['file-go', 'file-go-test']).toContain(name);
        expect('licenseEvidence' in entry ? entry.licenseEvidence : '').toContain('No license header');
        expect(entry.source).toMatch(/^https:\/\/intellij-icons\.jetbrains\.design\/icons\/GoGeneratedIcons\/icons\/expui\/(go|runTest)_dark\.svg$/);
      } else if (!/<!--[^]*Apache 2\.0 license[^]*?-->/.test(contents.toString())) {
        expect('licenseSource' in entry ? entry.licenseSource : '', name).toMatch(upstream);
        expect('licenseSourceSha256' in entry ? entry.licenseSourceSha256 : '', name).toMatch(/^[a-f\d]{64}$/);
      }
      if ('licenseFile' in entry) {
        const license = await readFile(new URL(`../../../${entry.licenseFile}`, import.meta.url));
        expect(createHash('sha256').update(license).digest('hex'), name).toBe(entry.licenseSourceSha256);
      }
      expect(contents.toString(), name).not.toMatch(/<(script|foreignObject|image)\b|\bon\w+\s*=|\b(?:xlink:)?href\s*=/i);
    }
  });

  it('resolves files consistently across trees and editor headings, without interpreting paths as URLs', () => {
    const cases = {
      'apps/hello.ts': 'file-ts', 'src/types.d.ts': 'file-ts', 'src/主界面.tsx': 'file-tsx',
      'test.jsx': 'file-jsx', 'eslint.config.js': 'file-js', 'vite.config.mts': 'file-ts',
      'folder.with.dots/README.md': 'file-markdown', 'LICENSE': 'file', 'LICENSE.txt': 'file',
      'nested/.gitignore': 'file-gitignore', '.editorconfig': 'file-editorconfig',
      '.env.local': 'file-config', 'Dockerfile': 'file-docker', 'Dockerfile.dev': 'file-docker',
      'package-lock.json': 'file-json', 'checks.YML': 'file-yaml', 'theme.scss': 'file-css',
      'main.py': 'file-python', 'main.kt': 'file-kotlin', 'photo.PNG': 'file-image',
      'unknown.odd': 'file-unknown', 'a.ts?file=.json': 'file-json', 'no-extension': 'file-unknown',
    } as const;
    for (const [path, icon] of Object.entries(cases)) expect(iconNameForPath(path), path).toBe(icon);
  });

  it('recognizes language variants and exact build filenames before generic extensions', () => {
    const cases = {
      'cmd/server/MAIN.GO': 'file-go', 'module/go.mod': 'file-go-mod', 'go.sum': 'file-go-sum',
      'go.work': 'file-go-work', 'go.work.sum': 'file-go-sum', 'not-go.mod': 'file-unknown',
      'infrastructure/main.tf': 'file-terraform', 'prod.auto.tfvars': 'file-terraform',
      'main.tf.json': 'file-terraform', 'prod.auto.tfvars.json': 'file-terraform',
      'other.json': 'file-json', 'main.tf.json.backup': 'file-unknown',
      'terragrunt.hcl': 'file-terragrunt', 'terragrunt.hcl.json': 'file-terragrunt',
      'config.hcl': 'file-hcl', 'api/messages.proto': 'file-proto',
      'Python Files/MAIN.PY': 'file-python', 'windows.pyw': 'file-python', 'types.pyi': 'file-python',
      'extension.pyx': 'file-python', 'types.pxd': 'file-python', 'include.pxi': 'file-python',
      'compiled.pyc': 'file-binary', 'unknown.py.backup': 'file-unknown',
      'Gemfile': 'file-ruby', 'build.gradle.kts': 'file-gradle', 'main.kts': 'file-kotlin',
      'schema.schema.json': 'file-json-schema', 'changes.patch': 'file-patch', 'config.properties': 'file-properties',
      'api.http': 'file-http', 'font.woff2': 'file-font', 'data.csv': 'file-csv',
      'main.rs': 'file-rust', 'main.dart': 'file-dart', 'main.scala': 'file-scala',
      'App.vue': 'file-vue', 'App.svelte': 'file-svelte', 'service.rb': 'file-ruby', 'index.php': 'file-php',
      'file.constructor': 'file-unknown', 'file.__proto__': 'file-unknown', '__proto__': 'file-unknown',
      'go.mod/unknown': 'file-unknown', 'parent.py/unknown': 'file-unknown',
    } as const;
    for (const [path, icon] of Object.entries(cases)) expect(iconNameForPath(path), path).toBe(icon);
  });

  it('recognizes system, functional, data, document, template, and build file categories', () => {
    const cases = {
      'main.c': 'file', 'include/Vector.HPP': 'file', 'main.mm': 'file', 'main.swift': 'file', 'main.cs': 'file',
      'Program.fs': 'file-fsharp', 'model.fsi': 'file-fsharp-signature', 'build.fsx': 'file-fsharp-script',
      'analysis.R': 'file-r', 'report.Rmd': 'file-r-markdown', '.Rprofile': 'file-r',
      'query.graphql': 'file-graphql', 'schema.graphqls': 'file-graphql', 'schema.prisma': 'file-prisma',
      'app.pug': 'file-pug', 'template.hbs': 'file-handlebars', 'index.astro': 'file-astro', 'login.feature': 'file-gherkin',
      'init.ps1': 'file-shell', 'build.CMD': 'file-windows', '.bashrc': 'file-shell',
      'Makefile': 'file-config', 'GNUmakefile': 'file-config', 'Makefile.linux': 'file-config', 'CMakeLists.txt': 'file-config',
      'Containerfile.dev': 'file-docker', 'service.containerfile': 'file-docker', '.dockerignore': 'file-docker',
      'module.wasm': 'file-wasm', 'module.wat': 'file-wasm', 'lib.rlib': 'file-binary',
      'data.parquet': 'file-database', 'cache.sqlite3': 'file-database', 'report.pdf': 'file',
      'archive.zst': 'file-archive', 'recording.mov': 'play', 'artwork.TIFF': 'file-image',
      'project.csproj': 'file-xml', 'project.fsproj': 'file-xml', 'Settings.config': 'file-xml',
      'cargo.lock': 'file-toml', 'Pipfile.lock': 'file-json', 'composer.lock': 'file-json',
      'notebook.ipynb': 'file-json', 'report.mdown': 'file-markdown', 'index.html.erb': 'file-ruby',
      'unknown.CPP.backup': 'file-unknown', 'folder.ps1/no-extension': 'file-unknown',
    } as const;
    for (const [path, icon] of Object.entries(cases)) expect(iconNameForPath(path), path).toBe(icon);
  });

  it('assigns a known JetBrains file category to every bundled Monaco language extension', async () => {
    const directory = new URL('../../../node_modules/monaco-editor/esm/vs/basic-languages/', import.meta.url);
    const languages = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory());
    let extensionCount = 0;
    for (const language of languages) {
      const contribution = await readFile(new URL(`${language.name}/${language.name}.contribution.js`, directory), 'utf8');
      for (const group of contribution.matchAll(/extensions:\s*\[([^\]]*)\]/g)) {
        for (const match of group[1]!.matchAll(/["'](\.[^"']+)["']/g)) {
          const path = `example${match[1]}`;
          expect(iconNameForPath(path), `${language.name}: ${path}`).not.toBe('file-unknown');
          extensionCount++;
        }
      }
    }
    expect(extensionCount).toBeGreaterThan(150);
  });

  it('uses a licensed generic text icon for every other filename recognized by the syntax catalogue', () => {
    for (const definition of applicationLanguageDefinitions) {
      for (const extension of [...(definition.extensions ?? []), ...(definition.caseSensitiveExtensions ?? [])]) {
        expect(iconNameForPath(`example${extension}`), `${definition.id}: ${extension}`).not.toBe('file-unknown');
      }
      for (const name of definition.filenames ?? []) {
        expect(iconNameForPath(name), `${definition.id}: ${name}`).not.toBe('file-unknown');
      }
    }
  });

  it('uses the Go test overlay only for actual Go test filenames', () => {
    const cases = {
      'api/execution_http_test.go': 'file-go-test', '测试/名_test.go': 'file-go-test',
      'MixedCase_test.go': 'file-go-test', 'runtime.go': 'file-go',
      'runtime_test.GO': 'file-go', 'runtime_TEST.go': 'file-go',
      '.hidden_test.go': 'file-go', '_ignored_test.go': 'file-go',
      'a_test.go/runtime.go': 'file-go', 'runtime_test.go.backup': 'file-unknown',
    } as const;
    for (const [path, icon] of Object.entries(cases)) expect(iconNameForPath(path), path).toBe(icon);
  });

  it('uses the upstream Bazel icon for build definitions, extensions, and configuration files', () => {
    const cases = {
      'BUILD': 'file-bazel', 'nested/BUILD.bazel': 'file-bazel',
      'WORKSPACE': 'file-bazel', 'repo/WORKSPACE.bazel': 'file-bazel',
      'MODULE.bazel': 'file-bazel', 'modules/dependencies.bazel': 'file-bazel',
      'rules/defs.bzl': 'file-bazel', 'nested/.bazelrc': 'file-bazel', '.bazelversion': 'file-bazel',
      'MODULE.bazel.lock': 'file-config', 'BUILD.bazel.backup': 'file-unknown',
      'rules.bzl.txt': 'file', 'BUILD.bazel/unknown': 'file-unknown',
    } as const;
    for (const [path, icon] of Object.entries(cases)) expect(iconNameForPath(path), path).toBe(icon);
  });
});
