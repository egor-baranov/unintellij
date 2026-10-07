import type { FileComparison, ProjectFile } from './bridge';

type Content = FileComparison | ProjectFile;

/** An estimate of retained text storage, independent of file encoding on disk.
 * Use UTF-16's upper bound rather than assuming V8's one-byte string encoding. */
export function contentBytes(content: Content): number {
  const sides = 'changeId' in content ? [content.original, content.modified] : [content.content];
  return 1024 + sides.reduce((bytes, side) => bytes + (side?.text.length ?? 0) * 2, 0);
}

/** Warm text endpoints only; Monaco models and undo stacks are never cached here.
 * Dirty/in-flight buffers protect their last readable comparison. Their storage
 * is deliberate draft state and is not charged against the clean-cache budget. */
export class TabContentCache {
  private readonly entries = new Map<string, { value: Content; bytes: number }>();

  constructor(
    private readonly protectedContent: (content: Content) => boolean,
    private readonly maximumBytes = 24 * 1024 * 1024,
    private readonly maximumEntries = 64,
  ) {}

  get size(): number { return this.entries.size; }
  get retainedBytes(): number { return [...this.entries.values()].reduce((bytes, entry) => bytes + entry.bytes, 0); }

  get(id: string): Content | undefined {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id); this.entries.set(id, entry);
    return entry.value;
  }

  set(id: string, value: Content): void {
    this.entries.delete(id);
    if (value.state === 'text') this.entries.set(id, { value, bytes: contentBytes(value) });
    this.prune();
  }

  delete(id: string): void { this.entries.delete(id); }

  invalidate(predicate: (content: Content) => boolean): void {
    for (const [id, entry] of this.entries) if (predicate(entry.value)) this.entries.delete(id);
  }

  prune(): void {
    const clean = [...this.entries].filter(([, entry]) => !this.protectedContent(entry.value));
    let bytes = clean.reduce((total, [, entry]) => total + entry.bytes, 0), count = clean.length;
    for (const [id, entry] of clean) {
      if (bytes <= this.maximumBytes && count <= this.maximumEntries) break;
      this.entries.delete(id); bytes -= entry.bytes; count--;
    }
  }
}
