import type { FileComparison, ProjectFile } from './bridge';

interface TabReadTarget {
  repositoryId: string;
  documentId: string;
  kind: 'comparison' | 'file';
  capabilityId?: string;
  generation: number;
}

/** Split panes and rapid A → B → A navigation can request the same endpoints
 * while their first IPC read is still running. Share only that pending read;
 * a later call must still revalidate the working file through the backend. */
export class PendingComparisonReads {
  private readonly reads = new Map<string, Promise<FileComparison>>();

  read(repositoryId: string, changeId: string, load: () => Promise<FileComparison>): Promise<FileComparison> {
    const key = JSON.stringify([repositoryId, changeId]);
    const pending = this.reads.get(key);
    if (pending) return pending;
    const operation = load().finally(() => { if (this.reads.get(key) === operation) this.reads.delete(key); });
    this.reads.set(key, operation);
    return operation;
  }
}

/** A refreshed snapshot must not starve an unchanged comparison's pending read. */
export class PendingTabRead {
  private sequence = 0;
  private pendingKey?: string;

  begin(target: TabReadTarget): number | undefined {
    // Comparison capabilities identify their endpoints and survive unrelated
    // snapshots. Project capabilities identify paths, so those still reload on
    // every generation to discover clean-file writes and replacements.
    const key = JSON.stringify([target.repositoryId, target.documentId, target.capabilityId,
      target.kind === 'file' ? target.generation : null]);
    if (this.pendingKey === key) return;
    this.pendingKey = key;
    return ++this.sequence;
  }

  isCurrent(sequence: number): boolean { return sequence === this.sequence; }
  finish(sequence: number): boolean {
    if (!this.isCurrent(sequence)) return false;
    this.pendingKey = undefined;
    return true;
  }
  cancel(): void { this.sequence++; this.pendingKey = undefined; }
}

/** Reopening an unchanged comparison can display its verified endpoints immediately. */
export function initialTabContent(cached: FileComparison | ProjectFile | undefined, target: {
  repositoryId: string;
  path: string;
  kind: 'comparison' | 'file';
  changeId?: string;
}, preserveDraft: boolean): FileComparison | ProjectFile | undefined {
  if (!cached || cached.repositoryId !== target.repositoryId || cached.path !== target.path
    || ('changeId' in cached ? 'comparison' : 'file') !== target.kind) return;
  if (preserveDraft) return cached;
  // Project entry ids are not content versions. Only comparison capabilities
  // establish that the cached endpoints still match the latest snapshot.
  if ('changeId' in cached && cached.changeId === target.changeId) return cached;
}

/** A read completed against this same snapshot is reusable without a second
 * IPC roundtrip. A newer snapshot must still observe saves and external writes. */
export function verifiedComparisonContent(cached: FileComparison | ProjectFile | undefined, target: {
  repositoryId: string; path: string; kind: 'comparison' | 'file'; changeId?: string; generation: number;
}): FileComparison | undefined {
  const current = initialTabContent(cached, target, false);
  return current && 'changeId' in current && current.state === 'text' && current.generation === target.generation ? current : undefined;
}
