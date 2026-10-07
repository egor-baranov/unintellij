import type { FileSearchBatch } from './types';

export type SearchPhase = 'idle' | 'searching' | 'done' | 'error';

/** Counts describe the scanned subset until the backend completes without a cap. */
export function searchSummary(counts: Pick<FileSearchBatch, 'occurrences' | 'files' | 'truncated'>, phase: SearchPhase): string {
  const incomplete = counts.truncated || phase === 'searching' || phase === 'error';
  if (counts.occurrences > 0) {
    const suffix = incomplete ? '+' : '';
    return `${counts.occurrences}${suffix} ${counts.occurrences === 1 && !incomplete ? 'match' : 'matches'} in ${counts.files}${suffix} ${counts.files === 1 && !incomplete ? 'file' : 'files'}`;
  }
  if (phase === 'searching') return 'Searching…';
  if (counts.truncated) return 'Search incomplete';
  if (phase === 'error') return 'Search failed';
  return phase === 'done' ? 'No matches' : '';
}
