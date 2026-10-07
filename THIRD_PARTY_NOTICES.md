# Third-party notices

The application uses `vscode-textmate` 9.3.0 and `vscode-oniguruma` 2.0.1 (MIT) to load supplementary syntax grammars locally on demand. Engine licenses and Oniguruma notices are retained in `licenses/vscode-textmate-MIT.txt`, `licenses/vscode-oniguruma-MIT.txt`, and `licenses/vscode-oniguruma-NOTICES.txt`.

Supplementary grammars come from pinned `tm-grammars` 1.32.22. Its MIT package license and complete upstream notices are retained in `licenses/textmate-grammars-MIT.txt` and `licenses/textmate-grammars-NOTICE.txt`. The distribution includes only grammar entries marked MIT, Apache-2.0, BSD-3-Clause, or ISC, plus the TOML, Sass, and YAML grammars whose pinned upstream license texts are separately retained in `licenses/textmate-toml-license.txt`, `licenses/textmate-sass-MIT.txt`, and `licenses/textmate-yaml-MIT.txt`. `licenses/textmate-grammars-sources.json` records every included source revision and SHA-256. Grammar files retain their source bytes in the installed dependency; bundling converts JSON to JavaScript without changing grammar rules.

unintellij uses the following runtime components. Original license texts are retained in `licenses/`.

| Component | Pinned version | License | Source |
| --- | --- | --- | --- |
| Monaco Editor | 0.55.1 (peer) | MIT, Microsoft Corporation | https://github.com/microsoft/monaco-editor |
| vscode-diff | 3.0.1 | MIT, Microsoft/VS Code contributors and extraction contributors | https://github.com/micnil/vscode-diff |
| React / React DOM | 19.2.0 | MIT, Meta Platforms, Inc. and affiliates | https://github.com/facebook/react |
| Electron | 41.10.7 | MIT; Chromium/other bundled third-party licenses | https://github.com/electron/electron |
| DOMPurify | 3.4.16 (override) | MPL-2.0 OR Apache-2.0 | https://github.com/cure53/DOMPurify |
| Marked | 18.1.0 | MIT, Christopher Jeffrey | https://github.com/markedjs/marked |
| entities | 8.1.0 | BSD-2-Clause, Felix Böhm | https://github.com/fb55/entities |
| @xmldom/xmldom | 0.8.15 | MIT, Christopher J. Brody, @jindw and contributors | https://github.com/xmldom/xmldom |
| IntelliJ application icons | Vendored SVGs; immutable source revisions and SHA-256 hashes in `apps/shared/icons/manifest.json` | Apache-2.0; Rust/Svelte/WebAssembly plugin assets MIT with separate notices; two Go New UI assets have unverified licensing (`NOASSERTION`) | https://github.com/JetBrains/intellij-community, https://github.com/JetBrains/intellij-plugins and https://intellij-icons.jetbrains.design/ |

The packaged Electron distribution additionally retains its `LICENSE` and `LICENSES.chromium.html`. Build/test dependency versions and transitive dependency metadata are recorded in `package-lock.json`; installed packages include their respective license files.

The main process uses @xmldom/xmldom to read bounded IntelliJ module metadata. Editor-scheme tests also use it; renderer scheme imports use the browser's native `DOMParser`. Its license is distributed in `licenses/xmldom.txt`.

The application hosts use selected IntelliJ icons. Vendored SVG artwork is retained unchanged, including upstream copyright headers where present. The Bazel file icon comes from the official [JetBrains/hirschgarten plugin](https://github.com/JetBrains/hirschgarten/tree/fdb5266347c35eae0e623fd2efaaf68ad2601b8e); its Apache-2.0 license is retained in `licenses/intellij-bazel-APACHE-2.0.txt`. Go source/test artwork comes from the official catalogue's `GoGeneratedIcons/icons/expui/go_dark.svg` and `runTest_dark.svg`; neither declares a license, so those two assets are not represented as Apache-2.0. Semantic Project tree folder variants derive from the bundled folder silhouette, with local colors and small role overlays in `TreeSemanticIcon.tsx`. R and F# file icons come from the Apache-2.0 JetBrains Rplugin and resharper-fsharp projects at the immutable revisions in the manifest. Pug, Astro, Prisma, and WebAssembly assets come from their public intellij-plugins subtrees; WebAssembly uses MIT and the others use Apache-2.0. Their original license texts are retained separately in `licenses/`. GraphQL, Handlebars, Gherkin, and database icons retain the catalogue’s individual Apache-2.0 declarations. Source provenance is documented in `apps/shared/icons/README.md`; `licenses/jetbrains-icons-APACHE-2.0.txt` and `licenses/jetbrains-icons-NOTICE.txt` are distributed with browser and desktop builds. unintellij is an independent application, not a JetBrains product. No JetBrains product logos are used.
