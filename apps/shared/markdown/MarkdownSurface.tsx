import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import type { editor } from 'monaco-editor';
import { FileSurface, type FileSurfaceProps } from '../project/FileSurface';
import { monaco, languageForPath } from '../monaco';
import { subscribeSettings } from '../settings/store';
import { UiIcon } from '../ui';
import { GroupDivider } from '../workspace/GroupDivider';
import { renderMarkdown } from './render';
import { defaultMarkdownView, type MarkdownMode, type MarkdownViewState } from './viewState';
import './markdown.css';

export interface MarkdownActions {
  readImage(href: string): Promise<{ mimeType: string; base64: string; bytes: number }>;
  openLink(href: string): Promise<void>;
}

export interface MarkdownSurfaceProps extends FileSurfaceProps {
  markdownView?: MarkdownViewState;
  onMarkdownView?: (view: MarkdownViewState) => void;
  onModeChange?: (mode: MarkdownMode) => void;
  actions?: MarkdownActions;
}

/** One Monaco instance owns the draft and undo stack in all three layouts. */
export function MarkdownSurface({ markdownView, onMarkdownView, onModeChange, actions, ...fileProps }: MarkdownSurfaceProps) {
  const [view, setView] = useState(() => ({ ...defaultMarkdownView, ...markdownView }));
  const current = useRef(view);
  const callbacks = useRef({ onMarkdownView, onModeChange, onEditor: fileProps.onEditor });
  callbacks.current = { onMarkdownView, onModeChange, onEditor: fileProps.onEditor };
  const panes = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
  const [error, setError] = useState('');
  const owner = useRef<'code' | 'preview'>('code');
  const change = (patch: Partial<MarkdownViewState>) => {
    const next = { ...current.current, ...patch };
    current.current = next; setView(next); callbacks.current.onMarkdownView?.(next);
    if (patch.mode) { setError(''); callbacks.current.onModeChange?.(patch.mode); }
  };
  useEffect(() => { callbacks.current.onMarkdownView?.(current.current); callbacks.current.onModeChange?.(current.current.mode); }, []);
  const register = (value: editor.IStandaloneCodeEditor | null) => { setInstance(value); callbacks.current.onEditor?.(value); };
  return <section className="markdown-surface" data-mode={view.mode} aria-label={`Markdown: ${fileProps.path}`}
    onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's' && view.mode === 'preview' && fileProps.editable) {
        event.preventDefault(); fileProps.onSave?.();
      }
    }}>
    <div className="editor-toolbar markdown-toolbar" role="toolbar" aria-label="Markdown view">
      {view.mode === 'split' && <button type="button" className="ui-toolbar-icon" aria-label="Synchronize Markdown scrolling" title="Synchronize Markdown scrolling" aria-pressed={view.sync} onClick={() => change({ sync: !view.sync })}><UiIcon name="sync" /></button>}
      <span className="markdown-toolbar-spacer" />
      <div className="markdown-modes" role="group" aria-label="Markdown layout">
        {(['code', 'split', 'preview'] as const).map(mode => <button type="button" key={mode} aria-pressed={view.mode === mode}
          title={mode === 'code' ? 'Show code' : mode === 'preview' ? 'Show preview' : 'Show code and preview'} onClick={() => change({ mode })}>
          {mode === 'code' ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 4-4 4 4 4m6-8 4 4-4 4M9 2 7 14" /></svg> : <UiIcon name={mode === 'split' ? 'split' : 'eye'} />}
          <span>{mode === 'code' ? 'Code' : mode === 'split' ? 'Split' : 'Preview'}</span>
        </button>)}
      </div>
    </div>
    {error && <div className="notice markdown-link-error" role="alert"><span>{error}</span><button aria-label="Dismiss link error" onClick={() => setError('')}><UiIcon name="close" /></button></div>}
    <div ref={panes} className="markdown-panes" style={view.mode === 'split' ? { gridTemplateColumns: `minmax(0, ${view.ratio}fr) 1px minmax(0, ${1 - view.ratio}fr)` } : undefined}>
      <div className="markdown-code" hidden={view.mode === 'preview'} onWheelCapture={() => { owner.current = 'code'; }} onPointerDownCapture={() => { owner.current = 'code'; }} onFocusCapture={() => { owner.current = 'code'; }}>
        <FileSurface {...fileProps} onEditor={register} />
      </div>
      {view.mode === 'split' && <GroupDivider root={panes} direction="right" ratio={view.ratio} onChange={ratio => change({ ratio })} thickness={1} label="Resize Markdown split" firstPaneLabel="code" />}
      {view.mode !== 'code' && <MarkdownPreview text={fileProps.text} path={fileProps.path} editor={view.mode === 'split' && view.sync ? instance : null} actions={actions}
        initialScroll={current.current.scrollTop} owner={owner} onError={setError} onScroll={scrollTop => {
          current.current = { ...current.current, scrollTop }; callbacks.current.onMarkdownView?.(current.current);
        }} />}
    </div>
  </section>;
}

function fenceLanguage(name: string): string {
  const lower = name.toLowerCase();
  const definition = monaco.languages.getLanguages().find(language => language.id === lower || language.aliases?.some(alias => alias.toLowerCase() === lower));
  return definition?.id ?? languageForPath(`snippet.${lower}`);
}

// The resource/highlighting effects enhance this sanitized subtree. Unrelated
// editor registration, layout and settings renders must not replace its DOM.
const MarkdownDocument = memo(function MarkdownDocument({ html, element }: { html: string; element: RefObject<HTMLElement | null> }) {
  return <article className="markdown-document" ref={element} dangerouslySetInnerHTML={{ __html: html }} />;
});

function MarkdownPreview({ text, path, editor: instance, actions, initialScroll, owner, onScroll, onError }: {
  text: string; path: string; editor: editor.IStandaloneCodeEditor | null; actions?: MarkdownActions; initialScroll: number;
  owner: { current: 'code' | 'preview' }; onScroll: (top: number) => void; onError: (error: string) => void;
}) {
  const deferred = useDeferredValue(text);
  const html = useMemo(() => renderMarkdown(deferred), [deferred]);
  const viewport = useRef<HTMLDivElement>(null), article = useRef<HTMLElement>(null);
  const callbacks = useRef({ actions, onScroll, onError }); callbacks.current = { actions, onScroll, onError };
  const restore = useRef<number | undefined>(initialScroll);
  const fenceSources = useRef(new WeakMap<HTMLElement, string>());
  const imageCache = useRef(new Map<string, { url: string; bytes: number }>());
  const imagePath = useRef(path);
  const [theme, setTheme] = useState(0);
  useEffect(() => subscribeSettings(() => setTheme(value => value + 1)), []);
  useEffect(() => () => { imageCache.current.forEach(image => URL.revokeObjectURL(image.url)); imageCache.current.clear(); }, []);
  const restoreScroll = () => { if (restore.current !== undefined && viewport.current) viewport.current.scrollTop = restore.current; };
  useLayoutEffect(() => {
    restoreScroll();
    // A saved offset may initially exceed the document's height until images
    // acquire dimensions. Keep the requested position until resources settle.
    const observer = new ResizeObserver(restoreScroll);
    if (article.current) observer.observe(article.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = article.current;
    if (!element) return;
    let cancelled = false;
    // Colorize with the same lazy language providers and theme as the editor.
    // Large fences stay readable plain text without creating extra editor models.
    for (const code of [...element.querySelectorAll<HTMLElement>('pre > code[data-markdown-language]')].slice(0, 40)) {
      const source = fenceSources.current.get(code) ?? code.textContent ?? '', language = fenceLanguage(code.dataset.markdownLanguage ?? '');
      fenceSources.current.set(code, source);
      if (source.length > 50_000 || language === 'plaintext') continue;
      void monaco.editor.colorize(source, language, { tabSize: 4 }).then(value => { if (!cancelled && code.isConnected) code.innerHTML = value; }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [html, theme]);
  useEffect(() => {
    const element = article.current;
    if (!element) return;
    let cancelled = false;
    let settleFrame = 0;
    if (imagePath.current !== path) {
      imageCache.current.forEach(image => URL.revokeObjectURL(image.url)); imageCache.current.clear(); imagePath.current = path;
      for (const img of element.querySelectorAll('img[data-markdown-src]')) { img.removeAttribute('src'); img.classList.remove('is-loaded', 'is-unavailable'); }
    }
    const images = [...element.querySelectorAll<HTMLImageElement>('img[data-markdown-src]')];
    // Resolve at most two project images concurrently. Reuse loaded images while
    // typing instead of reading/decoding the same bytes on every keystroke.
    const pending = images.slice(0, 32);
    const needed = new Set(pending.map(img => img.dataset.markdownSrc));
    for (const [href, image] of imageCache.current) if (!needed.has(href)) { URL.revokeObjectURL(image.url); imageCache.current.delete(href); }
    let totalBytes = [...imageCache.current.values()].reduce((sum, image) => sum + image.bytes, 0);
    const display = async (img: HTMLImageElement, url: string) => {
      // The bounded queue owns loading. Decode offscreen images too so restored
      // reading positions can use their real dimensions without scrolling first.
      img.loading = 'eager'; img.src = url; img.classList.add('is-loaded');
      await img.decode().catch(() => {});
    };
    const load = async () => {
      while (!cancelled && pending.length) {
        const img = pending.shift()!, href = img.dataset.markdownSrc!;
        try {
          const cached = imageCache.current.get(href);
          if (cached) { await display(img, cached.url); continue; }
          if (!callbacks.current.actions) throw new Error('Image preview unavailable');
          const image = await callbacks.current.actions.readImage(href);
          if (cancelled) break;
          const reused = imageCache.current.get(href);
          if (reused) { await display(img, reused.url); continue; }
          totalBytes += image.bytes;
          if (totalBytes > 32 * 1024 * 1024) throw new Error('Preview image budget exceeded');
          const bytes = Uint8Array.from(atob(image.base64), value => value.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
          imageCache.current.set(href, { url, bytes: image.bytes }); await display(img, url);
        } catch {
          if (!cancelled) { img.classList.add('is-unavailable'); img.title = `Image unavailable: ${href}`; }
        }
      }
    };
    void Promise.all([load(), load()]).then(() => {
      if (cancelled) return;
      settleFrame = requestAnimationFrame(() => {
        restoreScroll(); restore.current = undefined;
        if (viewport.current) callbacks.current.onScroll(viewport.current.scrollTop);
      });
    });
    return () => { cancelled = true; cancelAnimationFrame(settleFrame); };
  }, [html, path]);
  useEffect(() => {
    const pane = viewport.current, content = article.current;
    if (!instance || !pane || !content) return;
    let frame = 0;
    const anchors = () => [...content.querySelectorAll<HTMLElement>('[data-source-line]')].map(element => ({
      source: instance.getTopForLineNumber(Math.min(instance.getModel()?.getLineCount() ?? 1, Number(element.dataset.sourceLine))),
      preview: element.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop,
    })).filter((anchor, index, all) => index === 0 || anchor.source > all[index - 1].source);
    const map = (position: number, from: 'source' | 'preview', to: 'source' | 'preview') => {
      if (position <= 0) return 0;
      const points = [{ source: 0, preview: 0 }, ...anchors(), { source: Math.max(0, instance.getScrollHeight() - instance.getLayoutInfo().height), preview: Math.max(0, pane.scrollHeight - pane.clientHeight) }]
        .sort((a, b) => a[from] - b[from]);
      const end = points.findIndex(point => point[from] > position);
      const left = points[Math.max(0, end < 0 ? points.length - 1 : end - 1)], right = points[end < 0 ? points.length - 1 : end];
      return left[to] + (right[to] - left[to]) * Math.max(0, Math.min(1, (position - left[from]) / Math.max(1, right[from] - left[from])));
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        restore.current = undefined;
        if (owner.current === 'code') pane.scrollTop = map(instance.getScrollTop(), 'source', 'preview');
        else instance.setScrollTop(map(pane.scrollTop, 'preview', 'source'), 1);
      });
    };
    const subscription = instance.onDidScrollChange(event => { if (event.scrollTopChanged && owner.current === 'code') sync(); });
    const layout = instance.onDidLayoutChange(sync);
    const resize = new ResizeObserver(sync); resize.observe(content);
    const previewScroll = () => { if (owner.current === 'preview') sync(); };
    pane.addEventListener('scroll', previewScroll, { passive: true });
    sync();
    return () => { cancelAnimationFrame(frame); subscription.dispose(); layout.dispose(); resize.disconnect(); pane.removeEventListener('scroll', previewScroll); };
  }, [instance, html, owner]);
  const follow = (target: EventTarget | null) => {
    const link = target instanceof Element ? target.closest<HTMLElement>('[data-markdown-href]') : null;
    const href = link?.dataset.markdownHref;
    if (!href) return;
    if (href.startsWith('#')) {
      let id: string;
      try { id = decodeURIComponent(href.slice(1)); } catch { return; }
      const target = [...(article.current?.querySelectorAll<HTMLElement>('[id]') ?? [])].find(element => element.id === id);
      if (target && viewport.current) { owner.current = 'preview'; viewport.current.scrollTop += target.getBoundingClientRect().top - viewport.current.getBoundingClientRect().top - 16; }
      return;
    }
    void callbacks.current.actions?.openLink(href).catch(cause => callbacks.current.onError(cause instanceof Error ? cause.message : String(cause)));
  };
  const click = (event: MouseEvent) => { if ((event.target as Element).closest('[data-markdown-href]')) { event.preventDefault(); follow(event.target); } };
  const takeOwnership = () => { owner.current = 'preview'; restore.current = undefined; };
  return <div className="markdown-preview" ref={viewport} tabIndex={0} role="region" aria-label={`Markdown preview: ${path}`}
    onWheelCapture={takeOwnership} onPointerDownCapture={takeOwnership} onFocusCapture={takeOwnership}
    onScroll={event => { if (restore.current === undefined) callbacks.current.onScroll(event.currentTarget.scrollTop); }}
    onClick={click} onKeyDown={event => { if (event.key === 'Enter' && (event.target as Element).closest('[data-markdown-href]')) { event.preventDefault(); follow(event.target); } }}>
    <MarkdownDocument html={html} element={article} />
  </div>;
}
