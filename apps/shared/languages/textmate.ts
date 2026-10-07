import type { languages } from 'monaco-editor/esm/vs/editor/editor.api.js';
import { INITIAL, Registry, type IGrammar, type IRawGrammar, type StateStack } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import wasmUrl from 'vscode-oniguruma/release/onig.wasm?url';
import { additionalCatalog } from './additionalCatalog';
import { grammarImports } from './grammarImports';
import { textmateScopesToToken } from './textmateScopes';

const byId = new Map(additionalCatalog.map(item => [item.id as string, item]));
const byScope = new Map(additionalCatalog.map(item => [item.scopeName as string, item]));
// Upstream embedded includes still use these historical names. Preserve the
// requested scope in the returned grammar so TextMate can resolve that include.
const scopeAliases: Readonly<Record<string, string>> = { 'source.vue': 'text.html.vue', 'source.c++': 'source.cpp' };
const canonicalScope = (scope: string): string => Object.hasOwn(scopeAliases, scope) ? scopeAliases[scope] : scope;
let registryPromise: Promise<Registry> | undefined;

export async function loadTextmateGrammar(scope: string): Promise<IRawGrammar | null> {
  const canonical = canonicalScope(scope);
  const loader = Object.hasOwn(grammarImports, canonical) ? grammarImports[canonical] : undefined;
  if (!loader) return null;
  const grammar = (await loader()).default as IRawGrammar;
  return canonical === scope ? grammar : { ...grammar, scopeName: scope };
}

export function textmateInjections(scope: string): string[] {
  const parent = byScope.get(canonicalScope(scope));
  return parent ? additionalCatalog.filter(item => 'embeddedIn' in item && (item.embeddedIn as readonly string[]).includes(parent.name)).map(item => item.scopeName) : [];
}

function getRegistry(): Promise<Registry> {
  if (!registryPromise) {
    registryPromise = (async () => {
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error('Unable to load bundled syntax engine');
      await loadWASM(await response.arrayBuffer());
      return new Registry({
        onigLib: Promise.resolve({ createOnigScanner: patterns => new OnigScanner(patterns), createOnigString: value => new OnigString(value) }),
        loadGrammar: loadTextmateGrammar,
        getInjections: textmateInjections,
      });
    })();
    void registryPromise.catch(() => { registryPromise = undefined; });
  }
  return registryPromise;
}

class TokenState implements languages.IState {
  constructor(readonly stack: StateStack) {}
  clone(): TokenState { return this; } // TextMate stacks are immutable.
  equals(other: languages.IState): boolean { return other instanceof TokenState && this.stack.equals(other.stack); }
}

export async function createTextmateProvider(id: string): Promise<languages.TokensProvider> {
  const definition = byId.get(id);
  if (!definition) throw new Error(`Unknown syntax language: ${id}`);
  const registry = await getRegistry();
  const grammar = await registry.loadGrammar(definition.scopeName);
  if (!grammar) throw new Error(`Missing bundled grammar: ${definition.name}`);
  return createTextmateTokensProvider(grammar);
}

export function createTextmateTokensProvider(grammar: Pick<IGrammar, 'tokenizeLine'>): languages.TokensProvider {
  return {
    getInitialState: () => new TokenState(INITIAL),
    tokenize: (line, state) => {
      const stack = state instanceof TokenState ? state.stack : INITIAL;
      // Allow cold grammar compilation, then retry once from the original state.
      // TextMate checks this budget between matches; it cannot interrupt a regex.
      let result = grammar.tokenizeLine(line, stack, 500);
      if (result.stoppedEarly) result = grammar.tokenizeLine(line, stack, 500);
      if (result.stoppedEarly) return { tokens: [{ startIndex: 0, scopes: '' }], endState: new TokenState(stack) };
      const tokens: languages.IToken[] = [];
      for (const token of result.tokens) {
        const scopes = textmateScopesToToken(token.scopes);
        if (tokens.at(-1)?.scopes !== scopes) tokens.push({ startIndex: token.startIndex, scopes });
      }
      return { tokens, endState: new TokenState(result.ruleStack) };
    },
  };
}
