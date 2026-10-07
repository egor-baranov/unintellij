import { useCallback, useSyncExternalStore } from 'react';
import type { editor } from 'monaco-editor';
import { monaco } from '../monaco';
import { ProjectDiagnosticIndex } from './diagnostic-index';
import type { TreeNodeFacts } from './semantics';

const index = new ProjectDiagnosticIndex();
export function trackProjectDiagnostics(repositoryId: string, path: string, model: editor.ITextModel, facts?: TreeNodeFacts): () => void {
  const key = {};
  const barrier = diagnosticBarrier(facts);
  let disposed = false;
  const update = (analyzed: boolean) => {
    if (disposed) return;
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    index.update(key, repositoryId, path,
      analyzed ? markers.filter(marker => marker.severity === monaco.MarkerSeverity.Error).length : 0,
      analyzed ? markers.filter(marker => marker.severity === monaco.MarkerSeverity.Warning).length : 0,
      analyzed, barrier);
  };
  // No markers is not evidence that a provider has analyzed a model.
  update(monaco.editor.getModelMarkers({ resource: model.uri }).length > 0);
  const changed = monaco.editor.onDidChangeMarkers(resources => { if (resources.some(uri => uri.toString() === model.uri.toString())) update(true); });
  const content = model.onDidChangeContent(() => update(false));
  const cleanup = () => { if (disposed) return; disposed = true; changed.dispose(); content.dispose(); disposal.dispose(); index.remove(key); };
  const disposal = model.onWillDispose(cleanup);
  return cleanup;
}

export function diagnosticBarrier(facts?: TreeNodeFacts): string | undefined {
  // The closest independent boundary contains its own diagnostics.
  return [facts?.inclusion.state !== 'included' ? facts?.inclusion.rootPath : undefined,
    facts?.library?.rootPath, facts?.identity.repositoryRoot].filter((value): value is string => value !== undefined)
    .sort((a, b) => b.length - a.length)[0];
}

export function useTreeDiagnostics(repositoryId: string) {
  const revision = useSyncExternalStore(index.subscribe, index.snapshot, index.snapshot);
  return useCallback((facts: TreeNodeFacts) => facts.repositoryId === repositoryId ? index.resolve(facts) : facts, [repositoryId, revision]);
}
