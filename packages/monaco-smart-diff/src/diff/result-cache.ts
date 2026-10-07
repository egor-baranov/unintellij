import type { Comparison, DiffRequest } from './model';

interface Entry {
  original: string;
  modified: string;
  ignoreTrimWhitespace: boolean;
  maxComputationTimeMs: number;
  inputBytes: number;
  geometryItems: number;
  comparison: Comparison;
}

/** Reuse completed work across short-lived viewers, never their editors/workers.
 * Exact strings avoid hash collisions and preserve CRLF/Unicode distinctions.
 * The small LRU avoids constructing an additional concatenated content key. */
export class DiffResultCache {
  private entries: Entry[] = [];
  private inputBytes = 0;
  private geometryItems = 0;

  constructor(private readonly maximumEntries = 16, private readonly maximumInputBytes = 8 * 1024 * 1024,
    private readonly maximumGeometryItems = 50_000) {}

  private index(request: DiffRequest): number {
    return this.entries.findIndex(entry => entry.original === request.original && entry.modified === request.modified
      && entry.ignoreTrimWhitespace === request.ignoreTrimWhitespace && entry.maxComputationTimeMs === request.maxComputationTimeMs);
  }

  get(request: DiffRequest): Comparison | undefined {
    const index = this.index(request);
    if (index < 0) return;
    const [entry] = this.entries.splice(index, 1);
    this.entries.push(entry);
    // Public comparisons are mutable. Neither an old viewer nor a new consumer
    // may change the cached correspondence used by another viewer.
    return {
      ...structuredClone(entry.comparison), requestId: request.requestId,
      originalVersion: request.originalVersion, modifiedVersion: request.modifiedVersion,
    };
  }

  put(request: DiffRequest, comparison: Comparison): void {
    if (comparison.status !== 'complete' || comparison.requestId !== request.requestId
      || comparison.originalVersion !== request.originalVersion || comparison.modifiedVersion !== request.modifiedVersion) return;
    // UTF-16 code units conservatively account for both retained input strings.
    const inputBytes = (request.original.length + request.modified.length) * 2;
    // Fine-grained changes can have far more object overhead than their source
    // strings. Bound the retained result ranges independently as well.
    const geometryItems = comparison.unchanged.length + comparison.changes.reduce((count, change) => count + 1 + change.innerChanges.length, 0);
    if (inputBytes > this.maximumInputBytes || geometryItems > this.maximumGeometryItems || this.maximumEntries < 1) return;
    const index = this.index(request);
    if (index >= 0) this.remove(index);
    while (this.entries.length && (this.entries.length >= this.maximumEntries || this.inputBytes + inputBytes > this.maximumInputBytes
      || this.geometryItems + geometryItems > this.maximumGeometryItems)) {
      this.remove(0);
    }
    this.entries.push({
      original: request.original, modified: request.modified,
      ignoreTrimWhitespace: request.ignoreTrimWhitespace, maxComputationTimeMs: request.maxComputationTimeMs,
      inputBytes, geometryItems, comparison: structuredClone(comparison),
    });
    this.inputBytes += inputBytes;
    this.geometryItems += geometryItems;
  }

  private remove(index: number): void {
    const [entry] = this.entries.splice(index, 1);
    this.inputBytes -= entry.inputBytes;
    this.geometryItems -= entry.geometryItems;
  }

  clear(): void { this.entries = []; this.inputBytes = 0; this.geometryItems = 0; }
}

// Internal module singleton, intentionally absent from the package public API.
export const defaultDiffResultCache = new DiffResultCache();
