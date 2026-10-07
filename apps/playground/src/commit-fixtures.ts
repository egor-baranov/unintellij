import type { ChangeFile } from '../../shared/commit/CommitPanel';
import { fixtures } from './fixtures';
import type { MediaContent } from '../../shared/media/types';
import { animatedGif, corruptPng, passiveSvg, pngAfter, pngBefore, sampleAudio, sampleVideo } from './media-fixtures';
import { plainYaml } from './yaml-fixture';

export interface PreviewChange extends ChangeFile { original: string; modified: string; originalMedia?: MediaContent; modifiedMedia?: MediaContent; message?: string }
const fixture = (id: string) => fixtures.find(item => item.id === id)!;
const reference = fixture('reference');
const short = fixture('tsx');

/** A deterministic sample repository, explicitly identified as a preview in UI.
 * Every selectable file has complete example contents or an explicit unsupported state. */
export const commitFiles: PreviewChange[] = [
  { id: 'preferences', path: 'apps/playground/src/ReviewPreferencesPanel.tsx', group: 'unstaged', status: 'M', original: reference.original, modified: reference.modified },
  { id: 'playground-main', path: 'apps/playground/src/main.tsx', group: 'unstaged', status: 'M', original: short.original, modified: short.modified },
  { id: 'fixtures', path: 'apps/playground/src/fixtures.ts', group: 'unstaged', status: 'M', original: 'export const fixtureNames = [\n  "Small component",\n  "Large insertion",\n];\n', modified: 'export const fixtureNames = [\n  "Reference-style component",\n  "Small component",\n  "Large insertion",\n  "Commit preview",\n];\n' },
  { id: 'html', path: 'apps/playground/index.html', group: 'unstaged', status: 'M', original: '<!doctype html>\n<html lang="en">\n  <head><title>Diff playground</title></head>\n  <body><div id="root"></div></body>\n</html>\n', modified: '<!doctype html>\n<html lang="en">\n  <head><title>unintellij · Review changes</title></head>\n  <body><main id="root"></main></body>\n</html>\n' },
  { id: 'desktop-main', path: 'apps/desktop/src/main.tsx', group: 'unstaged', status: 'M', original: 'export function RepositoryHeader({ name }: { name: string }) {\n  return <header>{name}</header>;\n}\n', modified: 'export function RepositoryHeader({ name }: { name: string }) {\n  return (\n    <header className="repository-header">\n      <strong>{name}</strong>\n      <span>Local changes</span>\n    </header>\n  );\n}\n' },
  { id: 'desktop-style', path: 'apps/desktop/src/style.css', group: 'unstaged', status: 'M', original: '.sidebar {\n  width: 246px;\n  background: #20242b;\n}\n', modified: '.sidebar {\n  width: 350px;\n  background: #191a1c;\n}\n\n.sidebar:focus-within {\n  outline-color: #3975ef;\n}\n' },
  { id: 'controls', path: 'apps/shared/Controls.tsx', group: 'unstaged', status: 'M', original: 'export function RefreshButton({ refresh }: { refresh: () => void }) {\n  return <button onClick={refresh}>Refresh</button>;\n}\n', modified: 'export function RefreshButton({ refresh }: { refresh: () => void }) {\n  return (\n    <button onClick={refresh} aria-label="Refresh changes" title="Refresh changes">\n      ↻\n    </button>\n  );\n}\n' },
  { id: 'gutter', path: 'packages/monaco-smart-diff/src/rendering/gutter.ts', group: 'unstaged', status: 'M', original: 'const gutterWidth = 42;\nconst numberWidth = 0;\n\nexport function centerWidth() {\n  return gutterWidth;\n}\n', modified: 'const gutterWidth = 152;\nconst numberWidth = 48;\n\nexport function centerWidth() {\n  return gutterWidth - numberWidth * 2;\n}\n' },
  { id: 'colors', path: 'packages/monaco-smart-diff/src/styles.css', group: 'unstaged', status: 'M', original: '.smart-diff {\n  --background: #1b1e23;\n  --replacement: #244652;\n}\n', modified: '.smart-diff {\n  --background: #101119;\n  --replacement: #10242e;\n  --addition: #264b33;\n}\n' },
  { id: 'theme-staged', path: 'apps/shared/theme.ts', oldPath: 'apps/shared/dark-theme.ts', group: 'staged', status: 'R', original: 'export const darkTheme = {\n  background: "#1b1e23",\n  fontSize: 13,\n};\n', modified: 'export const referenceTheme = {\n  background: "#101119",\n  fontSize: 16,\n  lineHeight: 23,\n  fontWeight: "400",\n};\n' },
  { id: 'playground-staged', path: 'apps/playground/src/main.tsx', group: 'staged', status: 'M', original: short.original.replace('Working tree', 'Changes'), modified: short.original },
  { id: 'mapping-staged', path: 'packages/monaco-smart-diff/src/scrolling/mapping.ts', group: 'staged', status: 'A', original: '', modified: 'export function interpolate(position: number, start: number, end: number) {\n  if (end === start) return 0;\n  return Math.max(0, Math.min(1, (position - start) / (end - start)));\n}\n' },
  { id: 'readme-staged', path: 'README.md', group: 'staged', status: 'M', original: '# Smart Diff\n\nA local comparison viewer.\n', modified: '# Smart Diff\n\nA compact, read-only Git comparison viewer.\n\n## Review changes\n\nChoose a file in the Commit panel to compare complete contents.\nCheckboxes and message drafts are local review state.\n' },
  { id: 'removed-script', path: 'scripts/legacy-preview.ts', group: 'staged', status: 'D', original: 'export function oldPreview() {\n  return "Legacy preview";\n}\n', modified: '' },
  { id: 'removed-yaml', path: 'releases/retired-worker.yaml', group: 'unstaged', status: 'D', original: plainYaml, modified: '' },
  { id: 'empty-deleted', path: 'docs/deleted-empty.txt', group: 'staged', status: 'D', original: '', modified: '' },
  { id: 'emptied-modified', path: 'src/now-empty.ts', group: 'unstaged', status: 'M', original: 'export const stillTracked = true;\n', modified: '' },
  { id: 'new-panel', path: 'apps/shared/commit/CommitPanel.tsx', group: 'untracked', status: '?', original: '', modified: 'interface CommitPanelProps {\n  selectedCount: number;\n}\n\nexport function CommitPanel({ selectedCount }: CommitPanelProps) {\n  return (\n    <aside aria-label="Commit review">\n      <h2>Commit</h2>\n      <p>{selectedCount} files selected for review</p>\n    </aside>\n  );\n}\n' },
  { id: 'new-test', path: 'tests/commit.spec.ts', group: 'untracked', status: '?', original: '', modified: 'import { expect, test } from "@playwright/test";\n\ntest("opens the selected file", async ({ page }) => {\n  await page.goto("/?view=commit");\n  await expect(page.getByRole("tree", { name: "Changed files" })).toBeVisible();\n});\n' },
  { id: 'new-capture', path: 'scripts/capture-commit.ts', group: 'untracked', status: '?', original: '', modified: 'export const captureViewport = {\n  width: 1600,\n  height: 1000,\n  deviceScaleFactor: 1,\n};\n' },
  { id: 'notes', path: 'docs/review notes.md', group: 'untracked', status: '?', original: '', modified: '# Review notes\n\n- Check the original and modified line numbers.\n- Expand a collapsed region with the keyboard.\n- Resize the file tree without losing the reading position.\n' },
  { id: 'image-added', path: 'artifacts/sample.png', group: 'untracked', status: '?', original: '', modified: '', modifiedMedia: pngAfter },
  { id: 'image-modified', path: 'assets/banner.png', group: 'unstaged', status: 'M', original: '', modified: '', originalMedia: pngBefore, modifiedMedia: pngAfter },
  { id: 'image-deleted', path: 'assets/removed.png', group: 'unstaged', status: 'D', original: '', modified: '', originalMedia: pngBefore },
  { id: 'svg', path: 'assets/mark.svg', group: 'untracked', status: '?', original: '', modified: '', modifiedMedia: passiveSvg },
  { id: 'gif', path: 'assets/pulse.gif', group: 'untracked', status: '?', original: '', modified: '', modifiedMedia: animatedGif },
  { id: 'audio', path: 'artifacts/tone.wav', group: 'untracked', status: '?', original: '', modified: '', modifiedMedia: sampleAudio },
  { id: 'video', path: 'artifacts/demo.webm', group: 'untracked', status: '?', original: '', modified: '', modifiedMedia: sampleVideo },
  { id: 'corrupt-image', path: 'artifacts/corrupt.png', group: 'untracked', status: '?', original: '', modified: '', modifiedMedia: corruptPng },
  { id: 'binary', path: 'artifacts/sample.bin', group: 'untracked', status: '?', unsupported: 'binary', original: '', modified: '', message: 'This binary format has no supported preview. Choose a source or supported media file to continue reviewing.' },
  { id: 'empty-added', path: 'docs/empty.txt', group: 'untracked', status: '?', original: '', modified: '' },
  { id: 'empty-modified', path: 'src/was-empty.ts', group: 'unstaged', status: 'M', original: '', modified: 'export const wasAlreadyTracked = true;\n' },
];

/** Compare tracked paths from HEAD directly to the working tree. A path with
 * both index and working-tree edits is one selectable change in the preview. */
export function previewWorkingChanges(files: readonly PreviewChange[]): PreviewChange[] {
  const paths = new Map<string, PreviewChange[]>();
  for (const file of files) {
    const entries = paths.get(file.path) ?? [];
    entries.push(file); paths.set(file.path, entries);
  }
  return [...paths.values()].flatMap(entries => {
    const staged = entries.find(file => file.group === 'staged');
    const unstaged = entries.find(file => file.group === 'unstaged');
    const untracked = entries.find(file => file.group === 'untracked');
    const original = staged ?? unstaged;
    const modified = unstaged ?? untracked ?? staged;
    if (!original || !modified) return entries;
    const originalExists = original.status !== 'A';
    const modifiedExists = modified.status !== 'D';
    if (!originalExists && !modifiedExists) return [];
    const oldPath = staged?.oldPath ?? unstaged?.oldPath;
    return [{ ...modified, group: 'working' as const,
      original: original.original, originalMedia: original.originalMedia,
      oldPath,
      status: !originalExists ? 'A' : !modifiedExists ? 'D' : oldPath ? 'R' : modified.status === 'T' ? 'T' : 'M',
    }];
  });
}

export const workingCommitFiles = previewWorkingChanges(commitFiles);

/** Keep links to the older index-only fixtures useful without opening a second
 * comparison tab for a path that is already present in Changes. */
export function workingCommitFile(id: string): PreviewChange | undefined {
  const path = commitFiles.find(file => file.id === id)?.path;
  return workingCommitFiles.find(file => file.id === id || file.path === path);
}
