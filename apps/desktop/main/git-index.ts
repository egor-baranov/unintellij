import { CompactPathSet, type TrackedPaths } from './compact-path-set';

/** Keep index enumeration bounded without retaining Git's complete stdout. */
export const MAX_GIT_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 1_000_000;
const MAX_INDEX_RECORD_BYTES = 64 * 1024;

export interface GitIndexSnapshot {
  tracked: TrackedPaths;
  submodules: Set<string>;
}

/** ls-files --stage -z records may cross pipe chunks, including inside UTF-8. */
export class GitIndexReader {
  private readonly tracked = new CompactPathSet();
  private readonly snapshot: GitIndexSnapshot = { tracked: this.tracked, submodules: new Set() };
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private entries = 0;

  constructor(private readonly validatePath: (filePath: string) => void) {}

  write(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (this.pendingBytes + part.length > MAX_INDEX_RECORD_BYTES) throw new Error('A Git index entry exceeds the filename safety limit.');
      if (end < 0) {
        this.pending.push(Buffer.from(part));
        this.pendingBytes += part.length;
        return;
      }
      const record = this.pendingBytes ? Buffer.concat([...this.pending, part], this.pendingBytes + part.length) : part;
      this.pending = [];
      this.pendingBytes = 0;
      if (++this.entries > MAX_INDEX_ENTRIES) throw new Error('The Git index exceeds the supported limit of 1,000,000 entries.');
      const text = this.decoder.decode(record);
      const match = /^([0-7]{6}) (?:[0-9a-f]{40}|[0-9a-f]{64}) [0-3]\t([\s\S]+)$/.exec(text);
      if (!match) throw new Error('Malformed Git index entry.');
      const [, mode, filePath] = match;
      this.validatePath(filePath);
      this.tracked.addUtf8(record.subarray(record.indexOf(9) + 1));
      if (mode === '160000') this.snapshot.submodules.add(filePath);
      start = end + 1;
    }
  }

  finish(): GitIndexSnapshot {
    if (this.pendingBytes) throw new Error('Incomplete Git index entry.');
    this.tracked.compact();
    return this.snapshot;
  }
}
