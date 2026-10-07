import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ancestorIds, buildChangeTree, checkState, flattenTree, isReviewed, reviewKey, toggleSelection, type ChangeFile, type ChangeNode } from './tree';
import { FileIcon, Icon } from './icons';
import { MenuButton } from '../ui/MenuButton';
import { DraftResizeHandle } from './DraftResizeHandle';
import { useFileActions } from '../files/FileActions';
import { CommitSettings } from './CommitSettings';
import { defaultCommitOptions, type CommitOptions, type CommitSubmission } from './options';
import { isGoTestFile } from '../project/fileClassification';
import './commit-panel.css';

export type { ChangeFile } from './tree';
export interface CommitPanelProps {
  files: ChangeFile[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  repositoryName?: string;
  repositoryKey?: string;
  onRefresh?: () => void;
  busy?: boolean;
  untrackedPending?: boolean;
  untrackedError?: string;
  scopeBackgrounds?: boolean;
  emptyMessage?: string;
  onCommitRequest?: (submission: CommitSubmission) => void;
}

function readStored(key: string): { selected: Set<string>; draft: string } {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!stored || typeof stored !== 'object') return { selected: new Set(), draft: '' };
    const value = stored as { selected?: unknown; draft?: unknown };
    return {
      selected: new Set(Array.isArray(value.selected) ? value.selected.filter((id): id is string => typeof id === 'string') : []),
      draft: typeof value.draft === 'string' ? value.draft : '',
    };
  } catch { return { selected: new Set(), draft: '' }; }
}
function persist(key: string, selected: ReadonlySet<string>, draft: string) {
  try { localStorage.setItem(key, JSON.stringify({ selected: [...selected], draft })); }
  catch { /* A restricted browser can still keep a draft for the current session. */ }
}

function readOptions(key: string): CommitOptions {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      author: typeof value?.author === 'string' ? value.author : '',
      signOff: value?.signOff === true,
      checkWhitespace: value?.checkWhitespace === true,
      checkTodo: value?.checkTodo === true,
    };
  } catch { return { ...defaultCommitOptions }; }
}

function ReviewCheckbox({ node, selected, onToggle }: { node: ChangeNode; selected: ReadonlySet<string>; onToggle: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const state = checkState(node.fileIds, selected);
  useEffect(() => { if (input.current) input.current.indeterminate = state === 'mixed'; }, [state]);
  return <input ref={input} className="commit-checkbox" type="checkbox" checked={state === 'true'} aria-checked={state}
    aria-label={`Include ${node.file?.path ?? node.label} in review`} tabIndex={-1}
    onClick={event => event.stopPropagation()} onChange={onToggle} />;
}

/** Selection and draft UI; the host performs the reviewed commit operation. */
export function CommitPanel({ files, selectedId, onSelect, repositoryName = 'Repository', repositoryKey = repositoryName,
  onRefresh, busy = false, untrackedPending = false, untrackedError, scopeBackgrounds = true, emptyMessage = 'No changes in this repository.', onCommitRequest }: CommitPanelProps) {
  const fileActions = useFileActions();
  const storageKey = `smart-diff:review:${repositoryKey}`;
  const [review, setReview] = useState(() => readStored(storageKey));
  const optionsKey = `smart-diff:commit-options:${repositoryKey}`;
  const [options, setOptions] = useState(() => readOptions(optionsKey));
  const tree = useMemo(() => buildChangeTree(files), [files]);
  const allRows = useMemo(() => flattenTree(tree), [tree]);
  const nodesById = useMemo(() => new Map(allRows.map(row => [row.node.id, row.node])), [allRows]);
  const [expanded, setExpanded] = useState(() => new Set(allRows.filter(row => row.node.kind === 'group').map(row => row.node.id)));
  const [focusedId, setFocusedId] = useState<string | undefined>();
  const [showFileCounts, setShowFileCounts] = useState(true);
  const [showDraft, setShowDraft] = useState(true);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const treeElement = useRef<HTMLDivElement>(null);
  const messageElement = useRef<HTMLTextAreaElement>(null);
  const draftId = useId();
  const visible = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);
  const selected = useMemo(() => new Set(files.filter(file => isReviewed(file, review.selected)).map(file => file.id)), [files, review.selected]);
  const canCommit = Boolean(onCommitRequest && !busy && selected.size && review.draft.trim());
  const activeRowId = focusedId && visible.some(row => row.node.id === focusedId) ? focusedId : visible[0]?.node.id;

  useEffect(() => {
    setReview(readStored(storageKey));
    setOptions(readOptions(optionsKey));
    setFocusedId(undefined);
  }, [storageKey, optionsKey]);

  useEffect(() => {
    // Expand newly appearing change groups after a refresh. Preserve existing folder choices.
    setExpanded(current => new Set([...current, ...allRows.filter(row => row.node.kind === 'group').map(row => row.node.id),
      ...ancestorIds(tree, `file:${selectedId}`)]));
  }, [tree, allRows, selectedId]);

  function focusRow(id: string) {
    setFocusedId(id);
    const focus = () => {
      const row = rows.current.get(id);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    if (rows.current.has(id)) focus(); else requestAnimationFrame(focus);
  }
  function toggleExpanded(id: string) {
    setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function toggleChecked(node: ChangeNode) {
    const next = toggleSelection(node.fileIds, selected);
    const stableSelection = new Set(files.filter(file => next.has(file.id)).map(reviewKey));
    setReview(current => { persist(storageKey, stableSelection, current.draft); return { ...current, selected: stableSelection }; });
    focusRow(node.id);
  }
  function activate(node: ChangeNode) {
    focusRow(node.id);
    if (node.file) onSelect(node.file.id); else toggleExpanded(node.id);
  }
  function folderPath(node: ChangeNode) {
    const parts: string[] = [];
    let current: ChangeNode | undefined = node;
    while (current?.kind === 'folder') {
      parts.unshift(current.label);
      current = current.parentId ? nodesById.get(current.parentId) : undefined;
    }
    return parts.join('/');
  }
  function showFileActions(event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>, node: ChangeNode) {
    if ('key' in event && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    if (node.file) fileActions?.(event, { kind: 'comparison', path: node.file.path, changeId: node.file.id });
    else if (node.kind === 'folder' && node.fileIds[0]) fileActions?.(event, { kind: 'directory', path: folderPath(node), changeId: node.fileIds[0] });
    else if (node.kind === 'group') {
      const ids = new Set(node.fileIds);
      const members = files.filter(file => ids.has(file.id));
      const include = (checked: boolean) => setReview(current => {
        const next = new Set(current.selected);
        for (const file of members) { if (checked) next.add(reviewKey(file)); else next.delete(reviewKey(file)); }
        persist(storageKey, next, current.draft);
        return { ...current, selected: next };
      });
      const expand = (open: boolean) => setExpanded(current => {
        const next = new Set(current);
        for (const { node: child } of flattenTree([node])) {
          if (open && child.children.length) next.add(child.id); else if (!open) next.delete(child.id);
        }
        return next;
      });
      const shown = fileActions?.(event, { kind: 'change-group', path: '', label: node.label,
        changeIds: [...node.fileIds], paths: members.map(file => file.path) }, [
        { id: 'include-group', label: 'Include All in Commit', disabled: checkState(node.fileIds, selected) === 'true', onSelect: () => include(true) },
        { id: 'exclude-group', label: 'Exclude All from Commit', disabled: checkState(node.fileIds, selected) === 'false', onSelect: () => include(false) },
        { id: 'group-selection-separator', kind: 'separator' },
        { id: 'expand-group', label: 'Expand All', onSelect: () => expand(true) },
        { id: 'collapse-group', label: 'Collapse All', onSelect: () => expand(false) },
        ...(onRefresh ? [{ id: 'group-refresh-separator', kind: 'separator' as const },
          { id: 'refresh-group', label: 'Refresh', disabled: busy, onSelect: onRefresh }] : []),
      ]);
      if (shown) { setFocusedId(node.id); event.currentTarget.focus({ preventScroll: true }); }
    }
  }
  function onTreeKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = visible.findIndex(row => row.node.id === activeRowId);
    const current = visible[index]?.node;
    if (!current || event.altKey || event.ctrlKey || event.metaKey) return;
    const move = (offset: number) => focusRow(visible[Math.max(0, Math.min(visible.length - 1, index + offset))].node.id);
    switch (event.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'Home': focusRow(visible[0].node.id); break;
      case 'End': focusRow(visible[visible.length - 1].node.id); break;
      case 'ArrowRight': if (current.children.length) { if (!expanded.has(current.id)) toggleExpanded(current.id); else focusRow(current.children[0].id); } break;
      case 'ArrowLeft': if (current.children.length && expanded.has(current.id)) toggleExpanded(current.id); else if (current.parentId) focusRow(current.parentId); break;
      case 'Enter': activate(current); break;
      case ' ': toggleChecked(current); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
  function navigateFile(offset: number) {
    if (!files.length) return;
    const current = files.findIndex(file => file.id === selectedId);
    const index = current < 0 ? offset > 0 ? 0 : files.length - 1 : (current + offset + files.length) % files.length;
    const file = files[index];
    setExpanded(value => new Set([...value, ...ancestorIds(tree, `file:${file.id}`)]));
    onSelect(file.id);
    focusRow(`file:${file.id}`);
  }
  function commit(pushAfterCommit: boolean) {
    if (!canCommit) return;
    onCommitRequest?.({ message: review.draft, changeIds: [...selected], options: { ...options }, pushAfterCommit });
  }
  return <section className="commit-panel" aria-label="Commit changes">
    <header className="commit-panel-heading"><h2>Commit</h2>
      <MenuButton label="Commit view options" className="commit-tool commit-options" showChevron={false} items={[
        { id: 'file-counts', label: 'Show file counts', kind: 'checkbox', checked: showFileCounts, onSelect: () => setShowFileCounts(value => !value) },
        { id: 'commit-message', label: 'Show commit message', kind: 'checkbox', checked: showDraft, onSelect: () => setShowDraft(value => !value) },
      ]}><Icon name="more" /></MenuButton>
    </header>
    <div className="commit-toolbar" role="toolbar" aria-label="Changes actions">
      <button className="commit-tool" aria-label="Refresh changes" title="Refresh changes" onClick={onRefresh} disabled={!onRefresh || busy}><Icon name="refresh" className={busy ? 'commit-spinning' : ''} /></button>
      <button className="commit-tool" aria-label="Previous file" title="Previous file" onClick={() => navigateFile(-1)} disabled={!files.length}><Icon name="up" /></button>
      <button className="commit-tool" aria-label="Next file" title="Next file" onClick={() => navigateFile(1)} disabled={!files.length}><Icon name="down" /></button>
      <span className="commit-tool-divider" />
      <button className="commit-tool" aria-label="Expand all folders" title="Expand all folders" disabled={!files.length} onClick={() => setExpanded(new Set(allRows.filter(row => row.node.children.length).map(row => row.node.id)))}><Icon name="expand" /></button>
      <button className="commit-tool" aria-label="Collapse all folders" title="Collapse all folders" disabled={!files.length} onClick={() => { setExpanded(new Set()); setFocusedId(tree[0]?.id); }}><Icon name="collapse" /></button>
    </div>
    <div ref={treeElement} className="commit-tree" role="tree" aria-label="Changed files" aria-multiselectable="true" aria-busy={busy || untrackedPending} onKeyDown={onTreeKey}>
      {visible.map(({ node, depth, position, siblings }) => <div key={node.id}
        ref={element => { if (element) rows.current.set(node.id, element); else rows.current.delete(node.id); }}
        role="treeitem" aria-label={node.file ? `${node.file.path} (${node.file.group})` : node.id === 'group:untracked' ? 'Untracked' : node.label}
        aria-level={depth + 1} aria-posinset={position} aria-setsize={siblings}
        aria-expanded={node.children.length ? expanded.has(node.id) : undefined}
        aria-selected={node.file ? node.file.id === selectedId : undefined}
        tabIndex={node.id === activeRowId ? 0 : -1}
        data-file-id={node.file?.id} data-path={node.file?.path ?? (node.kind === 'folder' ? folderPath(node) : undefined)} data-node-id={node.id}
        data-scope={scopeBackgrounds && node.file && !node.file.unsupported && isGoTestFile(node.file.path) ? 'test' : undefined}
        className={`commit-tree-row commit-${node.kind}${node.file && node.file.id === selectedId ? ' is-current' : ''}${node.file ? ` commit-status-${node.file.group === 'untracked' ? 'untracked' : node.file.status.includes('A') ? 'added' : node.file.status.includes('D') ? 'deleted' : 'modified'}` : ''}`}
        style={{ paddingLeft: 9 + depth * 17 }}
        title={node.file ? `${node.file.oldPath ? `${node.file.oldPath} → ` : ''}${node.file.path}${node.file.unsupported ? ` — ${node.file.unsupported}` : ''}` : node.label}
        onFocus={() => setFocusedId(node.id)} onClick={() => activate(node)}
        onContextMenu={event => showFileActions(event, node)}
        onKeyDown={event => showFileActions(event, node)}>
        <span className={`commit-disclosure${expanded.has(node.id) ? ' is-open' : ''}`}>{node.children.length ? <Icon name="chevron" /> : null}</span>
        <ReviewCheckbox node={node} selected={selected} onToggle={() => toggleChecked(node)} />
        {node.kind === 'folder' ? <Icon name="folder" className="commit-folder-icon" /> : node.file ? <FileIcon path={node.file.path} /> : null}
        <span className="commit-node-name">{node.label.replaceAll('\n', '↵').replaceAll('\r', '␍').replaceAll('\t', '⇥')}</span>
        {node.kind !== 'file' ? showFileCounts && <span className="commit-file-count">{node.fileIds.length} {node.fileIds.length === 1 ? 'file' : 'files'}</span>
          : node.file?.unsupported ? <span className="commit-file-warning" title={node.file.unsupported} aria-label={node.file.unsupported}><Icon name="warning" /></span> : null}
      </div>)}
      {untrackedPending && <div className="commit-pending-files" role="status">Loading unversioned files…</div>}
      {untrackedError && <div className="commit-pending-files" role="status">Unversioned files could not be loaded. Refresh to retry.</div>}
      {!files.length && !untrackedPending && !untrackedError && <div className="commit-tree-empty">{busy ? 'Loading changes…' : emptyMessage}</div>}
    </div>
    <footer className="commit-draft" hidden={!showDraft}>
      <DraftResizeHandle message={messageElement} tree={treeElement} visible={showDraft} />
      <label className="sr-only" htmlFor={draftId}>Commit message (local draft)</label>
      <textarea ref={messageElement} id={draftId} className="commit-message" placeholder="Commit Message" value={review.draft} spellCheck={false}
        onChange={event => { const draft = event.target.value; setReview(current => { persist(storageKey, current.selected, draft); return { ...current, draft }; }); }} />
      <div className="commit-footer-actions">
        <button className="commit-primary" disabled={!canCommit} onClick={() => commit(false)}>Commit</button>
        <button className="commit-push" disabled={!canCommit} onClick={() => commit(true)}>Commit and Push…</button>
        <CommitSettings value={options} disabled={busy} onChange={next => {
          setOptions(next);
          try { localStorage.setItem(optionsKey, JSON.stringify(next)); } catch { /* Session settings remain usable. */ }
        }} />
      </div>
    </footer>
  </section>;
}

export default CommitPanel;
