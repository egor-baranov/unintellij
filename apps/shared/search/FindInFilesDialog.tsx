import { useEffect, useId, useRef, useState, useSyncExternalStore, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Repository } from '../../desktop/src/bridge';
import { FileTypeIcon, JetBrainsIcon } from '../icons';
import { languageForPath, monaco } from '../monaco';
import { editorAppearance } from '../settings/runtime';
import { getSettings, subscribeSettings } from '../settings/store';
import { GroupDivider } from '../workspace/GroupDivider';
import { searchSummary } from './searchSummary';
import { HighlightedSnippet } from './HighlightedSnippet';
import { useDialogFrame } from './useDialogFrame';
import type { DialogGesture } from './dialogBounds';
import type { FileSearchClient, FileSearchResult, SearchDirectory } from './types';
import './find-in-files.css';

export interface FindInFilesViewProps {
  repository: Repository;
  client: FileSearchClient;
  initialQuery: string;
  onQueryChange: (query: string) => void;
  onOpenResult: (result: FileSearchResult) => void;
  /** Hidden/overlaid views retain their controls but own no running search. */
  active?: boolean;
}

interface FindInFilesDialogProps extends Omit<FindInFilesViewProps, 'active'> {
  onClose: () => void;
}

const rowLimit = 500;
const emptyCounts = { occurrences: 0, matchingLines: 0, files: 0, truncated: false };

/** A single preview editor is retained while selection changes; its old model is disposed. */
function SearchPreview({ result, query, repositoryId, client }: { result: FileSearchResult | null; query: string; repositoryId: string; client: FileSearchClient }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const [status, setStatus] = useState('Select a match to preview');
  const [loadedResult, setLoadedResult] = useState<FileSearchResult | null>(null);
  const desiredPreview = useRef({ result, query });
  desiredPreview.current = { result, query };
  const ready = result !== null && loadedResult === result;

  useEffect(() => {
    if (!host.current) return;
    const instance = monaco.editor.create(host.current, {
      ...editorAppearance(), model: null, readOnly: true, domReadOnly: true,
      automaticLayout: false, lineNumbers: 'on', lineNumbersMinChars: 3,
      glyphMargin: false, folding: false, scrollBeyondLastLine: false,
      minimap: { enabled: false }, stickyScroll: { enabled: false },
      renderValidationDecorations: 'off', overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true, selectionHighlight: false,
      occurrencesHighlight: 'off', ariaLabel: 'Code preview',
    });
    editor.current = instance;
    decorations.current = instance.createDecorationsCollection();
    const observer = new ResizeObserver(() => instance.layout());
    observer.observe(host.current);
    const unsubscribe = subscribeSettings(() => {
      instance.updateOptions({ ...editorAppearance(), minimap: { enabled: false }, stickyScroll: { enabled: false } });
      instance.layout();
    });
    return () => {
      unsubscribe(); observer.disconnect();
      const model = instance.getModel();
      instance.dispose(); model?.dispose();
      editor.current = null; decorations.current = null;
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    const instance = editor.current;
    setLoadedResult(null);
    const oldModel = instance?.getModel();
    instance?.setModel(null); oldModel?.dispose();
    if (!result) { setStatus('Select a match to preview'); return; }
    setStatus('Loading preview…');
    void client.readProjectFile(repositoryId, result.entry.id).then(file => {
      if (canceled || !instance || desiredPreview.current.result !== result || desiredPreview.current.query !== query) return;
      if (file.state !== 'text' || !file.content) {
        setStatus(file.state === 'unavailable' ? 'This file is no longer available for preview.' : file.message ?? 'This file is no longer available for preview.');
        return;
      }
      const model = monaco.editor.createModel(file.content.text, languageForPath(file.path, file.content.text.slice(0, 512)));
      if (result.lineNumber > model.getLineCount()) {
        model.dispose(); setStatus('This match is no longer in the file.'); return;
      }
      // A file may change between the streamed result and this read. Verify
      // source UTF-16 coordinates with the same literal Unicode case matching
      // as the backend, before revealing or decorating an unrelated position.
      const line = model.getLineContent(result.lineNumber);
      const literal = new RegExp(`^(?:${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`, 'iu');
      const validMatches = query.length > 0 && result.matches.length > 0 && result.matches.every(match => {
        const start = match.column - 1;
        return Number.isInteger(start) && Number.isInteger(match.length) && start >= 0 && match.length > 0
          && start + match.length <= line.length && literal.test(line.slice(start, start + match.length));
      });
      if (!validMatches) {
        model.dispose(); setStatus('This match is no longer in the file.'); return;
      }
      instance.setModel(model);
      instance.updateOptions({ ariaLabel: `Code preview: ${file.path}` });
      decorations.current?.set([
        { range: new monaco.Range(result.lineNumber, 1, result.lineNumber, 1), options: { isWholeLine: true, className: 'find-preview-line', marginClassName: 'find-preview-line' } },
        ...result.matches.map(match => ({
          range: new monaco.Range(result.lineNumber, match.column, result.lineNumber, match.column + match.length),
          options: { inlineClassName: 'find-preview-match', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
        })),
      ]);
      const first = result.matches[0];
      instance.setPosition({ lineNumber: result.lineNumber, column: first?.column ?? 1 });
      instance.layout();
      instance.revealRangeInCenter(new monaco.Range(result.lineNumber, first?.column ?? 1, result.lineNumber, (first?.column ?? 1) + (first?.length ?? 0)), monaco.editor.ScrollType.Immediate);
      setLoadedResult(result); setStatus('');
    }).catch(cause => {
      if (!canceled && desiredPreview.current.result === result && desiredPreview.current.query === query) setStatus(cause instanceof Error ? cause.message : 'Unable to load the preview.');
    });
    return () => { canceled = true; };
  }, [client, query, repositoryId, result]);

  return <section className="find-preview" aria-label="Selected file preview">
    <div className="find-preview-header">
      {result && <><FileTypeIcon path={result.entry.path} /><span className="find-preview-name">{result.entry.name}</span><span className="find-preview-directory" title={result.entry.path}>{result.entry.path.split('/').slice(0, -1).join('/')}</span></>}
    </div>
    <div className="find-preview-content">
      <div ref={host} className={`find-preview-editor${ready ? ' is-ready' : ''}`} />
      {!ready && <div className="find-preview-state" role="status">{status}</div>}
    </div>
  </section>;
}

function FindInFilesContent({ repository, client, initialQuery, onQueryChange, onOpenResult, active = true, onClose, headingProps, moveTitle }: FindInFilesViewProps & { onClose?: () => void; headingProps?: HTMLAttributes<HTMLElement>; moveTitle?: ReactNode }) {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const search = useRef<HTMLInputElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const wasActive = useRef(active);
  const currentRun = useRef<string | null>(null);
  const mounted = useRef(false);
  const pickerSequence = useRef(0);
  const selectedRow = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [splitRatio, setSplitRatio] = useState(.5);
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState<'project' | 'directory'>('project');
  const [directory, setDirectory] = useState<SearchDirectory | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [counts, setCounts] = useState(emptyCounts);
  const [phase, setPhase] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const headingId = useId();
  const listId = useId();
  const selected = results.find(result => result.id === selectedId) ?? null;

  function cancelCurrent() {
    const requestId = currentRun.current;
    currentRun.current = null;
    if (requestId) void client.cancelFileSearch(repository.id, requestId).catch(() => {});
  }
  function invalidate() {
    cancelCurrent();
    setResults([]); setSelectedId(null); setCounts(emptyCounts); setError('');
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; pickerSequence.current++;
    };
  }, []);

  useEffect(() => {
    if (active && !wasActive.current) setQuery(initialQuery);
    if (!active) { pickerSequence.current++; setChoosing(false); }
    wasActive.current = active;
  }, [active, initialQuery]);

  useEffect(() => {
    if (!active) return;
    return client.subscribeToFileSearch(batch => {
    if (!activeRef.current || batch.repositoryId !== repository.id || batch.requestId !== currentRun.current) return;
    setResults(previous => {
      const seen = new Set(previous.map(result => result.id));
      return [...previous, ...batch.results.filter(result => !seen.has(result.id))].slice(0, rowLimit);
    });
    setSelectedId(previous => previous ?? batch.results[0]?.id ?? null);
    setCounts({ occurrences: batch.occurrences, matchingLines: batch.matchingLines, files: batch.files, truncated: batch.truncated || batch.matchingLines > rowLimit });
    setError(batch.error ?? '');
    setPhase(batch.error ? 'error' : batch.done ? 'done' : 'searching');
    });
  }, [active, client, repository.id]);

  useEffect(() => {
    setResults([]); setSelectedId(null); setCounts(emptyCounts); setError('');
    if (!active || !query.length || (scope === 'directory' && !directory)) { setPhase('idle'); return; }
    setPhase('searching');
    const requestId = crypto.randomUUID();
    currentRun.current = requestId;
    const timeout = window.setTimeout(() => {
      if (!activeRef.current || currentRun.current !== requestId) return;
      void client.startFileSearch(repository.id, { requestId, query, ...(scope === 'directory' && directory ? { directoryId: directory.id } : {}) }).catch(cause => {
        if (!activeRef.current || currentRun.current !== requestId) return;
        setError(cause instanceof Error ? cause.message : 'Unable to search this project.'); setPhase('error');
      });
    }, 200);
    return () => {
      window.clearTimeout(timeout);
      if (currentRun.current === requestId) currentRun.current = null;
      void client.cancelFileSearch(repository.id, requestId).catch(() => {});
    };
  }, [active, client, directory, query, repository.id, scope]);

  useEffect(() => { selectedRow.current?.scrollIntoView({ block: 'nearest' }); }, [selectedId]);

  async function chooseDirectory() {
    if (!activeRef.current) return;
    const sequence = ++pickerSequence.current;
    setChoosing(true); setError('');
    try {
      const chosen = await client.chooseSearchDirectory(repository.id);
      if (!mounted.current || !activeRef.current || pickerSequence.current !== sequence) return;
      if (chosen) { invalidate(); setDirectory(chosen); }
    } catch (cause) {
      if (mounted.current && activeRef.current && pickerSequence.current === sequence) setError(cause instanceof Error ? cause.message : 'Unable to select this directory.');
    } finally {
      if (mounted.current && activeRef.current && pickerSequence.current === sequence) { setChoosing(false); search.current?.focus(); }
    }
  }
  function navigate(event: KeyboardEvent<HTMLInputElement | HTMLDivElement>) {
    if (event.key === 'Enter' && selected) { event.preventDefault(); event.stopPropagation(); onOpenResult(selected); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault(); event.stopPropagation();
    if (!results.length) return;
    const currentIndex = results.findIndex(result => result.id === selectedId);
    const next = Math.max(0, Math.min(results.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)));
    setSelectedId(results[next].id);
  }
  const summary = searchSummary(counts, phase);
  const quietState = error || (!query.length ? 'Type to search' : scope === 'directory' && !directory ? 'Choose a directory to search' : phase === 'searching' ? 'Searching…' : phase === 'done' ? counts.truncated ? 'No matches in searched files' : 'No matches' : '');

  return <section className="find-in-files-view" aria-labelledby={headingId} inert={!active}>
    <header className="find-dialog-heading" {...headingProps}>
      <h2 id={headingId}>{moveTitle ?? 'Find in Files'}</h2>
      <span className="find-result-count" aria-live="polite">{summary}</span>
      {onClose && <button type="button" className="find-close" aria-label="Close Find in Files" title="Close (Escape)" onClick={onClose}><JetBrainsIcon name="close" /></button>}
    </header>
    <div className="find-query-row">
      <JetBrainsIcon name="search" />
      <input ref={search} type="search" className="find-query" aria-label="Search text" aria-controls={listId} aria-activedescendant={selectedId ? `find-result-${selectedId}` : undefined} placeholder="Search text…" autoComplete="off" spellCheck={false} value={query} onKeyDown={navigate} onChange={event => {
        invalidate(); setQuery(event.target.value); onQueryChange(event.target.value);
      }} />
    </div>
    <div className="find-scope-row">
      <div className="find-scope-options" role="radiogroup" aria-label="Search scope">
        {(['project', 'directory'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={scope === value} className={scope === value ? 'is-selected' : ''} onClick={() => {
          if (value !== scope) { invalidate(); setScope(value); }
        }}>{value === 'project' ? 'Project' : 'Directory'}</button>)}
      </div>
      {scope === 'directory' && <><input className="find-directory-path" title={directory?.path} aria-label="Search directory" readOnly value={directory?.path ?? ''} placeholder="Choose a directory…" /><button type="button" className="find-directory-picker" aria-label="Choose search directory" title="Choose search directory" disabled={choosing} onClick={() => void chooseDirectory()}><JetBrainsIcon name="folder" /></button></>}
    </div>
    <div ref={body} className="find-dialog-body" style={{ gridTemplateRows: `minmax(0, ${splitRatio}fr) 5px minmax(0, ${1 - splitRatio}fr)` }}>
      <div className="find-results-region">
        <div className="find-result-list" id={listId} role="listbox" aria-label="Search results" aria-busy={phase === 'searching'} tabIndex={0} onKeyDown={navigate}>
          {results.map(result => <div key={result.id} id={`find-result-${result.id}`} ref={result.id === selectedId ? selectedRow : undefined} role="option" aria-selected={result.id === selectedId} aria-label={`${result.relativePath}:${result.lineNumber} ${result.snippet}`} data-path={result.entry.path} data-line={result.lineNumber} className="find-result-row" onClick={() => setSelectedId(result.id)} onDoubleClick={() => onOpenResult(result)}>
            <span className="find-result-snippet" title={result.snippet}><HighlightedSnippet result={result} settings={settings} /></span>
            <span className="find-result-location" title={`${result.relativePath}:${result.lineNumber}`}>{result.relativePath}<span>:{result.lineNumber}</span></span>
          </div>)}
        </div>
        {!results.length && <div className={`find-quiet-state${error ? ' is-error' : ''}`} role="status">{quietState}</div>}
        {!!results.length && !!error && <div className="find-inline-error" role="status">{error}</div>}
      </div>
      <GroupDivider root={body} direction="down" ratio={splitRatio} onChange={setSplitRatio} label="Resize search results and preview" firstPaneLabel="results" />
      <SearchPreview result={active ? selected : null} query={query} repositoryId={repository.id} client={client} />
    </div>
  </section>;
}

/** The workspace's embedded search surface never takes focus on mount/resume. */
export function FindInFilesView(props: FindInFilesViewProps) {
  return <FindInFilesContent {...props} />;
}

/** Modal chrome/focus management wraps the same search view used by empty editors. */
export function FindInFilesDialog({ onClose, ...props }: FindInFilesDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useDialogFrame(dialog);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = dialog.current;
    modal?.showModal();
    const input = modal?.querySelector<HTMLInputElement>('.find-query');
    input?.focus(); input?.select();
    return () => {
      modal?.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  const headingTarget = (target: EventTarget) => target instanceof Element && !target.closest('button:not(.find-dialog-move-title)');
  return createPortal(<dialog ref={dialog} className={`find-in-files-dialog${frame.gesture ? ` is-transforming gesture-${frame.gesture}` : ''}`} style={frame.bounds} aria-label="Find in Files"
    onPointerMove={frame.move} onPointerUp={frame.end} onPointerCancel={frame.end} onLostPointerCapture={frame.end}
    onCancel={event => { event.preventDefault(); if (frame.gesture) frame.cancel(); else onClose(); }} onKeyDown={event => {
    // Monaco consumes its own keys before the modal receives them.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (frame.gesture) frame.cancel(); else onClose(); }
  }}><FindInFilesContent {...props} onClose={onClose} headingProps={{
    onPointerDown: event => { if (headingTarget(event.target)) frame.begin(event, 'move'); },
    onDoubleClick: event => { if (headingTarget(event.target)) frame.reset(); },
  }} moveTitle={<button type="button" className="find-dialog-move-title" aria-label="Move Find in Files" title="Drag to move; arrow keys move; double-click or Enter resets" onKeyDown={event => frame.keyDown(event, 'move')}>Find in Files</button>} />
    {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const).map((direction: Exclude<DialogGesture, 'move'>) => direction === 'se'
      ? <button key={direction} type="button" className="find-dialog-resize" data-resize-direction={direction} aria-label="Resize Find in Files" title="Drag to resize; arrow keys resize; Enter resets"
        onPointerDown={event => frame.begin(event, direction)} onKeyDown={event => frame.keyDown(event, 'se')} />
      : <div key={direction} className="find-dialog-resize" data-resize-direction={direction} aria-hidden="true" onPointerDown={event => frame.begin(event, direction)} />)}
  </dialog>, document.body);
}
