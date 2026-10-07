import { languageForPath, monaco } from '../monaco';
import type { SnippetToken } from './snippetParts';
import type { FileSearchResult } from './types';

const languages = new Map<string, Promise<void>>();
const snippets = new WeakMap<FileSearchResult, Promise<readonly SnippetToken[]>>();

function prepareJson(): Promise<void> {
  const ready = () => monaco.editor.tokenize('{"key": 1}', 'json')[0]?.some(token => token.type);
  if (ready()) return Promise.resolve();
  // JSON installs its tokenizer asynchronously after the first model requests
  // the language. Its configuration event follows that installation. Await the
  // event, rather than racing the mode import or retaining a plain-text result.
  return new Promise<void>((resolve, reject) => {
    const model = monaco.editor.createModel('', 'json');
    const finish = (error?: Error) => {
      clearTimeout(timeout); subscription.dispose(); model.dispose();
      if (error) reject(error); else resolve();
    };
    const subscription = model.onDidChangeLanguageConfiguration(() => { if (ready()) finish(); });
    const timeout = setTimeout(() => finish(new Error('JSON tokenizer did not load')), 10000);
    if (ready()) finish();
  });
}

function prepareLanguage(language: string): Promise<void> {
  let ready = languages.get(language);
  if (!ready) {
    ready = (async () => {
      if (language === 'json') await prepareJson();
      // Unlike synchronous tokenize(), colorize waits for lazy language providers.
      // Discard its HTML: row content is always rendered as escaped React text.
      await monaco.editor.colorize('', language, {});
    })();
    languages.set(language, ready);
    void ready.catch(() => languages.delete(language));
  }
  return ready;
}

/** Cache only bounded snippets, independent of theme/selection; no per-row models. */
export function tokenizeSnippet(result: FileSearchResult): Promise<readonly SnippetToken[]> {
  let tokens = snippets.get(result);
  if (!tokens) {
    const language = languageForPath(result.entry.path);
    tokens = language === 'plaintext' ? Promise.resolve([]) : prepareLanguage(language)
      .then(() => monaco.editor.tokenize(result.snippet, language)[0] ?? []);
    snippets.set(result, tokens);
    void tokens.catch(() => snippets.delete(result));
  }
  return tokens;
}
