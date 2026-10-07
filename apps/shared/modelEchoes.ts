const normalized = (text: string) => text.replace(/\r\n|\r/g, '\n');

/** A React passive effect may acknowledge an older onChange after Monaco has
 * already accepted another keystroke. Acknowledge that echo without writing it
 * back into the model. Acknowledged values are removed, so a later explicit
 * reset to an older value remains an ordinary external source update. */
export class ModelEchoes {
  private pending: string[] = [];
  remember(text: string): void {
    this.pending.push(normalized(text));
    // Some consumers use onChange only as a notification and never echo it.
    // Retain a small React-update backlog instead of every document snapshot.
    if (this.pending.length > 32) this.pending.shift();
  }
  acknowledge(text: string): boolean {
    const index = this.pending.lastIndexOf(normalized(text));
    if (index < 0) return false;
    this.pending.splice(0, index + 1);
    return true;
  }
  clear(): void { this.pending = []; }
}
