import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import './languages/contributions';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment';
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess';
import { installAppearance } from './settings/runtime';
import { tsxConfiguration, tsxLanguage, tsxLanguageId } from './tsx-language';
import { installMonacoCancellationHandler } from './monacoCancellation';
import { resolveLanguageForPath } from './languages/resolver';
import { registerAdditionalLanguages } from './languages/additional';
import { starlarkConfiguration, starlarkLanguage, starlarkLanguageId } from './starlark-language';

// Host-owned worker and theme configuration: the reusable package never changes globals.
self.MonacoEnvironment = { getWorker: (_moduleId, label) => label === 'json' ? new JsonWorker() : new EditorWorker() };
const disposeAppearance = installAppearance(monaco);
const disposeCancellationHandler = installMonacoCancellationHandler(self);
if (import.meta.hot) import.meta.hot.dispose(() => { disposeAppearance(); disposeCancellationHandler(); });
monaco.languages.register({ id: tsxLanguageId });
monaco.languages.setLanguageConfiguration(tsxLanguageId, tsxConfiguration);
monaco.languages.setMonarchTokensProvider(tsxLanguageId, tsxLanguage);
monaco.languages.register({ id: starlarkLanguageId, extensions: ['.bzl', '.bazel'], filenames: ['BUILD', 'WORKSPACE'], aliases: ['Starlark', 'Bazel'] });
monaco.languages.setLanguageConfiguration(starlarkLanguageId, starlarkConfiguration);
monaco.languages.setMonarchTokensProvider(starlarkLanguageId, starlarkLanguage);
const additionalProviders = registerAdditionalLanguages(monaco);
if (import.meta.hot) import.meta.hot.dispose(() => additionalProviders.forEach(provider => provider.dispose()));

export { monaco };
export function languageForPath(path: string, firstLine?: string): string {
  return resolveLanguageForPath(path, firstLine);
}
