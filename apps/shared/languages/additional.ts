import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { additionalCatalog } from './additionalCatalog';
import type { LanguageDefinition } from './types';

/** These IDs are isolated from Monaco's providers; filename precedence selects
 * the existing provider when it already supports a format. No grammar loads here.
 */
export const additionalLanguageDefinitions: readonly LanguageDefinition[] = additionalCatalog
  .filter(item => !('embeddedIn' in item))
  .map(item => ({ ...item, aliases: [('displayName' in item ? item.displayName : undefined) ?? item.name] }));

export function registerAdditionalLanguages(monaco: typeof Monaco): Monaco.IDisposable[] {
  return additionalLanguageDefinitions.map(definition => {
    monaco.languages.register({ id: definition.id, aliases: [...(definition.aliases ?? [])] });
    return monaco.languages.registerTokensProviderFactory(definition.id, {
      create: async () => (await import('./textmate')).createTextmateProvider(definition.id),
    });
  });
}
