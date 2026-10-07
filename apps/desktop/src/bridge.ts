/** Serializable, intentionally narrow Electron bridge. Paths are display-only. */
import type { BranchClient } from '../../shared/branches/types';
import type { MediaSide } from '../../shared/media/types';
import type { FileSearchClient } from '../../shared/search/types';
import type { ProjectDecorationClient, TreeNodeFacts } from '../../shared/project/semantics';
import type { ApplicationActionId, ApplicationMenuState } from '../../shared/actions/contracts';
import type { ProfilerClient } from '../../shared/profiler/types';
export type ChangeGroup = 'staged' | 'unstaged' | 'untracked' | 'working';
export type FileState = 'text' | 'media' | 'binary' | 'oversized' | 'encoding' | 'conflicted' | 'submodule' | 'type-change' | 'symlink' | 'unavailable' | 'stale';

export interface Repository {
  id: string;
  name: string;
  path: string;
  /** Home-relative label provided by the main process; never an input path. */
  displayPath?: string;
  /** False for a local directory without a Git repository. Omission means Git. */
  gitAvailable?: boolean;
}

/** Display-only identity available before repository registration finishes. */
export interface WindowProject {
  name: string;
  path: string;
}

/** Recent locations are main-process capabilities; paths are display-only. */
export interface RecentProject {
  id: string;
  name: string;
  path: string;
  /** Home-relative label provided by the main process; never an input path. */
  displayPath?: string;
  lastOpenedAt: number;
}

export interface GitChange {
  id: string;
  path: string;
  oldPath?: string;
  group: ChangeGroup;
  status: string;
  unsupported?: FileState;
}

export interface RepositorySnapshot {
  repository: Repository;
  generation: number;
  changes: GitChange[];
  /** One comparison per path: HEAD-to-working, or the staged addition when absent on disk. */
  workingChanges?: GitChange[];
  /** Tracked changes are ready; the background scan is still finding untracked files. */
  untrackedPending?: boolean;
  /** An incomplete background scan failed; tracked changes remain usable. */
  untrackedError?: string;
}

export interface TextMetadata {
  bytes: number;
  encoding: 'utf-8' | 'utf-8-bom';
  lineEnding: 'LF' | 'CRLF' | 'CR' | 'mixed' | 'none';
  finalNewline: boolean;
}

export interface ComparisonSide {
  label: string;
  text: string;
  metadata: TextMetadata;
  /** Issued by an eligible working-tree read; never authorizes a renderer path. */
  editable?: { id: string; version: string };
  readOnlyReason?: string;
}

export interface SaveTextResult {
  repositoryId: string;
  path: string;
  state: 'saved' | 'stale' | 'unavailable' | 'symlink' | 'oversized' | 'encoding' | 'error';
  message?: string;
  /** Successful saves return the new capability version and on-disk metadata. */
  content?: ComparisonSide;
}

export interface FileComparison {
  repositoryId: string;
  changeId: string;
  generation: number;
  path: string;
  state: FileState;
  /** Derived from endpoint existence, not content length; present for text/media comparisons. */
  changeType?: 'added' | 'deleted' | 'modified';
  message?: string;
  original?: ComparisonSide;
  modified?: ComparisonSide;
  originalMedia?: MediaSide;
  modifiedMedia?: MediaSide;
  /** Labels remain available when a media comparison has an absent side. */
  originalLabel?: string;
  modifiedLabel?: string;
}

/** Main-process capabilities: names and paths are display-only, never IPC inputs. */
export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'symlink' | 'submodule';
  status?: string;
  facts?: TreeNodeFacts;
}

export interface ProjectDirectory {
  repositoryId: string;
  directoryId: string | null;
  path: string;
  entries: ProjectEntry[];
  truncated: boolean;
  generation?: number;
  facts?: TreeNodeFacts;
}

export interface ProjectFile {
  repositoryId: string;
  entryId: string;
  path: string;
  state: FileState;
  message?: string;
  content?: ComparisonSide;
  media?: MediaSide;
  facts?: TreeNodeFacts;
}

export interface MarkdownImage {
  mimeType: string;
  base64: string;
  bytes: number;
}

export type FileActionTarget = { kind: 'project' | 'change'; id: string };
export interface OpenApplication {
  /** Opaque capability issued for this target; never an executable path. */
  id: string;
  name: string;
  icon?: string;
  isDefault?: boolean;
}
export interface FileActionsInfo {
  path: string;
  absolutePath: string;
  source?: ProjectEntry;
  applications: OpenApplication[];
  unavailableReason?: string;
}

export type TreeActionTarget = { kind: 'project'; id: string | null } | { kind: 'change'; id: string } | { kind: 'change-directory'; changeId: string; path: string } | { kind: 'change-group'; changeIds: string[] };
export type TreeAction = { kind: 'add' } | { kind: 'remove' } | { kind: 'rename'; name: string } | { kind: 'create-file'; name: string } | { kind: 'create-directory'; name: string };
export interface TreeActionsInfo {
  path: string;
  parentPath: string;
  kind: ProjectEntry['kind'] | 'missing' | 'group';
  label?: string;
  fileCount?: number;
  addFileCount?: number;
  removeFileCount?: number;
  canAdd: boolean;
  canRemove: boolean;
  canRename: boolean;
  canCreate: boolean;
  addReason?: string;
  removeReason?: string;
  renameReason?: string;
  createReason?: string;
}
export interface TreeActionResult {
  repositoryId: string;
  path: string;
  previousPath?: string;
  entry?: ProjectEntry;
  remap?: { from: string; to: string; directory: boolean };
}

export interface DesktopBridge extends BranchClient, FileSearchClient, ProjectDecorationClient, ProfilerClient {
  subscribeToApplicationActions(callback: (action: ApplicationActionId) => void): () => void;
  updateApplicationMenuState(state: ApplicationMenuState): Promise<void>;
  performNativeEdit(action: 'undo' | 'redo'): Promise<void>;
  /** The native chooser opens a new window; the caller's repository stays unchanged. */
  chooseRepository(): Promise<RepositorySnapshot | null>;
  /** Native location dialog creates a new plain project directory and window. */
  createProject(): Promise<void>;
  /** Native destination dialog clones a validated remote and opens a new window. */
  cloneProject(url: string): Promise<void>;
  listRecentProjects(): Promise<RecentProject[]>;
  openRecentProject(id: string): Promise<void>;
  /** Returns this window's assigned repository, including after renderer reload. */
  getLastRepository(): Promise<RepositorySnapshot | null>;
  /** Resolves immediately, including while this project's first scan is pending. */
  getWindowProject(): Promise<WindowProject | null>;
  /** Stable across renderer reloads and app restarts; unique to this window. */
  getWindowSessionId(): Promise<string>;
  listChanges(repositoryId: string): Promise<RepositorySnapshot>;
  refreshRepository(repositoryId: string): Promise<RepositorySnapshot>;
  /** Focuses or creates a repository window without changing the caller. */
  activateRepository(repositoryId: string): Promise<RepositorySnapshot | null>;
  listOpenRepositories(): Promise<Repository[]>;
  subscribeToOpenRepositories(callback: (repositories: Repository[]) => void): () => void;
  readComparison(repositoryId: string, changeId: string): Promise<FileComparison>;
  listProjectDirectory(repositoryId: string, directoryId: string | null): Promise<ProjectDirectory>;
  readProjectFile(repositoryId: string, entryId: string): Promise<ProjectFile>;
  /** References are resolved relative to this issued project-file capability. */
  readMarkdownImage(repositoryId: string, entryId: string, href: string): Promise<MarkdownImage>;
  resolveMarkdownLink(repositoryId: string, entryId: string, href: string): Promise<ProjectEntry>;
  openMarkdownLink(url: string): Promise<void>;
  saveText(repositoryId: string, editId: string, version: string, text: string): Promise<SaveTextResult>;
  getFileActions(repositoryId: string, target: FileActionTarget): Promise<FileActionsInfo>;
  openFileIn(repositoryId: string, target: FileActionTarget, applicationId: string): Promise<void>;
  copyFilePath(repositoryId: string, target: TreeActionTarget, format: 'absolute' | 'relative'): Promise<void>;
  getTreeActions(repositoryId: string, target: TreeActionTarget): Promise<TreeActionsInfo>;
  performTreeAction(repositoryId: string, target: TreeActionTarget, action: TreeAction): Promise<TreeActionResult>;
  subscribeToRepositoryChanges(callback: (repositoryId: string) => void): () => void;
  subscribeToRepositorySnapshots(callback: (snapshot: RepositorySnapshot) => void): () => void;
  subscribeToRepositoryScanErrors(callback: (repositoryId: string, message: string) => void): () => void;
}

declare global {
  interface Window { desktop: DesktopBridge }
}
