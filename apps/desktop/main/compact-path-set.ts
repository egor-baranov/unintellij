/** Minimal tracked-path collection used by project snapshots. */
export interface TrackedPaths extends Iterable<string> {
  readonly size: number;
  has(value: string): boolean;
  add(value: string): this;
}

const BLOCK_SIZE = 64;
const MAX_PATH_BYTES = 0xffff;
const INITIAL_BYTES = 64 * 1024;

function hashPath(value: Uint8Array): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value[index], 16777619);
  return hash >>> 0;
}

/** Insertion-ordered, exact UTF-8 set without a retained JS string per path.
 * Consecutive paths share a byte prefix; every 64th entry is a fresh anchor.
 * The typed lookup table is only an accelerator: every matching hash is checked
 * against the original bytes, including collisions. Input need not be sorted.
 */
export class CompactPathSet implements TrackedPaths {
  private data = Buffer.allocUnsafe(INITIAL_BYTES);
  private usedBytes = 0;
  private count = 0;
  private readonly blocks: number[] = [];
  private hashes = new Uint32Array(256);
  private ordinals = new Uint32Array(256);
  private readonly previous = Buffer.allocUnsafe(MAX_PATH_BYTES);
  private previousLength = 0;
  private readonly scratch = Buffer.allocUnsafe(MAX_PATH_BYTES);

  get size(): number { return this.count; }

  /** Backing storage, excluding the small object and block-offset array. */
  get storageBytes(): number {
    return this.data.byteLength + this.hashes.byteLength + this.ordinals.byteLength
      + this.previous.byteLength + this.scratch.byteLength;
  }

  has(value: string): boolean {
    const bytes = Buffer.from(value, 'utf8');
    return this.find(bytes, hashPath(bytes)) >= 0;
  }

  add(value: string): this {
    return this.addUtf8(Buffer.from(value, 'utf8'));
  }

  /** The Git reader has already decoded/validated these bytes. Copy only the
   * compressed suffix; never retain a view into a pipe's larger output chunk. */
  addUtf8(bytes: Buffer): this {
    if (bytes.length > MAX_PATH_BYTES) throw new Error('A tracked path exceeds the filename safety limit.');
    const hash = hashPath(bytes);
    if (this.find(bytes, hash) >= 0) return this;
    if ((this.count + 1) * 10 > this.ordinals.length * 7) this.growLookup();

    let prefix = 0;
    if (this.count % BLOCK_SIZE === 0) this.blocks.push(this.usedBytes);
    else {
      const end = Math.min(this.previousLength, bytes.length);
      while (prefix < end && this.previous[prefix] === bytes[prefix]) prefix++;
    }
    const suffix = bytes.length - prefix;
    const end = this.usedBytes + 4 + suffix;
    if (end > this.data.length) {
      const grown = Buffer.allocUnsafe(Math.max(end, this.data.length * 2));
      this.data.copy(grown, 0, 0, this.usedBytes);
      this.data = grown;
    }
    this.data.writeUInt16LE(prefix, this.usedBytes);
    this.data.writeUInt16LE(suffix, this.usedBytes + 2);
    bytes.copy(this.data, this.usedBytes + 4, prefix);
    this.usedBytes = end;
    bytes.copy(this.previous);
    this.previousLength = bytes.length;

    let slot = hash & (this.ordinals.length - 1);
    while (this.ordinals[slot]) slot = (slot + 1) & (this.ordinals.length - 1);
    this.hashes[slot] = hash;
    this.ordinals[slot] = ++this.count;
    return this;
  }

  /** Drop growth slack after a streamed scan, retaining a little room for the
   * staged-deletion paths subsequently added by projectGitSnapshot. */
  compact(): this {
    const length = this.usedBytes + 16 * 1024;
    if (length < this.data.length) {
      const compact = Buffer.allocUnsafe(length);
      this.data.copy(compact, 0, 0, this.usedBytes);
      this.data = compact;
    }
    return this;
  }

  *[Symbol.iterator](): IterableIterator<string> {
    const scratch = Buffer.allocUnsafe(MAX_PATH_BYTES);
    let offset = 0;
    for (let ordinal = 0; ordinal < this.count; ordinal++) {
      const prefix = this.data.readUInt16LE(offset);
      const suffix = this.data.readUInt16LE(offset + 2);
      this.data.copy(scratch, prefix, offset + 4, offset + 4 + suffix);
      offset += 4 + suffix;
      yield scratch.toString('utf8', 0, prefix + suffix);
    }
  }

  private find(bytes: Buffer, hash: number): number {
    let slot = hash & (this.ordinals.length - 1);
    while (this.ordinals[slot]) {
      const ordinal = this.ordinals[slot] - 1;
      if (this.hashes[slot] === hash && this.matches(ordinal, bytes)) return ordinal;
      slot = (slot + 1) & (this.ordinals.length - 1);
    }
    return -1;
  }

  private matches(ordinal: number, bytes: Buffer): boolean {
    const block = Math.floor(ordinal / BLOCK_SIZE);
    let offset = this.blocks[block];
    let length = 0;
    for (let index = block * BLOCK_SIZE; index <= ordinal; index++) {
      const prefix = this.data.readUInt16LE(offset);
      const suffix = this.data.readUInt16LE(offset + 2);
      this.data.copy(this.scratch, prefix, offset + 4, offset + 4 + suffix);
      offset += 4 + suffix;
      length = prefix + suffix;
    }
    return length === bytes.length && this.scratch.subarray(0, length).equals(bytes);
  }

  private growLookup(): void {
    const ordinals = new Uint32Array(this.ordinals.length * 2);
    const hashes = new Uint32Array(ordinals.length);
    for (let index = 0; index < this.ordinals.length; index++) {
      if (!this.ordinals[index]) continue;
      const hash = this.hashes[index];
      let slot = hash & (ordinals.length - 1);
      while (ordinals[slot]) slot = (slot + 1) & (ordinals.length - 1);
      ordinals[slot] = this.ordinals[index];
      hashes[slot] = hash;
    }
    this.ordinals = ordinals;
    this.hashes = hashes;
  }
}
