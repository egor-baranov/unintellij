/** Rebuild the lazy TextMate catalog from the pinned grammar dependency. No network access. */
import { grammars, injections } from 'tm-grammars';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { LanguageDefinition } from '../apps/shared/languages/types';

const permitted = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC']);
// The package omits license metadata for these grammars. Preserve the exact
// upstream license text separately; YAML has a grammar-specific MIT exception.
const verified: Record<string, { file: string; url?: string; license?: string }> = {
  toml: { file: 'textmate-toml-license.txt' },
  sass: { file: 'textmate-sass-MIT.txt' },
  yaml: { file: 'textmate-yaml-MIT.txt', license: 'MIT', url: 'https://raw.githubusercontent.com/textmate/yaml.tmbundle/e54ceae3b719506dba7e481a77cea4a8b576ae46/Syntaxes/YAML-license.txt' },
};
const selected = [...grammars, ...injections].filter(item => permitted.has(item.license ?? '') || Object.hasOwn(verified, item.name));
const aliases: Record<string, Omit<LanguageDefinition, 'id'>> = {
  vue: { extensions: ['.vue'] }, make: { extensions: ['.mk', '.mak'], filenames: ['Makefile', 'GNUmakefile', 'BSDmakefile'], filenamePatterns: ['Makefile.*'] },
  groovy: { extensions: ['.groovy', '.gvy', '.gy', '.gsh', '.gradle'], filenames: ['Jenkinsfile'] },
  diff: { extensions: ['.diff', '.patch'] }, dotenv: { filenames: ['.env'], filenamePatterns: ['.env.*'] },
  fish: { extensions: ['.fish'] }, jsonc: { extensions: ['.jsonc'] }, jsonl: { extensions: ['.jsonl', '.ndjson'] },
  toml: { filenames: ['Cargo.lock', 'Pipfile', 'poetry.lock', 'uv.lock'] },
  'git-commit': { filenames: ['COMMIT_EDITMSG', 'MERGE_MSG'] }, 'git-rebase': { filenames: ['git-rebase-todo'] },
  codeowners: { filenames: ['CODEOWNERS'] }, cmake: { filenames: ['CMakeLists.txt', 'CMakeCache.txt'] },
  latex: { extensions: ['.latex'] }, tex: { extensions: ['.tex', '.sty', '.cls'] }, bibtex: { extensions: ['.bib'] },
  jinja: { extensions: ['.jinja', '.jinja2', '.j2'] }, 'objective-cpp': { extensions: ['.mm'] },
  hlsl: { extensions: ['.hlsl', '.fx', '.fxh'] }, shaderlab: { extensions: ['.shader'] },
  qml: { extensions: ['.qml'] }, qmldir: { filenames: ['qmldir'] }, qss: { extensions: ['.qss'] },
  gdresource: { extensions: ['.tres', '.tscn'], filenames: ['project.godot'] },
  nix: { extensions: ['.nix'] }, nushell: { extensions: ['.nu'] }, kdl: { extensions: ['.kdl'] },
  odin: { extensions: ['.odin'] }, fennel: { extensions: ['.fnl'] }, hy: { extensions: ['.hy'] },
  jsonnet: { extensions: ['.jsonnet', '.libsonnet'] }, prisma: { extensions: ['.prisma'] },
  typst: { extensions: ['.typ'] }, mermaid: { extensions: ['.mmd', '.mermaid'] },
  viml: { extensions: ['.vim'], filenames: ['.vimrc', '_vimrc', 'vimrc'] },
  raku: { extensions: ['.raku', '.rakumod', '.rakutest', '.p6', '.pm6'] }, rbs: { extensions: ['.rbs'] },
  wasm: { extensions: ['.wat', '.wast'] }, desktop: { extensions: ['.desktop'] },
  systemd: { extensions: ['.service', '.timer', '.socket', '.target', '.mount', '.automount', '.slice', '.path'] },
  berry: { extensions: ['.be'] }, cadence: { extensions: ['.cdc'] }, cairo: { extensions: ['.cairo'] },
  clarity: { extensions: ['.clar'] }, edge: { extensions: ['.edge'] }, fluent: { extensions: ['.ftl'] },
  'glimmer-js': { extensions: ['.gjs'] }, 'glimmer-ts': { extensions: ['.gts'] }, gn: { extensions: ['.gn', '.gni'] },
  lean: { extensions: ['.lean'] }, mojo: { extensions: ['.mojo'] }, move: { extensions: ['.move'] },
  narrat: { extensions: ['.nar'] }, nextflow: { extensions: ['.nf'] }, polar: { extensions: ['.polar'] },
  ron: { extensions: ['.ron'] }, talonscript: { extensions: ['.talon'] }, templ: { extensions: ['.templ'] },
  vyper: { extensions: ['.vy', '.vyi'] }, wenyan: { extensions: ['.wy'] }, wit: { extensions: ['.wit'] },
  wikitext: { extensions: ['.wiki', '.wikitext'] },
};
// TextMate's fileTypes mix extensions and literal filenames. Avoid claiming
// generic/binary suffixes present in a few upstream grammars (e.g. COBOL's src).
const excludedTypes = new Set(['elc', 'src', 'def', 'inc', 'tab', 'dump', 'log', 'txt', 'text', 'cls']);
const catalog = [];
for (const grammar of selected) {
  const bytes = await readFile(`node_modules/tm-grammars/grammars/${grammar.name}.json`);
  const raw = JSON.parse(bytes.toString()) as { fileTypes?: string[] };
  const extensions: string[] = [], filenames: string[] = [];
  for (const entry of raw.fileTypes ?? []) {
    if (excludedTypes.has(entry.replace(/^\./, '').toLowerCase())) continue;
    if (entry.includes('*') || entry.includes('/')) continue;
    if (/^[A-Z][A-Za-z]*file$/.test(entry) || /^(?:CMakeLists\.txt|Justfile|justfile|Rprofile|Project\.ede|Cask|Eask|Easkfile|_emacs|emacs\.desktop|abbrev_defs)$/.test(entry)) filenames.push(entry);
    else extensions.push(entry.startsWith('.') ? entry : `.${entry}`);
  }
  const extra = aliases[grammar.name];
  catalog.push({
    id: `textmate-${grammar.name}`, name: grammar.name, scopeName: grammar.scopeName, displayName: grammar.displayName,
    extensions: [...new Set([...extensions, ...(extra?.extensions ?? [])])],
    filenames: [...new Set([...filenames, ...(extra?.filenames ?? [])])],
    ...(extra?.filenamePatterns ? { filenamePatterns: extra.filenamePatterns } : {}),
    ...(grammar.embeddedIn ? { embeddedIn: grammar.embeddedIn } : {}),
  });
}
const banner = '// Generated by scripts/generate-extra-languages.ts from tm-grammars@1.32.22.\n';
await writeFile('apps/shared/languages/additionalCatalog.ts', `${banner}export const additionalCatalog = ${JSON.stringify(catalog, null, 2)} as const;\n`);
await writeFile('apps/shared/languages/grammarImports.ts', `${banner}export const grammarImports: Record<string, () => Promise<{ default: unknown }>> = {\n${selected.map(item => `  '${item.scopeName}': () => import('tm-grammars/grammars/${item.name}.json'),`).join('\n')}\n};\n`);
await writeFile('licenses/textmate-grammars-sources.json', JSON.stringify(await Promise.all(selected.map(async item => ({
  ...item, sha256: createHash('sha256').update(await readFile(`node_modules/tm-grammars/grammars/${item.name}.json`)).digest('hex'),
  ...(Object.hasOwn(verified, item.name) ? {
    verifiedLicenseFile: verified[item.name].file,
    ...(verified[item.name].url ? { verifiedLicenseUrl: verified[item.name].url } : {}),
    ...(verified[item.name].license ? { verifiedLicense: verified[item.name].license } : {}),
  } : {}),
}))), null, 2) + '\n');
console.log(`Generated ${catalog.length} lazy grammars (including embedded-language injections).`);
