# Project and Commit tree actions

Right-click a file or directory in either tree (or press Shift+F10 while its row is focused). The shared application menu offers:

- **Add to Git** stages the selected path's current changes, including eligible untracked descendants and deletions. Git ignore rules are respected; this does not force ignored files into the index.
- **Remove from Git…** removes indexed files from tracking after a confirmation and keeps their working copies on disk. This does not edit `.gitignore`. Git refuses removal when it would lose a divergent staged version.
- **Rename…** changes the name in its current parent directory without overwriting an existing item. Renaming does not implicitly stage changes.
- **New → File… / Folder…** creates an empty file or directory inside the chosen directory, or alongside the chosen file. A new file opens in the normal editor; a new directory is revealed in Project.
- Existing Copy Path, Copy Relative Path, file Open In, comparison Jump to Source, and Project directory markings remain available.

Menus and prompts are rendered by the application using its existing popup theme and keyboard/focus handling. Unsupported actions are disabled; their reasons are available to accessibility tools without adding rows that shift the menu.

The **Changes** and **Unversioned Files** group headers also have context menus. Add/Remove apply only to eligible files captured in that group, including collapsed descendants. They never widen to the repository root or another group. Group menus also offer Include All in Commit, Exclude All from Commit, Expand All, Collapse All, and Refresh. Opening a menu leaves the current diff, review checkboxes, and expansion unchanged. Synthetic groups do not offer Rename, New, or file-path actions.

## Integration

`TreeActionsService` resolves issued Project/Commit capabilities in the Electron main process. A Commit folder is authorized through a current descendant change. Every operation validates names and repository boundaries again and runs in the shared repository mutation queue. No arbitrary command or filesystem interface is exposed to the renderer.

Index actions use the existing isolated Git execution helper. They do not execute project scripts or hooks; repositories with executable content filters must use external Git for index actions. Symbolic links, submodules, nested repository boundaries, and Git internals are not mutated through these commands. Bulk index operations are bounded to 10,000 files.

Group actions carry current comparison IDs, revalidate every member after refreshing under the mutation queue, and reject stale or mixed-group requests. They omit unsupported entries and unresolved conflicts; removal confirmation states the eligible file count. Git performs each group mutation in one invocation with literal pathspecs. Clean tracked files outside Changes and new files outside the captured Unversioned group are untouched.

Add and Rename require affected editor buffers to be saved first. On rename, file and diff tabs follow the new path while retaining their tab instances, order, split placement, and saved editor positions. Old edit capabilities are revoked and fresh file reads supply new ones. The repository snapshot and both trees refresh after actions. Removing tracking does not modify an open editor's content.

These operations belong to the desktop application. The reusable diff package is unchanged. Directory Open In is not offered until the native application-opening backend supports it.

## Verification

Backend tests use disposable Git repositories. `scripts/smoke-tree-actions.ts` runs the actual Electron build with a disposable repository and profile, exercises both trees and rename/save coherence, and captures menus in `artifacts/tree-actions/`.

```sh
npm run test:tree-actions
```

`npm run test:change-groups` verifies group-header menus and scoped Git operations in Electron and captures both menus in `artifacts/change-group-menus/`. Browser coverage for selection, expansion, keyboard invocation, and focus restoration lives in `tests/group-context-menu.spec.ts`.
