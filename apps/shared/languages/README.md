# Application language support

The shared host setup covers normal file editors, both diff panes, added files,
and Find in Files snippets/previews. The reusable diff package still accepts
host-created Monaco models and does not register languages globally.

## Recognition and precedence

`resolver.ts` is a pure filename/optional-first-line resolver, also used by the
icon fallback. It performs no file reads or grammar loading. Resolution is:

1. Exact filenames, then configured filename patterns.
2. Longest compound extension first; `.C` and `.H` retain the C++ association.
3. Supported first-line/shebang associations when source is available.
4. Plain text for unknown formats. Known binary/text extensions cannot acquire
   a script language merely because the first line resembles a shebang.

For conflicting associations, application overrides win, then Monaco's bundled
metadata, then the supplemental catalog. Examples: TSX/JSX keep the host's JSX
tokenizer, Bazel uses Starlark, Terraform uses HCL, and Terraform JSON uses JSON.
Binary files continue through the existing media/unsupported-file handling.

`bundled.ts` records the associations from pinned Monaco 0.55.1; `contributions.ts`
enables its complete bundled basic-language catalog. Their tests detect drift
against the installed dependency. JSON retains Monaco's dedicated provider.

YAML keeps Monaco's `.yaml`/`.yml` associations and configuration, with one lazy
host extension for Helm's `{{ ... }}` Go-template actions. Keys, scalar values,
booleans, comments and document markers share the syntax palette with template
keywords, functions, variables and strings. Template state returns to the
surrounding quoted value, flow collection or block scalar after `}}`.
This is lexical coloring: templates are never evaluated, schemas are not checked,
and `.tpl`/`.gotmpl` files are not newly associated. Ordinary YAML `#` comments
retain comment styling, including template-looking text within them.

## Additional grammars and loading

`additionalCatalog.ts` supplies TextMate coverage for gaps such as Vue, Svelte,
Astro, TOML, Make, CMake, Groovy/Gradle, JSON5, Sass, Fish, Haskell, Erlang, Prisma,
Nix, and other supported formats. TextMate grammar identifiers use a separate
`textmate-` namespace, so they never replace working Monaco tokenizers.

Registration is lightweight. Monaco tokenizers load lazily; the supplemental
engine, local Oniguruma WASM asset, grammar, injections, and referenced embedded
grammars load only on first use and are cached. Embedded web grammars can load
many dependencies (for example Markdown's fenced-code languages). No grammar,
icon, or WASM request goes to the network at runtime. Electron's CSP allows
WASM compilation with `wasm-unsafe-eval`, without allowing JavaScript eval.

`textmateScopes.ts` maps scopes into the existing syntax palette. Color/style
preferences, imported themes, and disabling syntax highlighting continue to
apply. TextMate state carries across lines and edits. A first-use timeout retries
from the incoming state once; a repeatedly interrupted line stays neutral instead
of passing incomplete string/comment state to later lines. The cooperative
per-line budget cannot preempt a single Oniguruma regular-expression call.
Monaco's existing long-line policy remains in effect.

This provides lexical highlighting, not IntelliJ's language analysis, navigation,
or compiler services. A dedicated JetBrains icon does not imply a language
server. Arbitrary proprietary formats and every optional embedded language are
not guaranteed: unknown content remains readable, and an unavailable embedded
grammar retains its surrounding grammar's treatment.

## Reproducibility and licensing

`npm run generate:languages` rebuilds the supplemental catalog and dynamic import
map from pinned `tm-grammars`, with no network access. The generator selects
known permissive licenses and explicitly verified upstream exceptions. It records
source revisions, hashes, and license evidence in
`licenses/textmate-grammars-sources.json`; original license texts and notices ship
with both builds. Entries with unverified licenses are not bundled.

The separate [icon registry](../icons/README.md) preserves official JetBrains
SVG bytes and source/license metadata. Formats without a verified dedicated icon
use an appropriate JetBrains category icon, with an unknown-file icon as the
final fallback.

## Verification

- Unit tests validate filename precedence, binary/plain fallbacks, contribution
  completeness, grammar loading, semantic scopes, icon mappings, and provenance.
- `tests/languages.spec.ts` exercises every advertised provider in Chromium plus
  real code samples, painted colors, lazy/local loading, editing, file switching,
  and live syntax preferences.
- `scripts/smoke-language-coverage.ts` runs the production Electron build against
  a disposable Git project, checks icons and WASM/CSP, and captures normal files,
  both diff panes, added Vue, and TOML search results in
  `artifacts/language-coverage/`.
- `tests/yaml.spec.ts` and `scripts/smoke-yaml.ts` cover ordinary and Helm YAML,
  cold loads, both diff panes, green added files and search snippets/previews.
  The smoke uses a temporary Git project and captures `artifacts/yaml/`.
