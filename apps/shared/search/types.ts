import type { ProjectEntry, ProjectFile } from '../../desktop/src/bridge';

/** Only a native folder choice can issue a directory scope capability. */
export interface SearchDirectory { id: string; path: string }
export interface FileSearchRequest { requestId: string; query: string; directoryId?: string }
/** Columns and lengths use UTF-16 code units, matching Monaco, and are 1-based. */
export interface SearchOccurrence { column: number; length: number }
export interface FileSearchResult {
  id: string;
  entry: ProjectEntry;
  /** Path relative to the active project or selected directory. */
  relativePath: string;
  lineNumber: number;
  matches: SearchOccurrence[];
  snippet: string;
  snippetStartColumn: number;
}
export interface FileSearchBatch {
  repositoryId: string;
  requestId: string;
  results: FileSearchResult[];
  occurrences: number;
  matchingLines: number;
  files: number;
  done: boolean;
  truncated: boolean;
  error?: string;
}
export interface FileSearchClient {
  chooseSearchDirectory(repositoryId: string): Promise<SearchDirectory | null>;
  startFileSearch(repositoryId: string, request: FileSearchRequest): Promise<void>;
  cancelFileSearch(repositoryId: string, requestId: string): Promise<void>;
  subscribeToFileSearch(callback: (batch: FileSearchBatch) => void): () => void;
  readProjectFile(repositoryId: string, entryId: string): Promise<ProjectFile>;
}
