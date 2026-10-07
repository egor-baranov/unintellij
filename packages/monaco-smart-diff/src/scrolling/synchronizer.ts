import type { Comparison, Side } from '../diff/model';
import { mapLine } from './mapping';
import { lineToY, yToLine, type CodeEditor } from '../rendering/geometry';

/** Input establishes ownership; programmatic follower events never claim it.
 * A synchronous write guard plus expected actual scroll position handles both
 * immediate and deferred Monaco scroll events without timer-based locks. */
export class ScrollSynchronizer {
  private owner: Side = 'original';
  private writing = 0;
  private enabled = true;
  private comparison?: Comparison;
  private expected: Partial<Record<Side, number>> = {};
  private cleanup: (() => void)[] = [];
  private pending = false;
  constructor(private editors: Record<Side, CodeEditor>, private onScroll: () => void) {
    for (const side of ['original','modified'] as const) {
      const node = editors[side].getContainerDomNode();
      const claim = () => { this.owner = side; delete this.expected[side]; };
      for (const event of ['wheel','pointerdown','keydown','touchstart']) {
        node.addEventListener(event, claim, {capture:true,passive:true});
        this.cleanup.push(() => node.removeEventListener(event,claim,true));
      }
      const sub = editors[side].onDidScrollChange(event => {
        const expected = this.expected[side];
        if (event.scrollTopChanged && !this.writing && this.enabled && side === this.owner
          && (expected === undefined || Math.abs(event.scrollTop-expected)>=1)) this.pending = true;
        this.onScroll();
      });
      this.cleanup.push(() => sub.dispose());
    }
  }
  setComparison(comparison?: Comparison): void { this.comparison = comparison; this.pending = false; }
  setEnabled(enabled: boolean): void {
    const reconcile = enabled && !this.enabled;
    this.enabled = enabled;
    if (!enabled) this.pending = false;
    if (reconcile) this.queue();
  }
  suspend<T>(action: () => T): T { this.writing++; try { return action(); } finally { this.writing--; } }
  queue(): void {
    this.pending = true; this.onScroll();
  }
  /** Called by the shared paint transaction, never in a separate rAF after
   * the gutter has already sampled the follower's previous scroll position. */
  flush(): void {
    if (!this.pending) return;
    this.pending = false; this.synchronize();
  }
  synchronize(): void {
    if (!this.enabled || !this.comparison) return;
    const source = this.editors[this.owner];
    const targetSide = this.owner === 'original' ? 'modified' : 'original';
    const target = this.editors[targetSide];
    const offset = Math.min(source.getLayoutInfo().height*.45, target.getLayoutInfo().height*.45);
    const sourceLine = yToLine(source,source.getScrollTop()+offset);
    const targetLine = mapLine(this.comparison,this.owner,sourceLine);
    const scrollTop = Math.max(0,Math.min(target.getScrollHeight()-target.getLayoutInfo().height,lineToY(target,targetLine)-offset));
    this.expected[targetSide] = scrollTop;
    this.suspend(() => target.setScrollTop(scrollTop,1));
    this.expected[targetSide] = target.getScrollTop();
  }
  dispose(): void { this.pending = false; this.cleanup.forEach(fn=>fn()); }
}
