import { describe, expect, it } from 'vitest';
import { ProjectDiagnosticIndex } from './diagnostic-index';
import { defaultNodeFacts } from './semantics';

const node = (path: string, repository = 'one') => defaultNodeFacts(repository, path, path.endsWith('.json') ? 'file' : 'directory');
describe('project diagnostic reports', () => {
  it('aggregates real reports through unloaded ancestors, then clears independently of Git', () => {
    const store = new ProjectDiagnosticIndex(), key = {};
    expect(store.resolve(node('')).diagnostics.coverage).toBe('unknown');
    store.update(key, 'one', 'src/deep/file.json', 2, 1, true);
    expect(store.resolve(node('src')).diagnostics).toEqual({ errors: 0, warnings: 0, descendantErrors: 2, descendantWarnings: 1, coverage: 'open-files' });
    expect(store.resolve(node('src/deep/file.json')).diagnostics.errors).toBe(2);
    store.update(key, 'one', 'src/deep/file.json', 0, 0, true);
    expect(store.resolve(node('src')).diagnostics).toMatchObject({ descendantErrors: 0, coverage: 'open-files' });
    store.remove(key);
    expect(store.resolve(node('src')).diagnostics.coverage).toBe('unknown');
  });
  it('does not conflate project identity, sibling prefixes, or unknown analysis with clean', () => {
    const store = new ProjectDiagnosticIndex(), key = {};
    store.update(key, 'one', 'src/a.json', 1, 0, true);
    expect(store.resolve(node('src', 'two')).diagnostics.descendantErrors).toBe(0);
    expect(store.resolve(node('sr')).diagnostics.descendantErrors).toBe(0);
    store.update(key, 'one', 'src/a.json', 0, 0, false);
    expect(store.resolve(node('src')).diagnostics.coverage).toBe('unknown');
  });
  it('contains excluded/dependency errors at the exact subtree boundary', () => {
    const store = new ProjectDiagnosticIndex();
    store.update({}, 'one', 'node_modules/pkg/a.json', 1, 0, true, 'node_modules');
    expect(store.resolve(node('')).diagnostics.descendantErrors).toBe(0);
    expect(store.resolve(node('node_modules')).diagnostics.descendantErrors).toBe(1);
    expect(store.resolve(node('node_modules/pkg')).diagnostics.descendantErrors).toBe(1);
  });
  it('does not count multiple views of the same file twice and cleans subscriptions', () => {
    const store = new ProjectDiagnosticIndex(), first = {}, second = {};
    let notifications = 0;
    const stop = store.subscribe(() => notifications++);
    store.update(first, 'one', 'a.json', 2, 0, true);
    store.update(second, 'one', 'a.json', 2, 0, true);
    expect(store.resolve(node('')).diagnostics.descendantErrors).toBe(2);
    store.update(second, 'one', 'a.json', 0, 0, true);
    expect(store.resolve(node('')).diagnostics.descendantErrors).toBe(0);
    stop(); store.remove(second);
    expect(notifications).toBe(3);
  });
});
