import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileComparison } from '../../desktop/src/bridge';
import type { ViewerPreferences } from '../DiffSurface';
import { FileTypeIcon } from '../icons';
import { UiIcon } from '../ui';
import { TabContent } from '../workspace/TabContent';
import type { BranchClient, BranchComparison } from './types';
import './comparison.css';

interface Props {
  comparison: BranchComparison;
  client: BranchClient;
  preferences: ViewerPreferences;
  onPreferences: (value: ViewerPreferences) => void;
  onReplace: (value: BranchComparison) => void;
  onClose: () => void;
  refreshToken?: number;
}

/** Uses the same viewer and file safety states as ordinary local Git changes. */
export function BranchComparisonPanel({ comparison, client, preferences, onPreferences, onReplace, onClose, refreshToken }: Props) {
  const [selectedPath, setSelectedPath] = useState(comparison.changes[0]?.path);
  const [content, setContent] = useState<FileComparison>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshNotice, setRefreshNotice] = useState<string>();
  const [list, setList] = useState<'files' | 'commits'>('files');
  const [width, setWidth] = useState(300);
  const latest = useRef({ comparison, client, onReplace }); latest.current = { comparison, client, onReplace };
  const queue = useRef<{ alive: boolean; running: boolean; epoch: number; pending?: { swap?: boolean } }>({ alive: true, running: false, epoch: 0 });
  const retry = useRef<{ attempts: number; timer?: ReturnType<typeof setTimeout> }>({ attempts: 0 });
  const selection = useRef<string | undefined>(undefined);
  const comparisonKey = JSON.stringify([comparison.repositoryId, comparison.sourceRef, comparison.target]);
  const change = comparison.changes.find(item => item.path === selectedPath) ?? comparison.changes[0];
  const documentId = JSON.stringify([comparisonKey, comparison.swapped, change?.path]);
  const reload = useCallback((swap?: boolean) => {
    const work = queue.current;
    if (!work.alive) return;
    // Preserve an explicitly requested swap if an automatic refresh arrives too.
    if (swap !== undefined || !work.pending) work.pending = { swap };
    if (work.running) return;
    work.running = true; setBusy(true); setError(undefined);
    void (async () => {
      try {
        while (work.alive && work.pending) {
          const request = work.pending; work.pending = undefined;
          const current = latest.current, epoch = work.epoch;
          const { repositoryId, sourceRef, target } = current.comparison;
          try {
            const next = await current.client.compareBranches(repositoryId, sourceRef, target, request.swap ?? current.comparison.swapped);
            const active = latest.current.comparison;
            if (!work.alive || work.epoch !== epoch || active.repositoryId !== repositoryId || active.sourceRef !== sourceRef || active.target !== target) continue;
            latest.current = { ...latest.current, comparison: next };
            latest.current.onReplace(next);
          } catch (cause) {
            const active = latest.current.comparison;
            if (work.alive && work.epoch === epoch && active.repositoryId === repositoryId && active.sourceRef === sourceRef && active.target === target) setError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      } finally { work.running = false; if (work.alive) setBusy(false); }
    })();
  }, []);
  useEffect(() => {
    const work = queue.current; work.alive = true;
    return () => { work.alive = false; work.epoch++; work.pending = undefined; clearTimeout(retry.current.timer); };
  }, []);
  const observedRefresh = useRef({ key: comparisonKey, token: refreshToken });
  useEffect(() => {
    const previous = observedRefresh.current;
    observedRefresh.current = { key: comparisonKey, token: refreshToken };
    if (previous.key !== comparisonKey) { queue.current.epoch++; queue.current.pending = undefined; }
    // Historical comparisons are immutable snapshots; only the working tree follows notifications.
    if (comparison.target === 'working' && previous.key === comparisonKey && previous.token !== refreshToken) reload();
  }, [comparisonKey, comparison.target, refreshToken, reload]);
  useEffect(() => {
    setSelectedPath(previous => comparison.changes.some(item => item.path === previous) ? previous : comparison.changes[0]?.path);
  }, [comparison.id, comparison.changes]);
  useEffect(() => {
    clearTimeout(retry.current.timer);
    if (selection.current !== documentId) {
      selection.current = documentId; retry.current.attempts = 0; setContent(undefined);
    }
    if (!change) { setContent(undefined); setLoading(false); return; }
    let active = true;
    setLoading(true); setError(undefined); setRefreshNotice(undefined);
    client.readBranchComparison(comparison.repositoryId, comparison.id, change.id)
      .then(value => {
        if (!active) return;
        if (value.state === 'stale' && comparison.target === 'working') {
          if (retry.current.attempts < 5) retry.current.timer = setTimeout(() => { retry.current.attempts++; reload(); }, Math.min(150 * 2 ** retry.current.attempts, 2000));
          else setRefreshNotice('This file is still changing. It will reload when changes settle.');
          return;
        }
        retry.current.attempts = 0;
        setContent(value);
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; clearTimeout(retry.current.timer); };
  }, [client, comparison.id, comparison.repositoryId, comparison.target, change?.id, documentId, reload]);
  return <section className="branch-comparison" aria-label="Branch comparison">
    <header className="branch-comparison-heading">
      <UiIcon name="branch" /><strong title={`${comparison.originalLabel} → ${comparison.modifiedLabel}`}>{comparison.originalLabel} <span>→</span> {comparison.modifiedLabel}</strong>
      <button className="chrome-text-button" aria-label="Swap comparison" disabled={busy} onClick={() => reload(!comparison.swapped)}><UiIcon name="sync" />Swap</button>
      <button className="chrome-icon-button" aria-label="Refresh branch comparison" disabled={busy} onClick={() => reload()}><UiIcon name="refresh" /></button>
      <span className="topbar-spacer" />
      <button className="chrome-icon-button" aria-label="Close branch comparison" title="Return to local files" onClick={onClose}><UiIcon name="close" /></button>
    </header>
    {busy && !content && <div className="notice" role="status">Loading branch comparison…</div>}
    {error && <div className="notice" role="alert">{error}<button onClick={() => reload()}>Refresh</button></div>}
    {comparison.truncated && <div className="notice" role="status">The commit list reached its display limit. File comparisons contain complete source text.</div>}
    <div className="branch-comparison-body">
      <aside className="branch-comparison-sidebar" style={{ width }}>
        <div className="branch-comparison-tabs" role="tablist" aria-label="Branch comparison lists">
          <button role="tab" aria-selected={list === 'files'} onClick={() => setList('files')}>Files <span>{comparison.changes.length}</span></button>
          <button role="tab" aria-selected={list === 'commits'} onClick={() => setList('commits')}>Commits <span>{comparison.commits.length}</span></button>
        </div>
        {list === 'files' ? <div className="branch-comparison-files" role="list" aria-label="Changed files between branches" onKeyDown={event => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
          if (!items.length) return;
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
          event.preventDefault(); items[next].focus(); items[next].click();
        }}>
          {comparison.changes.map(item => <div role="listitem" key={item.path}><button aria-label={item.path} aria-pressed={change?.path === item.path} className={`branch-comparison-file status-${item.status[0]}`} title={item.oldPath ? `${item.oldPath} → ${item.path}` : item.path} onClick={() => setSelectedPath(item.path)}><FileTypeIcon path={item.path} /><span>{item.path}</span><small>{item.status}</small></button></div>)}
          {!comparison.changes.length && <p className="branch-comparison-empty">No changed files</p>}
        </div> : <div className="branch-comparison-commits" role="list" aria-label="Commits unique to each side">
          {(['original', 'modified'] as const).map(side => <section key={side}>
            <h3>Only in {side === 'original' ? comparison.originalLabel : comparison.modifiedLabel}</h3>
            {comparison.commits.filter(commit => commit.side === side).map(commit => <div role="listitem" className="branch-comparison-commit" key={commit.oid} title={`${commit.oid}\n${commit.author}\n${commit.date}`}><span>{commit.subject}</span><small>{commit.oid.slice(0, 8)} · {commit.author}</small></div>)}
            {!comparison.commits.some(commit => commit.side === side) && <p className="branch-comparison-empty">No unique commits</p>}
          </section>)}
        </div>}
      </aside>
      <div className="branch-comparison-resizer" role="separator" tabIndex={0} aria-label="Resize branch comparison files" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={500} aria-valuenow={width}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(180, Math.min(500, event.clientX))); }}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(value => Math.max(180, Math.min(500, value + (event.key === 'ArrowLeft' ? -20 : 20)))); } }} />
      {change ? <TabContent key={documentId} tab={{ id: documentId, instanceId: documentId, path: change.path, kind: 'comparison', description: comparison.originalLabel }}
        content={selection.current === documentId ? content : undefined} originalPath={change.oldPath} loading={loading} error={content ? undefined : error} preferences={preferences} onPreferences={onPreferences} refreshNotice={refreshNotice} onRefresh={() => reload()} />
        : <div className="state-panel"><UiIcon name="success" size={28} /><h2>No differences</h2><p>The selected endpoints have identical file contents.</p></div>}
    </div>
  </section>;
}
