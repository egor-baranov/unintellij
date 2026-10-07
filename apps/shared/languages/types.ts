/** Browser-free subset of Monaco's language metadata, plus host filename aliases. */
export interface LanguageDefinition {
  id: string;
  extensions?: readonly string[];
  filenames?: readonly string[];
  aliases?: readonly string[];
  firstLine?: string;
  mimetypes?: readonly string[];
  /** For meaningful distinctions such as the conventional C++ suffix .C. */
  caseSensitiveExtensions?: readonly string[];
  /** Basename globs; only * has special meaning, and paths never participate. */
  filenamePatterns?: readonly string[];
}
