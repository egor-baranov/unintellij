# Project tree semantics

The Project tree uses `ProjectEntry.facts` and `ProjectDirectory.facts`. The desktop Git/file service acquires serializable facts; `resolveTreePresentation` in `apps/shared/project/presentation.ts` is a pure presentation function. The reusable diff renderer is unchanged.

## Independent facts

Every entry carries repository identity, a normalized relative path, metadata generation, filesystem kind (including symlink target state/unavailable entries), declared and inherited project role, dependency-root membership, generated status, inclusion/exclusion provenance, separate Git index and working-tree states, immediate/recursive change summaries, diagnostic coverage, and scopes. Names beginning with a dot have no special color rule. `.git` internals remain inaccessible.

The selected project directory is a content root. Additional roots are supported inside it. External roots are not authorized by imported project files; the application does not implement a multi-content-root workspace. The model reserves an `outside` inclusion state for consumers with that information.

Classification precedence is:

1. Persisted user markings.
2. Supported project declarations: direct `.iml` files in the project root or `.idea`, and explicit `tsconfig.json` `compilerOptions.rootDir`/`outDir`.
3. Conservative dependency detection: `node_modules` directly under a directory containing a valid `package.json`.
4. Ordinary included project content.

More specific paths win within a precedence tier. Classification fields are resolved independently: an inclusion override can suppress automatic exclusion without erasing library membership, changing Git ignore rules, or removing generated status. A generated source marking remains included. A root icon and the `library root` annotation apply only at the declared root, not every descendant.

Directory metadata is discovered lazily as project directories are visited or search considers them. Dependency contents are not recursively scanned for decoration. Nested workspace package roots are recognized in their own package context. JSON/JSONC and bounded XML are parsed as data; no scripts, configs, extensions, imports, or package executables are evaluated.

No source/test/resource classification is inferred from names like `src`, `test`, `build`, `vendor`, or hidden directory names. `.vite` can be Git-ignored without being project-excluded. Other ecosystems, JavaScript build configuration, inherited TypeScript configs, external module roots, and a full IDE dependency index are not implemented. Use manual markings for unsupported project metadata.

Go's case-sensitive `*_test.go` file convention supplies a file-local test scope, without declaring the parent a test source root or changing the file's inclusion/Git state. Dot- and underscore-prefixed source basenames (ignored by Go), directories, and symlinks do not receive this detection. Project and Commit rows use the existing test-scope background token; selection and hover override the tint while Git filename colors remain intact. The Project menu's **Scope backgrounds** preference also controls this tint in the Commit tree. This recognizes Go test sources; it does not run or discover individual tests.

## Git and presentation

The existing Git service supplies porcelain status and the index. Batched `git check-ignore --verbose --non-matching -z --stdin` supplies actual ignore provenance, including nested rules, negation, local excludes, and global excludes. Tracked entries remain tracked even when they match ignore patterns. Unknown state is represented separately from clean/ignored.

Git foreground mapping uses separate theme tokens for clean, modified/type-changed, added, renamed, copied, deleted, untracked, ignored, conflicted, and unavailable states. Conflict takes priority; combined states otherwise prioritize untracked, added, renamed/copied, deleted, then modified. Index and working-tree facts both remain in the tooltip. Directory summaries count changed files in the complete repository snapshot, including collapsed/unloaded descendants. `descendants` includes immediate children; `immediate` counts direct changed files only. Ignored content does not count as a change. Ordinary untracked directories retain neutral names; ignored directories retain their warm color. Optional directory highlighting uses modified/conflict coloring rather than promoting every ancestor to added or untracked.

The following paint layers are independent:

- Icon: filesystem/root role, excluded/dependency treatment, with generated/link/repository overlays where applicable.
- Filename: relevant Git state, optional changed-directory summary, otherwise normal text. Clean ordinary directories remain neutral.
- Background: custom scope (highest explicit priority, then stable ID), non-project/dependency scope, then test scope. No color blending. Scope membership flows down its own subtree, never up to an ordinary parent.
- Interaction: focused selection, unfocused selection, drop target, hover, then scope. CSS handles hover/focus without recomputing metadata. Full-row paint covers indentation and horizontal scrolling.
- Underline: actual reported errors, then warnings; only the filename is underlined. VCS foreground and annotations remain independent.

`apps/shared/project/theme.ts` centralizes reference colors, including the supplied warm ignored-name/dependency tint and neutral folder palette. Untracked files use red (`#ea8d8a` in dark presets, `#a93a39` in Light), independently of warm ignored items. The reference selection background is slightly darker so status names and selected annotations remain readable. Other presets adapt to their surfaces. Appearance settings expose a Project tree component; native scheme import/export preserves all tokens. IntelliJ UI theme imports establish tree surface colors, while semantic tokens use the application's compatible palette.

## Controls, storage, and search

Right-click a directory and choose **Mark Directory As**: Sources, Test Sources, Resources, Test Resources, Generated Sources, Generated Test Sources, Excluded, Cancel Exclusion, Unmark, or Reset to Automatic. Cancel Exclusion sets an explicit inclusion override. Unmark sets an ordinary role; Reset to Automatic removes the explicit rule and restores configuration/detection.

The Project header menu independently controls excluded entries, ignored entries, hidden entries, changed-directory coloring, scope backgrounds, status colors, and the root path annotation. Visibility/color choices do not change search eligibility.

Markings and preferences are atomically stored per canonical project path in the application's user-data `project-trees` directory. No `.gitignore`, Git index, source files, permissions, or JetBrains project metadata are written. Narrow IPC accepts only a repository capability, issued directory capability, and a supported marking/preference. Marking changes notify the existing refresh pipeline.

Find in Files uses the same authoritative project inclusion metadata. Explicit inclusion suppresses a project exclusion, but does not override Git's independent ignore policy. Eligible tracked content remains searchable even when it matches an ignore pattern. Non-Git project folders are supported with a bounded filesystem search and no invented Git status. Nested repositories/submodules are separate boundaries; open them as projects for their own Git namespace.

## Diagnostics and refresh

The application subscribes to public Monaco marker events on normal open project-file models. Reports are keyed by project/path; split views do not double-count errors. Known reports propagate through unloaded ancestors. Excluded/dependency/nested repository reports stop at their own boundary. Reports clear when markers clear or the last model closes; content changes invalidate old reports until analysis responds. No synthetic diagnostics are generated.

Coverage is explicitly `unknown` or `open-files`; the tree does not imply a project-wide analysis. The currently configured diagnostic provider is Monaco's JSON service. Other languages have syntax tokenization but no newly introduced language server. Historical diff snapshots and search previews do not contribute project diagnostics.

Git/metadata refreshes preserve expansion, order and visible rows. Cached facts carry a generation; stale repository/path/generation responses are rejected. Diagnostic updates have a separate subscription. The existing bounded watcher/polling system detects relevant filesystem, Git, ignore and observed configuration changes; decoration acquisition never recursively scans a dependency tree.

Expanding watch coverage establishes a baseline for newly observed paths; it does not count as a repository change. Existing paths still report edits even when coverage changes during the same probe. Directory requests are tracked separately from cached rows, so a refresh that interrupts a first read restarts it instead of retaining an orphaned loading state.

## Verification

- `npx vitest run apps/desktop/main/project-semantics.test.ts apps/desktop/main/project-metadata.test.ts apps/desktop/main/file-search.test.ts apps/shared/project apps/shared/settings`
- `npm run typecheck` and `npm run lint`
- `npm run build:desktop`
- `npx tsx scripts/smoke-project-decorations.ts`
- `npx tsx scripts/smoke-project-loading.ts` exercises directory expansion without refresh churn, an interrupted first read, and automatic updates after real filesystem changes.

The smoke creates a disposable real Git repository and app profile, exercises markings/filters/reload persistence, opens invalid JSON to obtain real worker diagnostics, fixes it externally, and captures `artifacts/project-decorations/`. It accepts `SMART_DIFF_PACKAGED_EXECUTABLE` to verify a packaged build. The unit/integration fixtures additionally cover ignore negation, mixed tracked/ignored content, conflicts, no-Git folders, exclusion/search consistency, submodules, nested repositories, dependency traversal bounds, scope overlap, and diagnostic cleanup.
