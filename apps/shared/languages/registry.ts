import { monacoLanguageDefinitions } from './bundled';
import type { LanguageDefinition } from './types';

export { monacoLanguageDefinitions } from './bundled';
export type { LanguageDefinition } from './types';

/** Host overrides and aliases supplement, rather than replace, Monaco metadata. */
export const languageAliases: readonly LanguageDefinition[] = [
  { id: 'smart-diff-tsx', extensions: ['.tsx', '.jsx'], aliases: ['TSX', 'JSX'] },
  { id: 'starlark', extensions: ['.bzl', '.bazel'], filenames: ['BUILD', 'WORKSPACE'], aliases: ['Starlark', 'Bazel'] },
  { id: 'cpp', caseSensitiveExtensions: ['.C', '.H'], extensions: ['.c++', '.h++', '.ipp', '.inl', '.tpp'] },
  { id: 'objective-c', extensions: ['.mm'] },
  { id: 'python', extensions: ['.pyi'] },
  { id: 'javascript', extensions: ['.es'] },
  { id: 'json', extensions: ['.jsonc', '.geojson', '.ipynb', '.tfstate', '.tfstate.backup'], filenames: ['composer.lock', 'MODULE.bazel.lock', 'Pipfile.lock', 'flake.lock'] },
  { id: 'dockerfile', extensions: ['.containerfile'], filenames: ['Containerfile'], filenamePatterns: ['Dockerfile.*', 'Containerfile.*'] },
  { id: 'shell', extensions: ['.zsh', '.ksh'], filenames: ['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.zshrc', '.zprofile', '.zlogin', '.zlogout', '.profile'] },
  { id: 'ruby', extensions: ['.rake', '.ru'], filenames: ['Vagrantfile', 'Guardfile', 'Podfile', 'Fastfile', 'Appfile', 'Berksfile', 'Brewfile'] },
  { id: 'scala', extensions: ['.sbt'] },
  { id: 'yaml', filenames: ['.clang-format', '.clang-tidy'] },
  { id: 'xml', extensions: ['.xlf', '.xliff', '.rss', '.atom', '.plist', '.iml', '.pom', '.resx', '.resw', '.vcxproj', '.fsproj', '.vbproj', '.nuspec', '.xul'] },
  { id: 'ini', extensions: ['.cfg', '.cnf'], filenames: ['.npmrc'] },
];

// JSON uses Monaco's dedicated worker/provider, not a basic-language contribution.
export const jsonLanguageDefinition: LanguageDefinition = {
  id: 'json',
  extensions: ['.json', '.bowerrc', '.jshintrc', '.jscsrc', '.eslintrc', '.babelrc', '.har'],
  aliases: ['JSON', 'json'],
  mimetypes: ['application/json'],
};

export const applicationLanguageDefinitions: readonly LanguageDefinition[] = [
  ...languageAliases,
  jsonLanguageDefinition,
  ...monacoLanguageDefinitions.map((definition) => ({
    ...definition,
    // Monaco treats every basename "config" as INI and .gitattributes as INI,
    // even though neither association establishes that syntax. Leave those
    // names available to a dedicated grammar (or the plaintext fallback).
    filenames: definition.id === 'ini'
      ? definition.filenames?.filter((filename) => filename !== 'config' && filename !== '.gitattributes')
      : definition.filenames,
    // SVGZ is compressed binary data, even though Monaco lists it under XML.
    extensions: definition.extensions?.filter((extension) => extension !== '.svgz'),
  })),
];
