import { describe, expect, it } from 'vitest';
import { searchSummary } from './searchSummary';

describe('Find in Files count summary', () => {
  it('counts occurrences rather than result rows, with exact totals only after completion', () => {
    expect(searchSummary({ occurrences: 5, files: 3, truncated: false }, 'done')).toBe('5 matches in 3 files');
    expect(searchSummary({ occurrences: 1, files: 1, truncated: false }, 'done')).toBe('1 match in 1 file');
    expect(searchSummary({ occurrences: 5, files: 3, truncated: false }, 'searching')).toBe('5+ matches in 3+ files');
  });

  it('marks capped and failed partial results as incomplete', () => {
    expect(searchSummary({ occurrences: 500, files: 8, truncated: true }, 'done')).toBe('500+ matches in 8+ files');
    expect(searchSummary({ occurrences: 1, files: 1, truncated: false }, 'error')).toBe('1+ matches in 1+ files');
  });

  it('never reports no matches when a capped scan did not cover all files', () => {
    const counts = { occurrences: 0, files: 0, truncated: false };
    expect(searchSummary(counts, 'idle')).toBe('');
    expect(searchSummary(counts, 'searching')).toBe('Searching…');
    expect(searchSummary(counts, 'done')).toBe('No matches');
    expect(searchSummary(counts, 'error')).toBe('Search failed');
    expect(searchSummary({ ...counts, truncated: true }, 'done')).toBe('Search incomplete');
  });
});
