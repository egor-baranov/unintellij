import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { Comparison, Side } from '../diff/model';
import { hunkSideGeometry, visibleLineGeometry, type CodeEditor, type HunkSideGeometry } from './geometry';
import { GUTTER_WIDTH } from './divider';
import { createRibbon } from './ribbon';
import { createOmissionSeparator, omissionIntersectsViewport, collapsedSeparatorStrokeWidthPx } from './omission';
import type { RenderedOmission } from '../folding/controller';

const SVG = 'http://www.w3.org/2000/svg';
const WIDTH = GUTTER_WIDTH;
const NUMBER_WIDTH = 48;
const BUFFER = 70;

/** Owned number columns plus one SVG surface for complete change ribbons.
 * Geometry is read before writing SVG; neither React nor Monaco DOM is involved. */
export class Gutter {
  readonly element = document.createElementNS(SVG, 'svg');
  /** Each path includes the empty-pane marker and central band. No seam,
   * separate stroke, extra layout height, or horizontal text-scroll transform. */
  readonly connectors = document.createElementNS(SVG, 'svg');
  private bands = document.createElementNS(SVG, 'g');
  private omissionLayer = document.createElementNS(SVG, 'g');
  private omissionPaths = new Map<string, SVGPathElement>();
  private omissionProvider: () => RenderedOmission[] = () => [];
  private numberLayers: Record<Side, SVGGElement> = {
    original: document.createElementNS(SVG, 'g'), modified: document.createElementNS(SVG, 'g'),
  };
  private comparison?: Comparison;
  private active?: string;
  private paths = new Map<string, SVGPathElement>();
  private numbers: Record<Side, Map<number, SVGTextElement>> = { original: new Map(), modified: new Map() };
  private frame = 0;
  private rendering = false;
  private disposed = false;
  private beforeDraw: () => void = () => {};

  constructor(private readonly editors: Record<Side, CodeEditor>, private readonly monaco: typeof Monaco) {
    this.element.classList.add('smart-diff-gutter');
    this.element.setAttribute('aria-hidden', 'true');
    this.element.setAttribute('preserveAspectRatio', 'none');
    this.element.append(this.numberLayers.original, this.numberLayers.modified);
    this.connectors.classList.add('smart-diff-connectors');
    this.connectors.setAttribute('aria-hidden', 'true');
    this.connectors.append(this.bands, this.omissionLayer);
  }
  setOmissionProvider(provider: () => RenderedOmission[]): void { this.omissionProvider = provider; }
  setBeforeDraw(callback: () => void): void { this.beforeDraw = callback; }
  update(comparison?: Comparison, active?: string): void {
    // Model replacement invalidates all old fold correspondence immediately,
    // even if the next animation frame/worker reply has not arrived yet.
    if (!comparison || comparison !== this.comparison) { this.omissionLayer.replaceChildren(); this.omissionPaths.clear(); }
    this.comparison = comparison; this.active = active; this.schedule();
  }
  schedule = (): void => {
    if (!this.disposed && !this.rendering && !this.frame) this.frame = requestAnimationFrame(this.flush);
  };
  /** One paint transaction: update the follower before measuring either pane,
   * flush Monaco's dirty views through its public API, then draw the overlay.
   * A resize already inside rAF uses this directly, avoiding a second frame.
   * Events raised by synchronization/rendering are consumed by this snapshot. */
  flush = (): void => {
    if (this.disposed || this.rendering) return;
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.rendering = true;
    try {
      this.beforeDraw();
      this.editors.original.render(); this.editors.modified.render();
      this.draw();
    } finally { this.rendering = false; }
  };

  private draw(): void {
    // No viewBox on the shared surface: local SVG units remain Monaco CSS px,
    // including under host CSS zoom/transforms. Its CTM maps those units to
    // screen CSS px before the ribbon helper snaps to actual device pixels.
    const overlayRect = this.connectors.getBoundingClientRect();
    const gutterRect = this.element.getBoundingClientRect();
    const transform = this.connectors.getScreenCTM();
    const scaleX = transform?.a || 1, scaleY = transform?.d || 1;
    const height = overlayRect.height / scaleY, width = overlayRect.width / scaleX;
    const gutterLeft = (gutterRect.left - overlayRect.left) / scaleX;
    const omissionPositions = this.comparison ? this.omissionProvider() : [];
    const paneOffsets = {
      original: (this.editors.original.getContainerDomNode().getBoundingClientRect().top - overlayRect.top) / scaleY,
      modified: (this.editors.modified.getContainerDomNode().getBoundingClientRect().top - overlayRect.top) / scaleY,
    };
    const omissions = omissionPositions.flatMap(pair => {
      const originalY = pair.original.baseline + paneOffsets.original, modifiedY = pair.modified.baseline + paneOffsets.modified;
      if (width < WIDTH || height <= 0 || !omissionIntersectsViewport(originalY, modifiedY, height)) return [];
      return [{ pair, geometry: createOmissionSeparator({ xStart: 0, xOriginalJoin: gutterLeft + NUMBER_WIDTH,
        xModifiedJoin: gutterLeft + WIDTH - NUMBER_WIDTH, xEnd: width, originalY, modifiedY }) }];
    });
    const geometries: { id: string; kind: string; original: HunkSideGeometry; modified: HunkSideGeometry }[] = [];
    for (const change of this.comparison?.changes ?? []) {
      const a = hunkSideGeometry(this.editors.original, change.original);
      const b = hunkSideGeometry(this.editors.modified, change.modified);
      if (Math.max(a.bottom, b.bottom) < -BUFFER || Math.min(a.top, b.top) > height + BUFFER) continue;
      // Keep real endpoints even when offscreen. The SVG viewport clips the
      // complete band, rather than creating a false hunk boundary at its edge.
      geometries.push({ id: change.id, kind: change.kind, original: a, modified: b });
    }
    const lines = { original: visibleLineGeometry(this.editors.original, BUFFER), modified: visibleLineGeometry(this.editors.modified, BUFFER) };
    const fonts = {
      original: this.editors.original.getOption(this.monaco.editor.EditorOption.fontInfo),
      modified: this.editors.modified.getOption(this.monaco.editor.EditorOption.fontInfo),
    };
    const digits = {
      original: String(this.editors.original.getModel()?.getLineCount() ?? 1).length,
      modified: String(this.editors.modified.getModel()?.getLineCount() ?? 1).length,
    };

    const ribbons = geometries.map(geometry => ({ geometry, ribbon: createRibbon({
      original: geometry.original, modified: geometry.modified, gutterLeft, viewportWidth: width,
      gutterWidth: WIDTH, numberWidth: NUMBER_WIDTH, devicePixelRatio: window.devicePixelRatio,
      screenOriginY: transform?.f ?? overlayRect.top, scaleY,
    }) }));

    this.element.setAttribute('viewBox', `0 0 ${WIDTH} ${Math.max(1, height)}`);
    // Controls and the one-path pair use the same snapshot in the same frame.
    // Transparent controls do not mask the wave or intercept code outside its
    // existing omission row. The shared SVG remains entirely pointer-inert.
    for (const pair of omissionPositions) for (const side of ['original', 'modified'] as const) {
      const { button, top, height: rowHeight, baseline, viewportHeight } = pair[side];
      button.style.top = `${top}px`; button.style.height = `${rowHeight}px`;
      button.dataset.baselineY = String(baseline);
      button.hidden = top + rowHeight < 0 || top > viewportHeight;
    }
    const visibleOmissions = new Set(omissions.map(({ pair }) => pair.region.id));
    for (const [id, path] of this.omissionPaths) if (!visibleOmissions.has(id)) { path.remove(); this.omissionPaths.delete(id); }
    for (const { pair, geometry } of omissions) {
      const { region } = pair;
      let path = this.omissionPaths.get(region.id);
      if (!path) {
        path = document.createElementNS(SVG, 'path'); path.classList.add('smart-diff-omission-path');
        path.dataset.regionId = region.id; path.setAttribute('stroke-width', String(collapsedSeparatorStrokeWidthPx));
        this.omissionLayer.append(path); this.omissionPaths.set(region.id, path);
      }
      for (const side of ['original', 'modified'] as const) {
        path.setAttribute(`data-${side}-y`, String(geometry[`${side}Y`]));
        path.setAttribute(`data-${side}-start`, String(region[side].start));
        path.setAttribute(`data-${side}-end`, String(region[side].end));
      }
      path.dataset.hiddenLineCount = String(region.hiddenLineCount);
      path.dataset.centerLeft = String(geometry.transitionStart); path.dataset.centerRight = String(geometry.transitionEnd);
      path.dataset.viewportWidth = String(width); path.dataset.viewportHeight = String(height);
      path.setAttribute('d', geometry.d);
    }
    const visible = new Set(geometries.map(g => g.id));
    for (const [id, path] of this.paths) if (!visible.has(id)) { path.remove(); this.paths.delete(id); }
    for (const { geometry, ribbon } of ribbons) {
      const { id, kind, original: a, modified: b } = geometry;
      let path = this.paths.get(id);
      if (!path) { path = document.createElementNS(SVG, 'path'); path.dataset.changeId = id; this.bands.append(path); this.paths.set(id, path); }
      const boundarySide = a.kind === 'boundary' ? 'original' : b.kind === 'boundary' ? 'modified' : undefined;
      path.setAttribute('class', `connector connector-${kind}${boundarySide ? ' smart-diff-boundary' : ''}${id === this.active ? ' connector-active' : ''}`);
      if (boundarySide) path.dataset.boundarySide = boundarySide;
      else delete path.dataset.boundarySide;
      for (const side of ['original', 'modified'] as const) {
        const range = geometry[side];
        path.setAttribute(`data-${side}-kind`, range.kind);
        path.setAttribute(`data-${side}-top`, String(range.top));
        path.setAttribute(`data-${side}-bottom`, String(range.bottom));
        path.setAttribute(`data-${side}-paint-top`, String(ribbon[side].top));
        path.setAttribute(`data-${side}-paint-bottom`, String(ribbon[side].bottom));
      }
      path.setAttribute('d', ribbon.d);
    }
    for (const side of ['original', 'modified'] as const) {
      const layer = this.numberLayers[side], font = fonts[side];
      layer.style.fontFamily = font.fontFamily;
      // Keep real five/six-digit numbers inside their cells in large models.
      const fittingSize = (NUMBER_WIDTH - 8) / (digits[side] * font.typicalHalfwidthCharacterWidth / font.fontSize);
      layer.style.fontSize = `${Math.min(14, font.fontSize * .875, fittingSize)}px`;
      const visibleNumbers = new Set(lines[side].map(line => line.lineNumber));
      for (const [line, node] of this.numbers[side]) if (!visibleNumbers.has(line)) { node.remove(); this.numbers[side].delete(line); }
      for (const line of lines[side]) {
        let node = this.numbers[side].get(line.lineNumber);
        if (!node) {
          node = document.createElementNS(SVG, 'text');
          node.classList.add('smart-diff-line-number');
          node.dataset.numberSide = side;
          node.dataset.lineNumber = String(line.lineNumber);
          node.textContent = String(line.lineNumber);
          node.setAttribute('x', String(side === 'original' ? NUMBER_WIDTH - 4 : WIDTH - 4));
          node.setAttribute('text-anchor', 'end');
          node.setAttribute('dominant-baseline', 'central');
          layer.append(node); this.numbers[side].set(line.lineNumber, node);
        }
        node.setAttribute('y', String(line.top + line.rowHeight / 2));
      }
    }
  }
  dispose(): void { this.disposed = true; cancelAnimationFrame(this.frame); this.paths.clear(); this.omissionPaths.clear(); this.numbers.original.clear(); this.numbers.modified.clear(); this.element.remove(); this.connectors.remove(); }
}
