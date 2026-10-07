import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { MediaContent, MediaSide } from './types';
import { initialMediaView, mediaViewChanged, trackMediaView, type MediaViewState, type MediaSideName as Side, type MediaZoom as Zoom, type MediaScrollPosition as ScrollPosition } from './viewState';
import './media.css';

export interface MediaSurfaceProps {
  path: string;
  original?: MediaSide;
  modified?: MediaSide;
  originalLabel?: string;
  modifiedLabel?: string;
  comparison?: boolean;
  /** Use the editor-tab instance ID to preserve independent split/tab positions. */
  stateKey?: string;
  restoreState?: MediaViewState;
}
const maxBytes = 100 * 1024 * 1024;
const mimeTypes: Record<MediaContent['kind'], ReadonlySet<string>> = {
  image: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/avif', 'image/svg+xml']),
  audio: new Set(['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/mp4']),
  video: new Set(['video/mp4', 'video/webm', 'video/ogg']),
};
const zoomSteps = [.05, .1, .125, .25, .5, .75, 1, 1.5, 2, 3, 4, 6, 8];
const imagePadding = 16;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function formatType(mimeType: string) {
  const names: Record<string, string> = { 'image/svg+xml': 'SVG', 'image/x-icon': 'ICO', 'audio/mpeg': 'MP3', 'audio/mp4': 'M4A' };
  return names[mimeType] ?? mimeType.split('/').at(-1)?.toUpperCase() ?? mimeType;
}

/** Bytes only: no caller-supplied URLs, embedded documents, or HTML execution. */
function mediaBlob(content: MediaContent): Blob {
  if (!mimeTypes[content.kind]?.has(content.mimeType)) throw new Error('This media format is not supported.');
  if (!Number.isInteger(content.bytes) || content.bytes <= 0 || content.bytes > maxBytes) throw new Error('Media previews require a nonempty file no larger than 100 MiB.');
  const expectedLength = Math.ceil(content.bytes / 3) * 4;
  if (content.base64.length !== expectedLength || content.base64.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content.base64)) throw new Error('The media content is incomplete or invalid. Refresh this file.');
  const decoded = atob(content.base64);
  if (decoded.length !== content.bytes) throw new Error('The media size does not match its contents. Refresh this file.');
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return new Blob([bytes], { type: content.mimeType });
}

function useMediaUrl(content?: MediaSide) {
  const source = useMemo(() => content && ({ kind: content.kind, mimeType: content.mimeType, base64: content.base64, bytes: content.bytes }), [content?.kind, content?.mimeType, content?.base64, content?.bytes]);
  const [result, setResult] = useState<{ source?: MediaContent; url?: string; error?: string }>({});
  useEffect(() => {
    if (!source) { setResult({}); return; }
    let url: string | undefined;
    try { url = URL.createObjectURL(mediaBlob(source)); setResult({ source, url }); }
    catch (cause) { setResult({ source, error: cause instanceof Error ? cause.message : 'Unable to load the media preview.' }); }
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [source]);
  return result.source === source ? result : {};
}

interface MediaPaneProps {
  path: string; side: Side; label: string; content?: MediaSide; zoom: Zoom; checkerboard: boolean; showLabel: boolean;
  initialScroll: ScrollPosition; onScroll: (side: Side, position: ScrollPosition) => void; onFitScale: (side: Side, scale: number) => void;
  onViewport: (side: Side, capture: (() => ScrollPosition | undefined) | undefined) => void;
}
function MediaPane({ path, side, label, content, zoom, checkerboard, showLabel, initialScroll, onScroll, onFitScale, onViewport }: MediaPaneProps) {
  const { url, error: sourceError } = useMediaUrl(content);
  const viewport = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLMediaElement | null>(null);
  const [size, setSize] = useState<{ source: string; width: number; height: number }>();
  const [duration, setDuration] = useState<{ source: string; seconds: number }>();
  const [decodeError, setDecodeError] = useState<{ source: string; message: string }>();
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const pan = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const previousLayout = useRef<{ source: string; scale: number; viewportWidth: number; viewportHeight: number } | undefined>(undefined);
  const dimensions = size?.source === url ? size : undefined;
  const error = sourceError ?? (decodeError?.source === url ? decodeError?.message : undefined);
  const imageReady = content?.kind === 'image' && dimensions;
  const imageCanScroll = Boolean(imageReady && !error);
  const imageCanScrollRef = useRef(imageCanScroll); imageCanScrollRef.current = imageCanScroll;
  const fittedScale = dimensions ? Math.min(1, Math.max(1, viewportSize.width - imagePadding * 2) / dimensions.width, Math.max(1, viewportSize.height - imagePadding * 2) / dimensions.height) : 1;
  const scale = zoom.mode === 'fit' ? fittedScale : zoom.scale;

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current;
    onViewport(side, () => element && imageCanScrollRef.current ? { left: element.scrollLeft, top: element.scrollTop } : undefined);
    return () => {
      // Scroll events can still be queued when a tab is closed or switched.
      // Capture the DOM before removal, ahead of the parent's passive cache save.
      if (element && imageCanScrollRef.current) onScroll(side, { left: element.scrollLeft, top: element.scrollTop });
      onViewport(side, undefined);
    };
  }, [onScroll, onViewport, side]);
  useEffect(() => { if (content?.kind === 'image' && dimensions) onFitScale(side, fittedScale); }, [content?.kind, dimensions, fittedScale, onFitScale, side]);
  useEffect(() => {
    const element = player.current;
    return () => { element?.pause(); };
  }, [url]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !dimensions || !url || content?.kind !== 'image') return;
    const previous = previousLayout.current;
    if (!previous || previous.source !== url) {
      element.scrollLeft = initialScroll.left;
      element.scrollTop = initialScroll.top;
    } else if (previous.scale !== scale) {
      const oldX = Math.max(imagePadding, (previous.viewportWidth - dimensions.width * previous.scale) / 2);
      const oldY = Math.max(imagePadding, (previous.viewportHeight - dimensions.height * previous.scale) / 2);
      const imageX = (element.scrollLeft + previous.viewportWidth / 2 - oldX) / previous.scale;
      const imageY = (element.scrollTop + previous.viewportHeight / 2 - oldY) / previous.scale;
      element.scrollLeft = imageX * scale + Math.max(imagePadding, (viewportSize.width - dimensions.width * scale) / 2) - viewportSize.width / 2;
      element.scrollTop = imageY * scale + Math.max(imagePadding, (viewportSize.height - dimensions.height * scale) / 2) - viewportSize.height / 2;
    }
    previousLayout.current = { source: url, scale, viewportWidth: viewportSize.width, viewportHeight: viewportSize.height };
  }, [content?.kind, dimensions, initialScroll.left, initialScroll.top, scale, url, viewportSize.height, viewportSize.width]);

  function startPan(event: PointerEvent<HTMLDivElement>) {
    const element = viewport.current;
    if (content?.kind !== 'image' || event.button !== 0 || !element || (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)) return;
    pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
    element.setPointerCapture(event.pointerId);
    element.dataset.panning = 'true';
    event.preventDefault();
  }
  function movePan(event: PointerEvent<HTMLDivElement>) {
    if (!pan.current || !viewport.current || pan.current.pointerId !== event.pointerId) return;
    viewport.current.scrollLeft = pan.current.left + pan.current.x - event.clientX;
    viewport.current.scrollTop = pan.current.top + pan.current.y - event.clientY;
  }
  function endPan() {
    pan.current = null;
    if (viewport.current) delete viewport.current.dataset.panning;
  }
  function metadata(element: HTMLMediaElement) {
    if (!url || element.currentSrc !== url) return;
    setDuration({ source: url, seconds: element.duration });
    if (element instanceof HTMLVideoElement && element.videoWidth && element.videoHeight) setSize({ source: url, width: element.videoWidth, height: element.videoHeight });
  }
  function decodeFailed(element: HTMLImageElement | HTMLMediaElement) {
    if (url && element.isConnected && element.getAttribute('src') === url) setDecodeError({ source: url, message: content?.kind === 'image' ? 'This image could not be decoded.' : `This browser could not decode the ${content?.kind ?? 'media'} file. Its codec may be unsupported.` });
  }
  const time = duration && duration.source === url ? formatDuration(duration.seconds) : '';
  const info = content ? [dimensions ? `${dimensions.width} × ${dimensions.height}` : '', time, Number.isFinite(content.bytes) && content.bytes >= 0 ? formatBytes(content.bytes) : '', typeof content.mimeType === 'string' ? formatType(content.mimeType) : ''].filter(Boolean).join(' · ') : '';

  return <section className="media-pane" data-media-side={side} aria-label={`${label} media`}>
    {showLabel && <header className="media-source-label">{label}</header>}
    <div ref={viewport} className={`media-viewport${content?.kind === 'image' ? ' is-image' : ''}${content?.kind === 'image' && checkerboard ? ' has-checkerboard' : ''}`} tabIndex={0}
      aria-label={`${label} preview`} onScroll={event => {
        // The loading/error placeholder has no overflow. Its automatic reset to
        // zero must not replace the image's reading position during a refresh.
        if (imageCanScroll) onScroll(side, { left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop });
      }}
      onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}>
      {!content ? <p className="media-empty">File does not exist</p> : error ? <p className="media-error" role="alert">{error}</p> : !url ? <p className="media-loading" role="status">Loading preview…</p>
        : content.kind === 'image' ? <div className="media-image-canvas" style={{ width: imageReady ? Math.max(viewportSize.width, dimensions.width * scale + imagePadding * 2) : '100%', height: imageReady ? Math.max(viewportSize.height, dimensions.height * scale + imagePadding * 2) : '100%' }}>
          <img key={url} src={url} alt={`${path} — ${label}`} draggable={false} style={{ width: imageReady ? dimensions.width * scale : undefined, height: imageReady ? dimensions.height * scale : undefined, visibility: imageReady ? 'visible' : 'hidden' }}
            onLoad={event => { const image = event.currentTarget; if (image.currentSrc === url && image.naturalWidth && image.naturalHeight) setSize({ source: url, width: image.naturalWidth, height: image.naturalHeight }); }} onError={event => decodeFailed(event.currentTarget)} />
          {!imageReady && <span className="media-loading" role="status">Loading image…</span>}
        </div>
          : <div className={`media-player media-player-${content.kind}`}>
            {content.kind === 'audio' ? <audio key={url} ref={element => { player.current = element; }} src={url} controls preload="metadata" aria-label={`${path} — ${label}`} onLoadedMetadata={event => metadata(event.currentTarget)} onError={event => decodeFailed(event.currentTarget)} />
              : <video key={url} ref={element => { player.current = element; }} src={url} controls preload="metadata" playsInline aria-label={`${path} — ${label}`} onLoadedMetadata={event => metadata(event.currentTarget)} onError={event => decodeFailed(event.currentTarget)} />}
          </div>}
    </div>
    {content && <footer className="media-metadata" data-testid="media-metadata" title={info}>{info}</footer>}
  </section>;
}

function MediaViewer({ path, original, modified, originalLabel, modifiedLabel, comparison = false, stateKey = path, restoreState }: MediaSurfaceProps) {
  const [view, setView] = useState(() => restoreState ? structuredClone(restoreState) : initialMediaView(stateKey));
  const current = useRef(view); current.current = view;
  const scroll = useRef(view.scroll);
  const viewports = useRef<Partial<Record<Side, () => ScrollPosition | undefined>>>({});
  const fitScales = useRef<Partial<Record<Side, number>>>({});
  const image = original?.kind === 'image' || modified?.kind === 'image';
  const paired = comparison;
  useEffect(() => trackMediaView(stateKey, () => ({ ...current.current, scroll: {
    original: viewports.current.original?.() ?? scroll.current.original,
    modified: viewports.current.modified?.() ?? scroll.current.modified,
  } })), [stateKey]);
  useEffect(mediaViewChanged, [view]);
  function zoomBy(direction: -1 | 1) {
    const values = (['original', 'modified'] as const).filter(side => (side === 'original' ? original : modified)?.kind === 'image').flatMap(side => fitScales.current[side] === undefined ? [] : [fitScales.current[side]!]);
    const scale = view.zoom.mode === 'scale' ? view.zoom.scale : values.length ? Math.min(...values) : 1;
    const next = direction > 0 ? zoomSteps.find(value => value > scale + .001) ?? 8 : [...zoomSteps].reverse().find(value => value < scale - .001) ?? .05;
    setView(value => ({ ...value, zoom: { mode: 'scale', scale: next } }));
  }
  const updateScroll = useCallback((side: Side, position: ScrollPosition) => { scroll.current = { ...scroll.current, [side]: position }; mediaViewChanged(); }, []);
  const updateViewport = useCallback((side: Side, capture: (() => ScrollPosition | undefined) | undefined) => { viewports.current[side] = capture; }, []);
  const updateFitScale = useCallback((side: Side, scale: number) => { fitScales.current[side] = scale; }, []);
  const pane = (side: Side, content: MediaSide | undefined, label: string) => <MediaPane key={side} path={path} side={side} content={content} label={label} zoom={view.zoom} checkerboard={view.checkerboard} showLabel={paired || (side === 'original' && !modified)}
    initialScroll={scroll.current[side]} onScroll={updateScroll} onFitScale={updateFitScale} onViewport={updateViewport} />;
  return <section className="media-surface" data-testid="media-surface" data-path={path} data-comparison={String(paired)} aria-label={`${path} media ${paired ? 'comparison' : 'preview'}`}>
    {image && <div className="media-toolbar" role="toolbar" aria-label="Image preview controls">
      <button type="button" aria-label="Fit image" title="Fit image" aria-pressed={view.zoom.mode === 'fit'} onClick={() => setView(value => ({ ...value, zoom: { mode: 'fit' } }))}>Fit</button>
      <button type="button" aria-label="Actual image size" title="Actual image size" aria-pressed={view.zoom.mode === 'scale' && view.zoom.scale === 1} onClick={() => setView(value => ({ ...value, zoom: { mode: 'scale', scale: 1 } }))}>100%</button>
      <span className="media-toolbar-divider" />
      <button type="button" className="media-icon-button" aria-label="Zoom out" title="Zoom out" disabled={view.zoom.mode === 'scale' && view.zoom.scale <= .05} onClick={() => zoomBy(-1)}>−</button>
      <span className="media-zoom-label" data-testid="image-zoom">{view.zoom.mode === 'fit' ? 'Fit' : `${Math.round(view.zoom.scale * 1000) / 10}%`}</span>
      <button type="button" className="media-icon-button" aria-label="Zoom in" title="Zoom in" disabled={view.zoom.mode === 'scale' && view.zoom.scale >= 8} onClick={() => zoomBy(1)}>+</button>
      <button type="button" className="media-checkerboard-toggle" aria-label="Show checkerboard" title="Show transparency checkerboard" aria-pressed={view.checkerboard} onClick={() => setView(value => ({ ...value, checkerboard: !value.checkerboard }))}><span aria-hidden="true" /></button>
    </div>}
    <div className={`media-panes${paired ? ' is-comparison' : ''}`}>
      {paired ? <>{pane('original', original, originalLabel ?? original?.label ?? 'Original')}{pane('modified', modified, modifiedLabel ?? modified?.label ?? 'Modified')}</>
        : modified ? pane('modified', modified, modifiedLabel ?? modified.label) : pane('original', original, originalLabel ?? original?.label ?? 'Original')}
    </div>
  </section>;
}

export function MediaSurface(props: MediaSurfaceProps) {
  return <MediaViewer key={props.stateKey ?? props.path} {...props} />;
}
