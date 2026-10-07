# IntelliJ application icons

This directory vendors 121 official IntelliJ platform/plugin SVGs for the application hosts. Each SVG is stored byte-for-byte, preserving any original copyright and license header. Only the local filenames were changed to semantic names. The reusable diff library does not depend on these host assets.

`manifest.json` maps each local basename to its original URL, source path, SHA-256 digest, dimensions, and license. Public Git sources also record their immutable revision. No assets are downloaded at application runtime.

## Sources

Most icons come from [`JetBrains/intellij-community`](https://github.com/JetBrains/intellij-community/tree/fcefa45538a820b83936933f4ae2ed333308fd77/platform/icons/src/expui) at revision `fcefa45538a820b83936933f4ae2ed333308fd77`, primarily `platform/icons/src/expui/` (the New UI set).

The branch widget icon comes from `platform/icons/src/expui/general/vcs_dark.svg` in the same revision. The upstream [`PlatformIconMappings.json`](https://github.com/JetBrains/intellij-community/blob/fcefa45538a820b83936933f4ae2ed333308fd77/platform/icons/src/PlatformIconMappings.json) maps the classic `vcs/branch.svg` and `vcs/branchNode.svg` icons to this New UI artwork. The current-branch label comes from `platform/dvcs-impl/shared/resources/icons/new/currentBranchLabel_dark.svg`; favorite, fetch, push, update, and merge icons come from the New UI set.

Two language icons come from other paths in that same revision:

- Kotlin: `plugins/kotlin/base/resources/resources/org/jetbrains/kotlin/idea/icons/expui/kotlin_dark.svg`
- Python: `python/python-parser/resources/icons/com/jetbrains/python/parser/expui/python_dark.svg`

The React TSX and JSX icons come from the official [IntelliJ Platform Icons catalogue](https://intellij-icons.jetbrains.design/), under `icons/JavaScriptCoreIcons/icons/expui/fileTypes/`. Their Apache-2.0 declarations are in the individual SVG headers. These catalogue downloads have no established public Git revision; their exact bytes are pinned by checksum instead:

- `file-tsx.svg`: `326927e0962f534e6d3f8b65fc6079beec4cd674040392999478a34625f4288e`
- `file-jsx.svg`: `405daa657358e9e3076f56ac25682aeef09333d4394c84ac462f03461cc1142b`

Ruby, PHP, Groovy, Gradle, Less, and Go's module/checksum/workspace files use unchanged catalogue assets with explicit Apache-2.0 headers. Go source and test files use the exact New UI blue gopher artwork from `GoGeneratedIcons/icons/expui/go_dark.svg` and `runTest_dark.svg`; the latter includes IntelliJ's test overlay. These two SVGs have no license header and no public upstream asset license has been established. They are separately marked `NOASSERTION` in the manifest, not Apache-2.0. The catalogue's statement that **most** icons are Apache-2.0 is not blanket license evidence. The manifest pins every download by SHA-256.

Terraform comes from the pinned platform revision. HCL, Terragrunt, and Protobuf come from [`JetBrains/intellij-plugins`](https://github.com/JetBrains/intellij-plugins/tree/973e7a0bd2e4f18f529d8638d285bbba56f61e82) at revision `973e7a0bd2e4f18f529d8638d285bbba56f61e82`. Protobuf's SVG has no individual header; its Apache-2.0 license is established by the plugin's `protobuf/LICENSE.txt`, recorded by immutable URL and checksum in the manifest.

Bazel uses the unchanged dark file icon from JetBrains' official Bazel plugin, [`JetBrains/hirschgarten`](https://github.com/JetBrains/hirschgarten/tree/fdb5266347c35eae0e623fd2efaaf68ad2601b8e), at revision `fdb5266347c35eae0e623fd2efaaf68ad2601b8e`: `intellij.bazel.resource/resources/icons/bazel_dark.svg`. The upstream Starlark, Bazelrc, and BazelVersion file types all use this artwork. The SVG has no individual header; the repository's [Apache-2.0 license at that revision](https://github.com/JetBrains/hirschgarten/blob/fdb5266347c35eae0e623fd2efaaf68ad2601b8e/LICENSE) is distributed unchanged as `licenses/intellij-bazel-APACHE-2.0.txt`. The manifest pins both the SVG and license bytes by SHA-256.

Vue and Dart are byte-identical to the catalogue and pinned to their Apache-2.0 plugin subtrees in `intellij-plugins`. The Rust and Svelte icons are also exact catalogue matches, sourced from the MIT-licensed `intellij-rust/intellij-rust` and `tomblachut/svelte-intellij` plugins at immutable revisions. Their original MIT copyright/license texts are distributed as `licenses/intellij-rust-MIT.txt` and `licenses/intellij-svelte-MIT.txt`. The manifest records all source, catalogue, and license URLs and checksums.

GraphQL, Handlebars, Gherkin, and database file icons come from the official catalogue with their individual Apache-2.0 headers intact. The Windows file icon comes from the pinned platform revision. Pug, Astro, Prisma, and WebAssembly match catalogue assets byte-for-byte and are pinned to the same `intellij-plugins` revision above; the first three use their respective plugin Apache-2.0 licenses, and WebAssembly uses its plugin MIT license. Those unchanged license texts are retained in `licenses/intellij-{pug,astro,prisma}-Apache-2.0.txt` and `licenses/intellij-wasm-MIT.txt`.

R source and R Markdown icons match the catalogue and come from [`JetBrains/Rplugin`](https://github.com/JetBrains/Rplugin/tree/353e94c621d077094b46a979dbc5d31f1b716c6d) at revision `353e94c621d077094b46a979dbc5d31f1b716c6d`, under its Apache-2.0 root license. F# source, script, and signature icons come from [`JetBrains/resharper-fsharp`](https://github.com/JetBrains/resharper-fsharp/tree/6ccc76e54f3523ee57878db6a310c193752efbf9) at revision `6ccc76e54f3523ee57878db6a310c193752efbf9`, using the plugin's New UI assets and Apache-2.0 license. Their license texts are distributed as `licenses/intellij-r-APACHE-2.0.txt` and `licenses/intellij-fsharp-APACHE-2.0.txt`.

The similarly named [`JetBrains/icons`](https://github.com/JetBrains/icons) repository contains JetBrains' web application icons. These assets use the IntelliJ New UI sources instead.

The three native look-and-feel checkbox assets come from release tag `idea/243.21565.193`, pinned to revision `9ae2edc879df5e9e189483752c4c4ae01650a566`, under `platform/platform-resources/src/themes/expUI/icons/dark/`. They do not contain individual license comments. Their licensing is established by the [Apache-2.0 repository-root license at that exact release revision](https://github.com/JetBrains/intellij-community/blob/9ae2edc879df5e9e189483752c4c4ae01650a566/LICENSE.txt); the manifest records the license URL and checksum. Attribution from both upstream revisions is retained in the distributed notice file.

## Licensing and validation

Except for the two explicitly unverified Go New UI assets above, platform and language assets use their explicit Apache-2.0 headers or a verified Apache-2.0/MIT upstream license recorded in the manifest. The three native checkbox assets use the verified Apache-2.0 release-root license described above. The current repository-root build terms were not used as an asset license. The Apache license and upstream attribution are distributed in:

- [`licenses/jetbrains-icons-APACHE-2.0.txt`](../../../licenses/jetbrains-icons-APACHE-2.0.txt)
- [`licenses/jetbrains-icons-NOTICE.txt`](../../../licenses/jetbrains-icons-NOTICE.txt)

Retain those files and the SVG headers when redistributing. If an SVG is changed, record the modification and update its manifest digest. The source assets were also parsed as SVG and checked for script elements, foreign objects, and event-handler attributes.

## Mapping notes

- Dark variants are used whenever provided. `play`, `eye`, and `file-gitignore` use the corresponding shared light/dark upstream assets.
- `split` is the side-by-side diff icon; `compact` uses the split action icon. `project` and `commit` use the actual tool-window icons.
- `diff` uses `platform/icons/src/expui/vcs/diff_dark.svg` at the pinned platform revision for opposing-arrow comparison tabs. Its original Apache-2.0 header and bytes are retained, with SHA-256 `b3a255544bbd5d5412d84d66b16ca56e5b5a4de41a602ae58e0bdd6604a47ceb` recorded in the manifest.
- Checkbox states use the native 24 × 24 look-and-feel SVGs. Their visible 16 × 16 boxes are inset by 4 pixels; checked and mixed states use the original blue fill and white glyphs.
- The catalogue is not uniformly Apache-2.0 licensed. The two requested Go New UI assets are recorded as explicit license-unverified exceptions. Additional unlicensed catalogue artwork was not added: C/C++, Objective-C, C#, Swift, Julia, Lua, Elixir, Erlang, Haskell, assembly, and PDF currently use the licensed generic text icon; PowerShell uses the shell icon; Make/CMake use config; notebooks use JSON; Sass retains CSS. These are category fallbacks, not dedicated language logos. Every unknown type still receives the official JetBrains unknown-file icon.

## File recognition

`fileTypes.ts` is the shared filename resolver for Project and Commit trees, normal editor tabs, branch comparison lists, and the Find in Files preview. It chooses exact filenames first, then compound suffixes, then case-insensitive extensions. Examples include `go.mod`, `go.work.sum`, `terragrunt.hcl`, `*.tf.json`, `*.tfvars.json`, and `*.gradle.kts`. Python source/stub/windowed/Cython variants share the Python file icon; compiled Python files use the binary icon. Comparison tabs retain their separate diff identity.

Bazel source files use the shared `isBazelSourceFile` classifier: `BUILD`, `WORKSPACE`, and `.bazel`/`.bzl` files, including `BUILD.bazel`, `WORKSPACE.bazel`, `MODULE.bazel`, and module fragments. `.bazelrc` and `.bazelversion` receive the same upstream file icon while remaining separate from Starlark syntax recognition. Backup names and files merely beneath a Bazel-named directory retain their normal fallback.

Go test files use the shared `isGoTestFile` classifier and the upstream test-overlay artwork. The `_test.go` suffix is case-sensitive, matching Go's actual convention; dot/underscore-prefixed basenames are ignored by Go and do not receive the test icon. The existing case-insensitive generic `.go` association remains for other Go-looking filenames. Test scope backgrounds are resolved independently in project semantics, without replacing Git filename colors.

Explicit associations cover every extension advertised by Monaco’s bundled basic languages, plus common document, image, audio/video, archive, database, certificate, and compiled formats. Exact names include Makefile, CMakeLists.txt, shell profiles, and package-manager lockfiles. F# source, signature, and script files keep their distinct official icons. The pure shared syntax filename resolver supplies a text-file icon for additional recognized formats lacking a dedicated asset, keeping the broader syntax catalogue and icon fallback coverage aligned. It does not load Monaco or tokenizers.

Recognition never reads file contents or runs project code. Extensionless scripts with only a shebang and unknown file types use the generic fallback. A language icon does not imply that a compiler, language server, or syntax tokenizer is installed. Directory semantics remain independent of these file associations.

The icon tests verify local registry completeness, unchanged source hashes, license evidence, safe SVG contents, filename precedence, every bundled Monaco extension, the complete shared syntax catalogue’s filename associations, and unknown-name fallbacks. The browser fixture under `file-types/` verifies the requested language icons decode locally in both tree rows and ordinary tabs.
