/** All line coordinates are one-based, half-open [start, end). Empty ranges
 * describe boundaries, including the boundary after the document's last line.
 * Columns are one-based UTF-16 offsets, matching Monaco's public Range API. */
export type Side = 'original' | 'modified';
export interface LineRange { start: number; end: number }
export interface CharacterRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
export interface Correspondence { original: LineRange; modified: LineRange }
export interface Change extends Correspondence {
  id: string;
  kind: 'insert' | 'delete' | 'replace';
  innerChanges: { original: CharacterRange; modified: CharacterRange }[];
}
export interface TextMetadata {
  /** EOL normalization is intentional; line-ending-only differences are metadata. */
  lineEndings: 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';
  hasFinalNewline: boolean;
}
export interface Comparison {
  requestId: number;
  originalVersion: number;
  modifiedVersion: number;
  changes: Change[];
  unchanged: Correspondence[];
  originalLineCount: number;
  modifiedLineCount: number;
  originalMetadata: TextMetadata;
  modifiedMetadata: TextMetadata;
  status: 'complete' | 'timeout';
  durationMs: number;
}
export interface DiffRequest {
  /** Monotonically increasing per viewer; also invalidates file-selection changes. */
  requestId: number;
  originalVersion: number;
  modifiedVersion: number;
  original: string;
  modified: string;
  ignoreTrimWhitespace: boolean;
  maxComputationTimeMs: number;
}
export type DiffResponse =
  | { type: 'result'; comparison: Comparison }
  | { type: 'error'; requestId: number; error: string };

export const oppositeSide = (side: Side): Side => side === 'original' ? 'modified' : 'original';
