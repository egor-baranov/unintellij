import { withinProjectPath, type TreeNodeFacts } from './semantics';

interface Report { repositoryId: string; path: string; barrier?: string; errors: number; warnings: number; analyzed: boolean; sequence: number }
/** Open-file diagnostics only. Closing the last model removes its report; absence is unknown. */
export class ProjectDiagnosticIndex {
  private reports = new Map<object, Report>();
  private revision = 0;
  private sequence = 0;
  private listeners = new Set<() => void>();
  snapshot = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { this.revision++; for (const listener of this.listeners) listener(); }
  update(key: object, repositoryId: string, path: string, errors: number, warnings: number, analyzed: boolean, barrier?: string) {
    this.reports.set(key, { repositoryId, path, errors, warnings, analyzed, barrier, sequence: ++this.sequence }); this.emit();
  }
  remove(key: object) { if (this.reports.delete(key)) this.emit(); }
  resolve(facts: TreeNodeFacts): TreeNodeFacts {
    const files = new Map<string, Report>();
    for (const report of this.reports.values()) {
      if (report.repositoryId !== facts.repositoryId) continue;
      const previous = files.get(report.path);
      if (!previous || previous.sequence < report.sequence) files.set(report.path, report);
    }
    const diagnostics: TreeNodeFacts['diagnostics'] = { errors: 0, warnings: 0, descendantErrors: 0, descendantWarnings: 0, coverage: 'unknown' };
    for (const report of files.values()) {
      if (!report.analyzed || !withinProjectPath(report.path, facts.path)) continue;
      // Excluded reports remain visible inside that subtree, but cannot make
      // an ordinary project ancestor look broken because of dependency code.
      if (report.barrier !== undefined && !withinProjectPath(facts.path, report.barrier)) continue;
      diagnostics.coverage = 'open-files';
      if (report.path === facts.path) { diagnostics.errors += report.errors; diagnostics.warnings += report.warnings; }
      else { diagnostics.descendantErrors += report.errors; diagnostics.descendantWarnings += report.warnings; }
    }
    return { ...facts, diagnostics };
  }
}
