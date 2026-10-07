import type { ProjectDirectory, ProjectEntry, ProjectFile, ComparisonSide } from '../../desktop/src/bridge';
import { commitFiles } from './commit-fixtures';
import type { MediaContent } from '../../shared/media/types';
import { bazelMacro, bazelSource } from './bazel-fixture';
import { languageFixtures } from './language-fixtures';
import { markdownPreview } from './markdown-fixture';
import { passiveSvg } from './media-fixtures';

const repositoryId = 'preview-project';
export const projectRepository = { id: repositoryId, name: 'unintellij-example', path: '~/Projects/unintellij-example' };
interface PreviewSource { text?: string; media?: MediaContent; state?: ProjectFile['state']; message?: string; kind?: ProjectEntry['kind']; status?: string }
const sources = new Map<string, PreviewSource>();
// A staged snapshot of a path is superseded by its working-tree version, exactly
// as in Project mode in the desktop host. Deleted files do not exist in the tree.
for (const file of [...commitFiles].sort((a, b) => Number(a.group === 'unstaged') - Number(b.group === 'unstaged'))) {
  if (file.status === 'D') continue;
  sources.set(file.path, { text: file.modified, media: file.modifiedMedia, state: file.modifiedMedia ? 'media' : file.unsupported ? 'binary' : 'text', message: file.message, status: file.status });
}
const unchanged: Record<string, string> = {
  'file-types/BUILD': bazelSource,
  'file-types/BUILD.bazel': bazelSource,
  'file-types/WORKSPACE': 'workspace(name = "sample")\n',
  'file-types/WORKSPACE.bazel': 'workspace(name = "sample")\n',
  'file-types/MODULE.bazel': 'module(name = "sample", version = "1.0")\nbazel_dep(name = "rules_go", version = "0.50.1")\n',
  'file-types/defs.bzl': bazelMacro,
  'file-types/main.go': 'package main\n\nfunc main() {\n    println("File icon preview")\n}\n',
  'file-types/go.mod': 'module example.com/file-icons\n\ngo 1.22\n',
  'file-types/go.sum': '',
  'file-types/go.work': 'go 1.22\n\nuse .\n',
  'file-types/main.tf': 'terraform {\n  required_version = ">= 1.0"\n}\n',
  'file-types/vars.tfvars': 'region = "eu-west-1"\n',
  'file-types/settings.tf.json': '{\n  "terraform": { "required_version": ">= 1.0" }\n}\n',
  'file-types/terragrunt.hcl': 'terraform {\n  source = "./"\n}\n',
  'file-types/service.proto': 'syntax = "proto3";\n\nmessage Greeting {\n  string message = 1;\n}\n',
  'file-types/main.py': 'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n',
  'file-types/window.pyw': 'import tkinter as tk\n\nwindow = tk.Tk()\nwindow.title("Python file icon preview")\n',
  'file-types/types.pyi': 'def greet(name: str) -> str: ...\n',
  '.github/workflows/checks.yml': 'name: Checks\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n',
  '.vscode/settings.json': '{\n  "editor.formatOnSave": true,\n  "typescript.preferences.importModuleSpecifier": "relative"\n}\n',
  '.editorconfig': 'root = true\n\n[*]\ncharset = utf-8\nindent_style = space\nindent_size = 2\ninsert_final_newline = true\n',
  '.gitignore': 'node_modules/\ndist/\nrelease/\ntest-results/\n',
  'apps/desktop/main/index.ts': 'import { app, BrowserWindow } from "electron";\n\nexport function createWindow() {\n  return new BrowserWindow({\n    width: 1380,\n    height: 900,\n    webPreferences: {\n      contextIsolation: true,\n      nodeIntegration: false,\n      sandbox: true,\n    },\n  });\n}\n\napp.whenReady().then(createWindow);\n',
  'apps/desktop/main/preload.ts': 'import { contextBridge, ipcRenderer } from "electron";\n\ncontextBridge.exposeInMainWorld("desktop", {\n  chooseRepository: () => ipcRenderer.invoke("repository:choose"),\n});\n',
  'apps/desktop/src/bridge.ts': 'export interface Repository {\n  id: string;\n  name: string;\n  path: string;\n}\n\nexport interface ProjectEntry {\n  id: string;\n  path: string;\n  kind: "directory" | "file";\n}\n',
  'apps/desktop/vite.config.ts': 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n  base: "./",\n  build: { target: "es2022" },\n});\n',
  'apps/playground/src/components/RepositoryWelcome.tsx': 'interface RepositoryWelcomeProps {\n  repository: string;\n  changedFiles: number;\n}\n\nexport function RepositoryWelcome({ repository, changedFiles }: RepositoryWelcomeProps) {\n  const label = changedFiles === 1 ? "file" : "files";\n\n  return (\n    <section className="repository-welcome">\n      <h1>{repository}</h1>\n      <p>{changedFiles} changed {label} ready to review.</p>\n      <button type="button">Browse project</button>\n    </section>\n  );\n}\n',
  'apps/playground/src/components/README.md': '# Playground components\n\nThese components are unchanged in this sample repository.\nProject mode includes them even when they have no Git changes.\n',
  'apps/shared/monaco.ts': 'import * as monaco from "monaco-editor";\n\nexport function configureHost() {\n  monaco.editor.setTheme("smart-diff-dark");\n}\n\nexport { monaco };\n',
  'apps/shared/project/ProjectPanel.tsx': 'interface ProjectPanelProps {\n  repositoryName: string;\n}\n\nexport function ProjectPanel({ repositoryName }: ProjectPanelProps) {\n  return (\n    <aside aria-label="Project files">\n      <h2>{repositoryName}</h2>\n      <p>Expand a folder to load its contents.</p>\n    </aside>\n  );\n}\n',
  'packages/monaco-smart-diff/src/index.ts': 'export { createSmartDiff } from "./controller";\nexport type { SmartDiff, SmartDiffOptions, ViewState } from "./types";\n',
  'packages/monaco-smart-diff/src/diff/model.ts': 'export interface LineRange {\n  start: number;\n  end: number;\n}\n\nexport interface Change {\n  id: string;\n  original: LineRange;\n  modified: LineRange;\n}\n',
  'packages/monaco-smart-diff/src/scrolling/synchronizer.ts': 'export class ScrollSynchronizer {\n  private owner: "original" | "modified" = "original";\n\n  setOwner(side: "original" | "modified") {\n    this.owner = side;\n  }\n}\n',
  'packages/monaco-smart-diff/src/types.ts': 'export interface ViewerState {\n  status: "loading" | "ready" | "empty" | "error";\n  changeCount: number;\n  currentChange: number;\n}\n',
  'packages/monaco-smart-diff/package.json': '{\n  "name": "monaco-smart-diff",\n  "version": "0.1.0",\n  "type": "module",\n  "peerDependencies": { "monaco-editor": "0.55.1" }\n}\n',
  'scripts/build-desktop.ts': 'import { build } from "esbuild";\n\nawait build({\n  entryPoints: ["apps/desktop/main/index.ts"],\n  platform: "node",\n  bundle: true,\n  external: ["electron"],\n});\n',
  'tests/viewer.spec.ts': 'import { expect, test } from "@playwright/test";\n\ntest("renders the comparison", async ({ page }) => {\n  await page.goto("/");\n  await expect(page.locator(".smart-diff")).toBeVisible();\n});\n',
  'docs/architecture.md': '# Architecture\n\nThe reusable viewer owns two standalone Monaco editors and an SVG gutter.\nA worker produces one comparison model for decorations, folding, and scrolling.\n',
  'docs/preview.md': markdownPreview,
  'package.json': '{\n  "name": "unintellij-example",\n  "private": true,\n  "scripts": {\n    "dev:playground": "vite",\n    "test": "vitest run"\n  }\n}\n',
  'tsconfig.json': '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "strict": true,\n    "jsx": "react-jsx"\n  }\n}\n',
  'LICENSE': 'MIT License\n\nCopyright (c) Smart Diff contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files to use this software.\n',
};
for (const [path, text] of Object.entries(unchanged)) sources.set(path, { text, state: 'text' });
for (const fixture of languageFixtures) sources.set(fixture.path, { text: fixture.modified, state: 'text' });
sources.set('docs/preview-image.svg', { media: passiveSvg, state: 'media' });
sources.set('linked-settings', { kind: 'symlink', state: 'symlink', message: 'This entry is a symbolic link. The read-only project browser does not follow links.' });
sources.set('vendor/editor-tools', { kind: 'submodule', state: 'submodule', message: 'This entry is a Git submodule. Browsing into nested repositories is not supported.' });

const entries = new Map<string, ProjectEntry>();
for (const [path, source] of sources) {
  const parts = path.split('/');
  for (let length = 1; length < parts.length; length++) {
    const directory = parts.slice(0, length).join('/');
    entries.set(directory, { id: `preview:${directory}`, path: directory, name: parts[length - 1], kind: 'directory' });
  }
  entries.set(path, { id: `preview:${path}`, path, name: parts.at(-1)!, kind: source.kind ?? 'file', ...(source.status ? { status: source.status } : {}) });
}
const directoryRequests: string[] = [];
const completedDirectories: string[] = [];
const heldDirectories = new Set<string>();
const directoryOverrides = new Map<string, ProjectEntry[]>();
const pendingDirectoryReads = new Map<number, { path: string; resolve: () => void }>();
let directoryRequestId = 0;
/** Controllable reads belong only to the in-memory browser fixture, never the desktop bridge. */
export const projectDirectoryReads = {
  hold(path: string) { heldDirectories.add(path); },
  pending() { return [...pendingDirectoryReads].map(([id, read]) => ({ id, path: read.path })); },
  completed() { return [...completedDirectories]; },
  release(id: number) {
    const read = pendingDirectoryReads.get(id);
    if (read) { pendingDirectoryReads.delete(id); read.resolve(); }
  },
  resume(path: string) {
    heldDirectories.delete(path);
    for (const [id, read] of pendingDirectoryReads) if (read.path === path) projectDirectoryReads.release(id);
  },
  setEntries(path: string, value?: ProjectEntry[]) {
    if (value) directoryOverrides.set(path, structuredClone(value));
    else directoryOverrides.delete(path);
  },
};
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 25));
export function requestedProjectDirectories() { return [...directoryRequests]; }
export function projectEntry(path: string) { return entries.get(path); }
export async function loadProjectDirectory(id: string | null): Promise<ProjectDirectory> {
  const directory = id === null ? undefined : [...entries.values()].find(entry => entry.id === id && entry.kind === 'directory');
  if (id !== null && !directory) throw new Error('This preview directory is unavailable. Refresh the project to try again.');
  const path = directory?.path ?? '';
  directoryRequests.push(path);
  // Snapshot before waiting so a delayed obsolete response can be reproduced.
  const listing = structuredClone(directoryOverrides.get(path) ?? [...entries.values()].filter(entry => entry.path.split('/').slice(0, -1).join('/') === path)
    .sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'en')));
  if (heldDirectories.has(path)) await new Promise<void>(resolve => pendingDirectoryReads.set(++directoryRequestId, { path, resolve }));
  await pause();
  completedDirectories.push(path);
  return { repositoryId, directoryId: id, path, truncated: false, entries: listing };
}
function content(text: string): ComparisonSide {
  return { label: 'Working tree', text, metadata: { bytes: new TextEncoder().encode(text).byteLength, encoding: 'utf-8', lineEnding: text.includes('\n') ? 'LF' : 'none', finalNewline: text.endsWith('\n') } };
}
export async function loadProjectFile(entry: ProjectEntry): Promise<ProjectFile> {
  await pause();
  const source = sources.get(entry.path);
  if (!source) return { repositoryId, entryId: entry.id, path: entry.path, state: 'unavailable', message: 'The selected sample file is unavailable.' };
  return { repositoryId, entryId: entry.id, path: entry.path, state: source.state ?? 'text', ...(source.message ? { message: source.message } : {}), ...(source.media ? { media: { ...source.media, label: 'Working tree' } } : {}), ...(source.text !== undefined && source.state === 'text' ? { content: content(source.text) } : {}) };
}
