import { languages } from 'monaco-editor/esm/vs/editor/editor.api.js';
import { monacoLanguageDefinitions } from './bundled';

// Keep Monaco's associations and configuration, with one lazy provider for both
// ordinary YAML and Helm actions. Competing asynchronous providers can otherwise
// replace each other when the first YAML model opens.
const definition = monacoLanguageDefinitions.find(item => item.id === 'yaml')!;
languages.register({ id: definition.id, extensions: [...(definition.extensions ?? [])],
  aliases: [...(definition.aliases ?? [])], mimetypes: [...(definition.mimetypes ?? [])] });
languages.registerTokensProviderFactory('yaml', {
  create: async () => {
    const { language, conf } = await import('./yaml');
    languages.setLanguageConfiguration('yaml', conf);
    return language;
  },
});
