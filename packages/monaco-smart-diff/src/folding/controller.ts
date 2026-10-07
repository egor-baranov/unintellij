import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { Comparison, Side } from '../diff/model';
import type { UnchangedRegionOptions } from '../types';
import type { CodeEditor } from '../rendering/geometry';
import { collapsedSeparatorRowHeightPx } from '../rendering/omission';
import { HiddenAreasAdapter } from '../compatibility/monaco';
import { deriveCollapsedRegions, type CollapsedRegion } from './regions';

interface OmissionControl { button: HTMLButtonElement; height: number }
interface OmissionPair { region: CollapsedRegion; original: OmissionControl; modified: OmissionControl }
export interface OmissionPosition { button: HTMLButtonElement; top: number; height: number; baseline: number; viewportHeight: number }
export interface RenderedOmission { region: CollapsedRegion; original: OmissionPosition; modified: OmissionPosition }
const sides = ['original', 'modified'] as const;
// Monaco coerces zone ordinals to signed int32. Keep our zone last at its
// rendered anchor, after ordinary consumer/alignment zones (default 10000).
const omissionOrdinal = 0x7fffffff;

export class FoldingController {
  private adapters: Record<Side, HiddenAreasAdapter>;
  private zones: Record<Side, string[]> = { original: [], modified: [] };
  private pairs: OmissionPair[] = [];
  private expanded = new Set<string>();
  private applied?: { comparison: Comparison | undefined; options: UnchangedRegionOptions; expanded: Set<string> };
  private generation = 0;
  constructor(private editors: Record<Side, CodeEditor>, private monaco: typeof Monaco,
    private onExpand: (id: string) => void, private onGeometryChange: () => void) {
    this.adapters = { original: new HiddenAreasAdapter(editors.original), modified: new HiddenAreasAdapter(editors.modified) };
  }
  get available(): boolean { return this.adapters.original.available && this.adapters.modified.available; }
  getExpanded(): string[] { return [...this.expanded]; }
  setExpanded(ids: string[]): void {
    const expanded = new Set(ids);
    if (expanded.size === this.expanded.size && [...expanded].every(id => this.expanded.has(id))) return;
    this.expanded = expanded;
  }
  expand(id: string): void {
    if (!this.expanded.has(id)) this.expanded = new Set([...this.expanded, id]);
  }
  apply(comparison: Comparison | undefined, options: UnchangedRegionOptions): void {
    const applied = this.applied;
    // Monaco repositions existing hidden ranges and anchored zones when widths
    // or wrapping change. Preserve their controls until the canonical folds
    // change instead of unhiding/rebuilding the document during every resize.
    if (applied && applied.comparison === comparison && applied.expanded === this.expanded
      && applied.options.collapse === options.collapse && applied.options.contextLines === options.contextLines
      && applied.options.minimumHiddenLines === options.minimumHiddenLines) return;
    this.clear();
    this.applied = { comparison, options: { ...options }, expanded: this.expanded };
    if (!comparison || !options.collapse || !this.available) return;
    let collapsed = deriveCollapsedRegions(comparison, options).filter(r => !this.expanded.has(r.id));
    // Monaco cannot hide every model line. At context=0, e.g. an EOF addition,
    // leave the first canonical pair visible instead of painting a phantom
    // fold at a position where the requested hidden area was never applied.
    if (sides.some(side => collapsed.reduce((count, region) => count + region[side].end - region[side].start, 0)
      >= (this.editors[side].getModel()?.getLineCount() ?? Infinity))) collapsed = collapsed.slice(1);
    for (const side of sides) {
      if (!this.adapters[side].set(collapsed.map(r => r[side]))) { this.clear(); return; }
    }
    const generation = this.generation;
    this.pairs = collapsed.map(region => {
      const control = (side: Side): OmissionControl => {
        const button = document.createElement('button');
        button.className = 'smart-diff-omission'; button.type = 'button'; button.hidden = true;
        button.style.height = `${collapsedSeparatorRowHeightPx}px`;
        const label = `${region.hiddenLineCount} unchanged lines`;
        button.setAttribute('aria-label', `Expand ${label}`);
        button.title = `Expand ${label} in both panes`;
        button.dataset.regionId = region.id; button.dataset.side = side;
        button.addEventListener('click', () => this.onExpand(region.id));
        button.addEventListener('wheel', event => {
          event.preventDefault();
          const editor = this.editors[side];
          editor.setScrollPosition({ scrollTop: editor.getScrollTop() + event.deltaY, scrollLeft: editor.getScrollLeft() + event.deltaX }, 1);
        }, { passive: false });
        // Monaco's zone layer is aria-hidden. Only the transparent hit target
        // lives here; all three visual segments belong to the shared SVG.
        this.editors[side].getContainerDomNode().append(button);
        return { button, height: collapsedSeparatorRowHeightPx };
      };
      return { region, original: control('original'), modified: control('modified') };
    });
    for (const side of sides) {
      this.editors[side].changeViewZones(accessor => {
        for (const pair of this.pairs) {
          const control = pair[side];
          let lastTop: number | undefined;
          this.zones[side].push(accessor.addZone({
            afterLineNumber: pair.region[side].start - 1, ordinal: omissionOrdinal,
            heightInPx: collapsedSeparatorRowHeightPx, domNode: document.createElement('div'), showInHiddenAreas: true,
            onComputedHeight: height => {
              if (generation !== this.generation || height === control.height) return;
              control.height = height; this.onGeometryChange();
            },
            onDomNodeTop: top => {
              if (generation !== this.generation || top === lastTop) return;
              lastTop = top;
              // This callback emits a sentinel for offscreen zones. It is an
              // invalidation signal, never the source of a false endpoint.
              this.onGeometryChange();
            },
          }));
        }
      });
    }
    this.onGeometryChange();
  }

  /** Read both endpoints together, including offscreen ones. The first visible
   * line after the hidden range follows our last-at-anchor omission zone, so
   * its rendered top minus the actual zone height is the exact zone position.
   * This includes wrapped rows, hidden regions, padding and other view zones. */
  measure(): RenderedOmission[] {
    const measured: Record<Side, OmissionPosition[]> = { original: [], modified: [] };
    for (const side of sides) {
      let groupEnd = 0, trailingHeight = 0;
      for (let index = this.pairs.length - 1; index >= 0; index--) {
        const pair = this.pairs[index];
        const editor = this.editors[side], control = pair[side];
        // With context=0 an insertion/deletion can put two hidden ranges next
        // to each other in one model. Both zones then share a rendered anchor;
        // their stable insertion order determines the stacked omission rows.
        if (pair.region[side].end !== this.pairs[index + 1]?.region[side].start) {
          groupEnd = pair.region[side].end; trailingHeight = 0;
        }
        trailingHeight += control.height;
        const bottom = groupEnd <= (editor.getModel()?.getLineCount() ?? 0)
          ? editor.getTopForLineNumber(groupEnd) : this.documentBottom(editor);
        const top = bottom - trailingHeight - editor.getScrollTop();
        measured[side][index] = { button: control.button, top, height: control.height, baseline: top + control.height / 2, viewportHeight: editor.getLayoutInfo().height };
      }
    }
    return this.pairs.map((pair, index) => ({ region: pair.region, original: measured.original[index], modified: measured.modified[index] }));
  }

  /** A context=0 trailing fold has no following visible line. Monaco's content
   * height includes the rendered document and zones plus known scroll/padding
   * allowances; remove those allowances, without counting model lines. */
  private documentBottom(editor: CodeEditor): number {
    const option = this.monaco.editor.EditorOption, layout = editor.getLayoutInfo();
    const padding = editor.getOption(option.padding), scrollbar = editor.getOption(option.scrollbar);
    const beyond = editor.getOption(option.scrollBeyondLastLine);
    const extra = beyond ? Math.max(0, layout.height - editor.getOption(option.lineHeight) - padding.bottom)
      : !scrollbar.ignoreHorizontalScrollbarInContentHeight && scrollbar.horizontal !== 2 && editor.getContentWidth() > layout.contentWidth
        ? scrollbar.horizontalScrollbarSize : 0;
    return editor.getContentHeight() - extra - padding.bottom;
  }
  clear(): void {
    this.applied = undefined;
    this.generation++;
    for (const pair of this.pairs) for (const side of sides) pair[side].button.remove();
    this.pairs = [];
    for (const side of sides) {
      this.editors[side].changeViewZones(accessor => this.zones[side].forEach(id => accessor.removeZone(id)));
      this.zones[side] = [];
      this.adapters[side].clear();
    }
    this.onGeometryChange();
  }
  dispose(): void { this.clear(); }
}
