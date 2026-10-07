import type { FileComparison, GitChange } from '../../desktop/src/bridge';
import type { CommitOptions } from '../commit/options';

export type BranchKind = 'local' | 'remote' | 'tag';
export interface GitBranch {
  /** Fully qualified ref, validated again in the main process. */
  ref: string;
  name: string;
  kind: BranchKind;
  oid: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  worktree?: string;
}
export interface BranchSnapshot {
  repositoryId: string;
  /** Hash of HEAD, refs, logical index contents and merge/rebase state. Operations reject stale snapshots. */
  token: string;
  current: string | null;
  head: string | null;
  unborn: boolean;
  branches: GitBranch[];
  remotes: string[];
  recent: string[];
  operation: 'merge' | 'rebase' | null;
  dirty: boolean;
  stagedCount: number;
  /** Absent on an older Electron main process during renderer hot reload. */
  selectedCommitSupported?: boolean;
}
export type BranchOperation =
  | { kind: 'checkout'; ref: string; smart?: boolean }
  | { kind: 'checkout-revision'; revision: string }
  | { kind: 'create'; name: string; startRef?: string; checkout: boolean }
  | { kind: 'rename'; ref: string; name: string; unsetUpstream?: boolean }
  | { kind: 'delete'; ref: string; force?: boolean }
  | { kind: 'fetch' }
  | { kind: 'update'; method: 'merge' | 'rebase' | 'ff-only'; ref?: string }
  | { kind: 'push'; ref?: string; remote?: string; setUpstream?: boolean }
  | { kind: 'merge'; ref: string }
  | { kind: 'rebase'; ref: string; checkout?: boolean }
  | { kind: 'abort' }
  | { kind: 'continue' }
  | { kind: 'commit'; message: string; amend: boolean; changeIds?: string[]; options?: CommitOptions }
  | { kind: 'checkout-update'; ref: string; method: 'merge' | 'rebase' | 'ff-only' };
export interface BranchOperationResult { snapshot: BranchSnapshot; message: string }
export interface BranchCommit { oid: string; subject: string; author: string; date: string; side: 'original' | 'modified' }
export interface BranchComparison {
  id: string;
  repositoryId: string;
  sourceRef: string;
  target: 'head' | 'working';
  swapped: boolean;
  originalLabel: string;
  modifiedLabel: string;
  changes: GitChange[];
  commits: BranchCommit[];
  truncated: boolean;
}
export interface BranchClient {
  listBranches(repositoryId: string): Promise<BranchSnapshot>;
  runBranchOperation(repositoryId: string, token: string, operation: BranchOperation): Promise<BranchOperationResult>;
  compareBranches(repositoryId: string, ref: string, target: 'head' | 'working', swap?: boolean): Promise<BranchComparison>;
  readBranchComparison(repositoryId: string, comparisonId: string, changeId: string): Promise<FileComparison>;
}
