export const GUTTER_WIDTH = 152;
const MIN_PANE_WIDTH = 160;

export function splitBounds(width: number): { minimum: number; maximum: number } {
  // A hidden/unmounted container has no meaningful width yet.
  const available = Math.max(0, width - GUTTER_WIDTH);
  const minimum = width > 0 ? Math.max(.1, Math.min(.5, MIN_PANE_WIDTH / Math.max(1, available))) : .1;
  return { minimum, maximum: 1 - minimum };
}

export function clampSplitRatio(ratio: number, width: number, fallback = .5): number {
  const { minimum, maximum } = splitBounds(width);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(ratio) ? ratio : fallback));
}

/** A small owned hit area; the rest of the gutter remains non-interactive. */
export class SplitDivider {
  readonly element = document.createElement('div');
  private value: number;
  private drag?: { pointerId: number; startX: number; startRatio: number; available: number };
  private frame = 0;
  private pendingX?: number;
  private disposed = false;

  constructor(private root: HTMLElement, initial: number, private changed: (ratio: number) => void, private resized: () => void) {
    this.value = clampSplitRatio(initial, 0);
    this.element.className = 'smart-diff-divider';
    this.element.tabIndex = 0;
    this.element.setAttribute('role', 'separator');
    this.element.setAttribute('aria-label', 'Resize diff panes');
    this.element.setAttribute('aria-orientation', 'vertical');
    this.element.title = 'Drag to resize panes; double-click or press Enter to reset';
    this.element.addEventListener('pointerdown', this.pointerDown);
    this.element.addEventListener('pointermove', this.pointerMove);
    this.element.addEventListener('pointerup', this.pointerUp);
    this.element.addEventListener('pointercancel', this.pointerCancel);
    this.element.addEventListener('lostpointercapture', this.pointerCancel);
    this.element.addEventListener('keydown', this.keyDown);
    this.element.addEventListener('dblclick', this.reset);
    root.append(this.element);
    this.draw();
  }

  get ratio(): number { return this.value; }

  setRatio(value: number): boolean {
    const next = clampSplitRatio(value, this.root.clientWidth, this.value);
    if (Math.abs(next - this.value) < 1e-7) return false;
    this.value = next;
    this.draw();
    this.changed(next);
    return true;
  }

  layout(): void { this.setRatio(this.value); this.draw(); }

  private draw(): void {
    const { minimum, maximum } = splitBounds(this.root.clientWidth);
    this.root.style.gridTemplateColumns = `minmax(0, ${this.value}fr) ${GUTTER_WIDTH}px minmax(0, ${1 - this.value}fr)`;
    this.element.style.left = `calc((100% - ${GUTTER_WIDTH}px) * ${this.value} + ${GUTTER_WIDTH / 2}px)`;
    this.element.setAttribute('aria-valuemin', String(Math.round(minimum * 10000) / 100));
    this.element.setAttribute('aria-valuemax', String(Math.round(maximum * 10000) / 100));
    this.element.setAttribute('aria-valuenow', String(Math.round(this.value * 10000) / 100));
    this.element.setAttribute('aria-valuetext', `${Math.round(this.value * 100)}% original, ${Math.round((1 - this.value) * 100)}% modified`);
  }

  private moveTo(clientX: number): void {
    if (!this.drag || this.disposed) return;
    const next = this.drag.startRatio + (clientX - this.drag.startX) / Math.max(1, this.drag.available);
    if (this.setRatio(next)) this.resized();
  }

  private pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.drag) return;
    event.preventDefault();
    this.element.focus({ preventScroll: true });
    this.drag = { pointerId: event.pointerId, startX: event.clientX, startRatio: this.value, available: Math.max(1, this.root.clientWidth - GUTTER_WIDTH) };
    this.element.setPointerCapture(event.pointerId);
    this.root.classList.add('smart-diff-resizing');
  };
  private pointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.drag?.pointerId) return;
    this.pendingX = event.clientX;
    if (!this.frame) this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.pendingX !== undefined) this.moveTo(this.pendingX);
      this.pendingX = undefined;
    });
  };
  private pointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.drag?.pointerId) return;
    this.moveTo(event.clientX);
    this.endDrag();
  };
  private pointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.drag?.pointerId) this.endDrag();
  };
  private endDrag(): void {
    cancelAnimationFrame(this.frame); this.frame = 0; this.pendingX = undefined;
    const pointerId = this.drag?.pointerId;
    this.drag = undefined;
    this.root.classList.remove('smart-diff-resizing');
    if (pointerId !== undefined && this.element.hasPointerCapture(pointerId)) this.element.releasePointerCapture(pointerId);
  }
  private reset = (): void => { if (this.setRatio(.5)) this.resized(); };
  private keyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = event.shiftKey ? .1 : .02;
    const bounds = splitBounds(this.root.clientWidth);
    let ratio: number;
    switch (event.key) {
      case 'ArrowLeft': ratio = this.value - step; break;
      case 'ArrowRight': ratio = this.value + step; break;
      case 'Home': ratio = bounds.minimum; break;
      case 'End': ratio = bounds.maximum; break;
      case 'Enter': ratio = .5; break;
      case 'Escape': this.endDrag(); event.preventDefault(); return;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
    if (this.setRatio(ratio)) this.resized();
  };

  dispose(): void {
    this.disposed = true;
    this.endDrag();
    this.element.removeEventListener('pointerdown', this.pointerDown);
    this.element.removeEventListener('pointermove', this.pointerMove);
    this.element.removeEventListener('pointerup', this.pointerUp);
    this.element.removeEventListener('pointercancel', this.pointerCancel);
    this.element.removeEventListener('lostpointercapture', this.pointerCancel);
    this.element.removeEventListener('keydown', this.keyDown);
    this.element.removeEventListener('dblclick', this.reset);
    this.element.remove();
  }
}
