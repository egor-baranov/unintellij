export interface Fixture { id: string; name: string; path: string; original: string; modified: string; description: string }
const sharedLines = (count: number) => Array.from({ length: count }, (_, i) => `const item${i + 1} = ${i + 1};`);
const context = sharedLines(240);
const large = sharedLines(20_000);
const changedLarge = large.map((line, i) => i % 67 === 0 ? line.replace('const', 'export const').replace(';', ' * 2;') : line);
const tsx = `import { useMemo } from 'react';\n\ninterface FileItem {\n  path: string;\n  status: string;\n}\n\nexport function ChangedFiles({ files }: { files: FileItem[] }) {\n  const visibleFiles = useMemo(() => files, [files]);\n\n  function selectFile(file: FileItem) {\n    console.log(file.path);\n  }\n\n  return (\n    <section className="changed-files">\n      <header>Working tree</header>\n      <ul>\n        {visibleFiles.map((file) => (\n          <li key={file.path}>\n            <button onClick={() => selectFile(file)}>\n              <span>{file.path}</span>\n            </button>\n          </li>\n        ))}\n      </ul>\n    </section>\n  );\n}\n`;
const goSource = [
  'package api',
  '',
  'import "fmt"',
  '',
  '// Runtime reports the current worker state.',
  'func Runtime() int {',
  '    fmt.Println("ready")',
  '    return 1',
  '}',
  '',
  '/* A comment that spans',
  '   multiple source lines. */',
  'const schema = `{"kind": "worker",',
  '    "enabled": true}`',
  '',
].join('\n');
export const fixtures: Fixture[] = [
  referenceFixture,
  ...oneSidedFixtures,
  ...omissionFixtures,
  terraformFixture,
  bazelFixture,
  ...languageFixtures,
  { id: 'go', name: 'Go source', path: 'api/runtime.go', original: goSource, modified: goSource.replace('return 1', 'return 2').replace('"ready"', '"running"'), description: 'Go keywords, comments, strings, raw strings, and numbers use the shared host tokenizer in both panes.' },
  { id: 'json', name: 'JSON configuration', path: 'config/settings.json', original: '{\n  "name": "demo",\n  "enabled": false,\n  "count": 12,\n  "fallback": null,\n  "items": ["one", 2]\n}\n', modified: '{\n  "name": "demo",\n  "enabled": true,\n  "count": 42,\n  "fallback": null,\n  "items": ["one", 2, "three"]\n}\n', description: 'JSON keys, values, constants, and numbers in both comparison panes.' },
  { id: 'tsx', name: 'TSX component', path: 'src/ChangedFiles.tsx', original: tsx, modified: tsx.replace('useMemo', 'useMemo, useState').replace('const visibleFiles = useMemo(() => files, [files]);', 'const [filter, setFilter] = useState(\'\');\n  const visibleFiles = useMemo(\n    () => files.filter((file) => file.path.includes(filter)),\n    [files, filter],\n  );').replace('console.log(file.path);', 'window.dispatchEvent(new CustomEvent(\'select-file\', { detail: file }));').replace('<header>Working tree</header>', '<header>Local changes</header>\n      <input aria-label="Filter files" value={filter}\n        onChange={(event) => setFilter(event.target.value)} />').replace('<span>{file.path}</span>', '<span className="file-status">{file.status}</span>\n              <span>{file.path}</span>'), description: 'Unequal TSX edits with precise inline highlights.' },
  { id: 'insertion', name: 'Large insertion', path: 'src/insertion.ts', original: context.join('\n'), modified: [...context.slice(0, 90), ...Array.from({ length: 150 }, (_, i) => `// inserted line ${i + 1}`), ...context.slice(90)].join('\n'), description: '150 inserted lines between matching sections; scroll from either pane.' },
  { id: 'replacement', name: '1 → 50 replacement', path: 'src/replacement.ts', original: [...context.slice(0, 70), 'const oldValue = true;', ...context.slice(70)].join('\n'), modified: [...context.slice(0, 70), ...sharedLines(50).map(line => line.replace('item', 'replacement')), ...context.slice(70)].join('\n'), description: 'One line replaced by fifty, with corresponding unchanged anchors.' },
  { id: 'folds', name: 'Long unchanged regions', path: 'src/collapsing.ts', original: context.join('\n'), modified: context.map((line, i) => [4, 110, 233].includes(i) ? line.replace(';', ' + 10;') : line).join('\n'), description: 'Coordinated omission separators retain context around three changes.' },
  { id: 'added', name: 'Added file', path: 'src/added.ts', original: '', modified: 'export const greeting = "Hello, world";\n\nexport function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n', description: 'An empty original document maps to the insertion boundary.' },
  { id: 'deleted', name: 'Deleted file', path: 'src/deleted.ts', original: 'export const obsolete = true;\n\nexport function oldFeature() {\n  return obsolete;\n}\n', modified: '', description: 'Deletion connects a full range to an empty document.' },
  { id: 'empty', name: 'Empty / identical', path: 'src/empty.ts', original: '', modified: '', description: 'Two empty documents; no differences.' },
  { id: 'boundaries', name: 'Start / end insertions', path: 'src/boundaries.ts', original: context.slice(0, 35).join('\n'), modified: ['// inserted at start', ...context.slice(0, 35), '// inserted at end'].join('\n'), description: 'Insertions at both document boundaries.' },
  { id: 'nearby', name: 'Many nearby changes', path: 'src/nearby.ts', original: context.join('\n'), modified: context.map((line, i) => i % 4 === 1 ? line.replace(';', ' * 2;') : line).join('\n'), description: 'Many small changes separated by short unchanged runs.' },
  { id: 'wrapping', name: 'Long lines / wrapping', path: 'src/wrapping.ts', original: context.slice(0, 80).map((line, i) => i % 6 === 0 ? `// ${'original long content '.repeat(20)}\n${line}` : line).join('\n'), modified: context.slice(0, 80).map((line, i) => i % 6 === 0 ? `// ${'modified wrapping content '.repeat(34)}\n${line}` : line).join('\n'), description: 'Enable wrapping and resize to exercise rendered line geometry.' },
  { id: 'whitespace', name: 'Whitespace only', path: 'src/whitespace.ts', original: 'function example() {\n  const message = "unchanged";\n  return message;\n}\n', modified: 'function example() {  \n    const message = "unchanged";\n    return message;\n}\n', description: 'Ignoring trim whitespace preserves the original displayed source.' },
  { id: 'crlf', name: 'Line endings / EOF', path: 'src/newlines.ts', original: 'const a = 1;\r\nconst b = 2;\r\n', modified: 'const a = 1;\nconst b = 2;', description: 'CRLF → LF and a removed final newline. Monaco normalizes line endings.' },
  { id: 'unicode', name: 'Unicode text', path: 'src/unicode.ts', original: 'const greeting = "こんにちは 🌍";\nconst café = "naïve";\nconst direction = "مرحبا";\n', modified: 'const greeting = "こんばんは 🌎";\nconst café = "élève";\nconst direction = "أهلاً";\n', description: 'Unicode changes, including surrogate pairs and right-to-left text.' },
  { id: 'reordered', name: 'Reordered functions', path: 'src/reordered.ts', original: 'function first() {\n  return 1;\n}\n\nfunction second() {\n  return 2;\n}\n', modified: 'function second() {\n  return 2;\n}\n\nfunction first() {\n  return 1;\n}\n', description: 'Reordering remains an ordinary monotonic diff; moved blocks are not scroll anchors.' },
  { id: 'large', name: '20,000 lines · 299 changes', path: 'src/performance.ts', original: large.join('\n'), modified: changedLarge.join('\n'), description: 'Reproducible performance fixture: 20,000 lines with an edit every 67 lines.' },
];
import { referenceFixture } from './reference-fixture';
import { oneSidedFixtures } from './one-sided-fixtures';
import { omissionFixtures } from './omission-fixtures';
import { terraformFixture } from './terraform-fixture';
import { bazelFixture } from './bazel-fixture';
import { languageFixtures } from './language-fixtures';
