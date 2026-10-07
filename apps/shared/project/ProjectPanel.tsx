import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import type { ProjectDirectory, ProjectEntry } from '../../desktop/src/bridge';
import { ProjectIcon } from './icons';
import { displayProjectName, isCurrentProjectDirectory, projectAncestors, projectEntryFacts, projectRows, type DirectoryState, type ProjectRow } from './tree';
import { MenuButton } from '../ui/MenuButton';
import { useFileActions } from '../files/FileActions';
import { ContextMenu, type ContextMenuEntry } from '../ui/ContextMenu';
import { defaultNodeFacts, defaultTreePreferences, type DirectoryMarking, type ProjectDecorationClient, type ProjectTreePreferences } from './semantics';
import { isTreeNodeVisible, resolveTreePresentation } from './presentation';
import { TreeSemanticIcon } from './TreeSemanticIcon';
import { getTreeTheme } from './theme';
import { getSettings, subscribeSettings } from '../settings/store';
import { useTreeDiagnostics } from './diagnostics';
import './project.css';

export interface ProjectPanelProps {
  repositoryKey: string;
  repositoryName: string;
  repositoryPath: string;
  selectedPath: string | null;
  loadDirectory: (id: string | null) => Promise<ProjectDirectory>;
  onSelect: (entry: ProjectEntry) => void;
  /** Native application actions use the focused tree entry without opening it. */
  onFocusEntry?: (entry: ProjectEntry | null) => void;
  refreshToken?: number;
  onRefresh?: () => void;
  decorationClient?: ProjectDecorationClient;
  onPreferencesChange?: (preferences: ProjectTreePreferences) => void;
}

/** Key the state boundary so late responses from a previously selected repository cannot appear. */
export function ProjectPanel(props: ProjectPanelProps) {
  return <ProjectTree key={props.repositoryKey} {...props} />;
}

function ProjectTree({ repositoryKey, repositoryName, repositoryPath, selectedPath, loadDirectory, onSelect, onFocusEntry, refreshToken = 0, onRefresh, decorationClient, onPreferencesChange }: ProjectPanelProps) {
  const fileActions = useFileActions();
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const theme = getTreeTheme(settings);
  const withDiagnostics = useTreeDiagnostics(repositoryKey);
  const [directories, setDirectories] = useState<Map<string, DirectoryState>>(() => new Map());
  const [expanded, setExpanded] = useState(() => new Set(['', ...(selectedPath ? projectAncestors(selectedPath) : [])]));
  const [focusedPath, setFocusedPath] = useState('');
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(selectedPath ? null : '');
  const [localRefresh, setLocalRefresh] = useState(0);
  const [locateTarget, setLocateTarget] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<ProjectTreePreferences>(() => ({ ...defaultTreePreferences }));
  const [actionError, setActionError] = useState<string>();
  const [markingPending, setMarkingPending] = useState(false);
  const [directoryMenu, setDirectoryMenu] = useState<{ row: ProjectRow; position: { x: number; y: number }; returnFocus: HTMLElement }>();
  const preferenceRevision = useRef(0);
  const preferenceQueue = useRef<Promise<unknown>>(Promise.resolve());
  const alive = useRef(true);
  const loader = useRef(loadDirectory);
  loader.current = loadDirectory;
  const generation = useRef(0);
  const acceptedGeneration = useRef(0);
  const requests = useRef(new Map<string, object>());
  const cache = useRef(new Map<string, DirectoryState>());
  const stale = useRef(new Set<string>());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const treeElement = useRef<HTMLDivElement>(null);
  const prefetchQueue = useRef(new Map<string, { id: string; epoch: number }>());
  const prefetching = useRef(new Set<object>());
  const prefetchAttempts = useRef(new Set<string>());
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const frames = useRef(new Set<number>());
  const visible = useMemo(() => projectRows(directories, expanded, entry => isTreeNodeVisible(projectEntryFacts(repositoryKey, entry), preferences)), [directories, expanded, repositoryKey, preferences]);
  const activePath = visible.some(row => row.path === focusedPath) ? focusedPath : '';

  useEffect(() => { onPreferencesChange?.(preferences); }, [preferences, onPreferencesChange]);

  function rowFacts(row: ProjectRow) {
    const listed = row.entry ? projectEntryFacts(repositoryKey, row.entry) : defaultNodeFacts(repositoryKey, '', 'directory');
    const loaded = directories.get(row.path)?.directory?.facts;
    return withDiagnostics(loaded?.repositoryId === repositoryKey && loaded.path === row.path && loaded.generation >= listed.generation ? loaded : listed);
  }

  useEffect(() => {
    alive.current = true;
    const revision = preferenceRevision.current;
    let current = true;
    if (decorationClient) void decorationClient.getProjectTreePreferences(repositoryKey).then(value => {
      if (current && revision === preferenceRevision.current) setPreferences({ ...defaultTreePreferences, ...value });
    }).catch(error => {
      if (current) setActionError(error instanceof Error ? error.message : 'Unable to load project view settings.');
    });
    return () => { current = false; alive.current = false; };
  }, [repositoryKey, decorationClient]);

  function updatePreference(key: keyof ProjectTreePreferences) {
    const patch = { [key]: !preferences[key] };
    setPreferences(value => ({ ...value, ...patch }));
    setActionError(undefined);
    const revision = ++preferenceRevision.current;
    if (!decorationClient) return;
    // Persist in click order; a slower earlier reply must not undo a newer choice.
    preferenceQueue.current = preferenceQueue.current.catch(() => undefined).then(() => decorationClient.setProjectTreePreferences(repositoryKey, patch)).then(value => {
      if (alive.current && revision === preferenceRevision.current) setPreferences(value);
    }).catch(error => {
      if (alive.current) setActionError(error instanceof Error ? error.message : 'Unable to save project view settings.');
    });
  }

  function publish(path: string, state: DirectoryState) {
    // Refresh LRU order. Keep expanded listings; bound only the hidden cache so
    // browsing a large project does not retain every directory ever visited.
    cache.current.delete(path);
    cache.current.set(path, state);
    let entries = [...cache.current.values()].reduce((sum, value) => sum + (value.directory?.entries.length ?? 0), 0);
    for (const [key, value] of cache.current) {
      if (cache.current.size <= 96 && entries <= 12000) break;
      if (key === path || expandedRef.current.has(key) || requests.current.has(key)) continue;
      cache.current.delete(key); stale.current.delete(key);
      entries -= value.directory?.entries.length ?? 0;
    }
    setDirectories(new Map(cache.current));
  }
  function pruneChildren(directory: ProjectDirectory) {
    if (directory.truncated) return;
    const children = new Map(directory.entries.filter(entry => entry.kind === 'directory').map(entry => [entry.path, entry.id]));
    const prefix = directory.path ? `${directory.path}/` : '';
    const replaced = new Set([...children].filter(([path, id]) => {
      const previous = cache.current.get(path)?.directory;
      return previous && previous.directoryId !== id;
    }).map(([path]) => path));
    for (const key of cache.current.keys()) {
      if (key === directory.path || !key.startsWith(prefix)) continue;
      const child = prefix + key.slice(prefix.length).split('/')[0];
      if (children.has(child) && !replaced.has(child)) continue;
      cache.current.delete(key); stale.current.delete(key); requests.current.delete(key);
      prefetchQueue.current.delete(key);
    }
  }
  async function ensureLoaded(path: string, id: string | null, force = false, retry = false, speculative = false) {
    const cached = cache.current.get(path);
    if (!force && requests.current.has(path)) return;
    if (!force && cached && cached.state !== 'loading' && !stale.current.has(path)) {
      cache.current.delete(path); cache.current.set(path, cached);
      return;
    }
    const epoch = generation.current;
    const request = {};
    requests.current.set(path, request);
    const isCurrent = () => alive.current && epoch === generation.current && requests.current.get(path) === request;
    // Background refreshes retain the existing rows and scroll position until
    // their replacement is ready; expanded folders must not blink closed.
    const loading: DirectoryState = { state: 'loading', directory: cached?.directory };
    if (speculative && !expandedRef.current.has(path)) cache.current.set(path, loading);
    else publish(path, loading);
    try {
      const directory = await loader.current(id);
      if (!isCurrent()) return;
      if (!isCurrentProjectDirectory(directory, repositoryKey, path, acceptedGeneration.current)) {
        if (!retry) return ensureLoaded(path, id, true, true);
        throw new Error('The project changed while loading this folder.');
      }
      acceptedGeneration.current = Math.max(acceptedGeneration.current, directory.generation ?? 0);
      stale.current.delete(path);
      pruneChildren(directory);
      publish(path, { state: 'ready', directory });
    } catch (error) {
      if (!isCurrent()) return;
      stale.current.delete(path);
      publish(path, { state: 'error', directory: cache.current.get(path)?.directory, error: error instanceof Error ? error.message : 'Unable to load this folder.' });
    } finally {
      if (requests.current.get(path) === request) requests.current.delete(path);
    }
  }

  function pumpPrefetch() {
    while (alive.current && prefetching.current.size < 2 && prefetchQueue.current.size) {
      const [path, work] = prefetchQueue.current.entries().next().value!;
      prefetchQueue.current.delete(path);
      if (work.epoch !== generation.current || requests.current.has(path)) continue;
      const token = {};
      prefetching.current.add(token);
      void ensureLoaded(path, work.id, false, false, true).finally(() => {
        prefetching.current.delete(token);
        pumpPrefetch();
      });
    }
  }
  function prefetch(row: ProjectRow, intent = false) {
    if (row.entry?.kind !== 'directory' || expandedRef.current.has(row.path) || requests.current.has(row.path)) return;
    const state = cache.current.get(row.path);
    if (state && !stale.current.has(row.path)) return;
    const facts = row.entry.facts;
    // Visibility is only a hint. Never proactively walk dependency, ignored,
    // generated, excluded, symlink or nested-repository trees.
    if (!intent && facts && (facts.library || facts.generated.value || facts.git.ignored === true
      || facts.inclusion.state !== 'included' || facts.identity.nestedRepository || facts.identity.repositoryRoot)) return;
    if (!intent && prefetchAttempts.current.has(row.path)) return;
    if (prefetchQueue.current.size >= 24) return;
    prefetchAttempts.current.add(row.path);
    prefetchQueue.current.set(row.path, { id: row.entry.id, epoch: generation.current });
    pumpPrefetch();
  }

  useEffect(() => {
    if (rowElements.current.get(focusedPath) === document.activeElement) setLocateTarget(focusedPath);
    generation.current++;
    requests.current.clear();
    prefetchQueue.current.clear(); prefetchAttempts.current.clear();
    // Keep populated collapsed listings too: expansion paints them immediately
    // while the current generation is revalidated in the background.
    const previous = cache.current;
    // An invalidated first read has no directory ID to restart from. Drop that
    // loading placeholder so the refreshed parent can issue its read again.
    // Retain populated listings to avoid disturbing expansion or scroll.
    cache.current = new Map([...previous].filter(([, state]) => state.directory));
    stale.current = new Set(cache.current.keys());
    setDirectories(new Map(cache.current));
    void ensureLoaded('', null, true);
    for (const [path, state] of [...cache.current]) {
      if (path && state.directory && expandedRef.current.has(path)) void ensureLoaded(path, state.directory.directoryId, true);
    }
    return () => { generation.current++; requests.current.clear(); prefetchQueue.current.clear(); };
    // The loader itself can change with every host render; refresh is explicitly versioned.
  }, [refreshToken, localRefresh]);

  useEffect(() => {
    // Wait for the root before loading newly expanded child directories.
    if (cache.current.get('')?.state !== 'ready') return;
    for (const row of visible) {
      const currentParent = cache.current.get(row.parentPath ?? '')?.directory;
      if (row.entry?.kind === 'directory' && expanded.has(row.path)
        && currentParent?.entries.some(entry => entry.id === row.entry?.id)) void ensureLoaded(row.path, row.entry.id);
    }
  }, [visible, expanded]);

  useEffect(() => {
    if (!treeElement.current || typeof IntersectionObserver === 'undefined') return;
    const byPath = new Map(visible.map(row => [row.path, row]));
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const path = (entry.target as HTMLElement).dataset.path!;
        const row = byPath.get(path);
        if (entry.isIntersecting && row) prefetch(row);
        else if (prefetchQueue.current.delete(path)) prefetchAttempts.current.delete(path);
      }
    }, { root: treeElement.current, rootMargin: '80px 0px' });
    for (const row of visible) {
      const element = rowElements.current.get(row.path);
      if (element && row.entry?.kind === 'directory' && !expanded.has(row.path)) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [visible, expanded]);

  useEffect(() => {
    if (selectedPath) {
      setExpanded(current => new Set([...current, ...projectAncestors(selectedPath)]));
      setSelectedDirectory(null);
    }
  }, [selectedPath]);

  useEffect(() => {
    if (locateTarget === null || !visible.some(row => row.path === locateTarget)) return;
    focusRow(locateTarget); setLocateTarget(null);
  }, [visible, locateTarget]);

  useEffect(() => () => { for (const frame of frames.current) cancelAnimationFrame(frame); }, []);

  function focusRow(path: string) {
    setFocusedPath(path);
    const focus = () => {
      const row = rowElements.current.get(path);
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    if (rowElements.current.has(path)) focus();
    else {
      const frame = requestAnimationFrame(() => { frames.current.delete(frame); focus(); });
      frames.current.add(frame);
    }
  }
  function toggleFolder(path: string) {
    if (!expanded.has(path)) {
      const row = visible.find(row => row.path === path);
      if (row) void ensureLoaded(path, row.entry?.id ?? null);
      // A speculative read may already be in flight without a published loading
      // state. Publish its cached rows/busy state in the same expansion update.
      setDirectories(new Map(cache.current));
    }
    setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  }
  function isDirectory(row: ProjectRow) { return !row.entry || row.entry.kind === 'directory'; }
  function activate(row: ProjectRow) {
    focusRow(row.path);
    if (isDirectory(row)) { setSelectedDirectory(row.path); toggleFolder(row.path); }
    else if (row.entry) { setSelectedDirectory(null); onSelect(row.entry); }
  }
  function onTreeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'treeitem') return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = visible.findIndex(row => row.path === activePath);
    const current = visible[index];
    if (!current) return;
    switch (event.key) {
      case 'ArrowDown': focusRow(visible[Math.min(index + 1, visible.length - 1)].path); break;
      case 'ArrowUp': focusRow(visible[Math.max(index - 1, 0)].path); break;
      case 'Home': focusRow(''); break;
      case 'End': focusRow(visible[visible.length - 1].path); break;
      case 'ArrowRight':
        if (isDirectory(current)) {
          if (!expanded.has(current.path)) toggleFolder(current.path);
          else if (visible[index + 1]?.parentPath === current.path) focusRow(visible[index + 1].path);
        }
        break;
      case 'ArrowLeft':
        if (isDirectory(current) && expanded.has(current.path)) toggleFolder(current.path);
        else if (current.parentPath !== undefined) focusRow(current.parentPath);
        break;
      case 'Enter': case ' ': activate(current); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
  }
  function refresh() {
    if (onRefresh) onRefresh();
    else setLocalRefresh(value => value + 1);
  }
  function locate() {
    if (!selectedPath) return;
    setExpanded(current => new Set([...current, ...projectAncestors(selectedPath)]));
    setSelectedDirectory(null); setLocateTarget(selectedPath);
  }

  function showDirectoryMenu(event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>, row: ProjectRow) {
    if ('key' in event && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    if (fileActions?.(event, { kind: 'directory', path: row.path, entryId: row.entry?.id ?? null }, directoryMarkItems(row))) return;
    event.preventDefault(); event.stopPropagation();
    const element = event.currentTarget, rect = element.getBoundingClientRect();
    const keyboard = 'key' in event;
    setDirectoryMenu({ row, returnFocus: element, position: keyboard ? { x: rect.left + 24, y: rect.bottom } : { x: event.clientX, y: event.clientY } });
  }

  async function markDirectory(row: ProjectRow, marking: DirectoryMarking | null) {
    if (!decorationClient || markingPending || row.entry && row.entry.kind !== 'directory') return;
    setMarkingPending(true); setActionError(undefined);
    try {
      await decorationClient.markProjectDirectory(repositoryKey, row.entry?.id ?? null, marking);
      if (alive.current) setLocalRefresh(value => value + 1);
    } catch (error) {
      if (alive.current) setActionError(error instanceof Error ? error.message : 'Unable to mark this directory.');
    } finally {
      if (alive.current) setMarkingPending(false);
    }
  }

  async function copyDirectoryPath(path: string, relative: boolean) {
    try {
      const absolute = path ? `${repositoryPath.replace(/[/\\]+$/, '')}/${path}` : repositoryPath;
      await navigator.clipboard.writeText(relative ? path || '.' : absolute);
      if (alive.current) setActionError(undefined);
    } catch {
      if (alive.current) setActionError('Unable to copy the path.');
    }
  }

  function directoryMarkItems(row: ProjectRow): ContextMenuEntry[] {
    if (!decorationClient) return [];
    const menuFacts = rowFacts(row);
    const currentMarking: DirectoryMarking | null = menuFacts?.role.reason.source === 'user' && menuFacts.role.rootPath === row.path
    ? menuFacts.generated.value && ['sources', 'test-sources'].includes(menuFacts.role.kind)
      ? menuFacts.role.kind === 'sources' ? 'generated-sources' : 'generated-test-sources' : menuFacts.role.kind as DirectoryMarking
    : menuFacts?.inclusion.reason.source === 'user' && menuFacts.inclusion.rootPath === row.path
      ? menuFacts.inclusion.state === 'included' ? 'included' : 'excluded' : null;
    return [{
      id: 'mark-directory', label: 'Mark Directory As', disabled: markingPending || menuFacts?.identity.nestedRepository,
      items: ([
        ['sources', 'Sources'], ['test-sources', 'Test Sources'], ['resources', 'Resources'], ['test-resources', 'Test Resources'],
        ['generated-sources', 'Generated Sources'], ['generated-test-sources', 'Generated Test Sources'],
        ['excluded', 'Excluded'], ['included', 'Cancel Exclusion'], ['ordinary', 'Unmark'], [null, 'Reset to Automatic'],
      ] as [DirectoryMarking | null, string][]).map(([marking, label]) => ({
        id: marking ?? 'automatic', label, kind: 'radio' as const, checked: currentMarking === marking,
        disabled: marking === 'included' && menuFacts?.inclusion.state === 'included',
        onSelect: () => markDirectory(row, marking),
      })),
    }];
  }
  const directoryMenuItems: ContextMenuEntry[] = directoryMenu ? [
    { id: 'copy-path', label: 'Copy Path', onSelect: () => copyDirectoryPath(directoryMenu.row.path, false) },
    { id: 'copy-relative-path', label: 'Copy Relative Path', onSelect: () => copyDirectoryPath(directoryMenu.row.path, true) },
    ...(decorationClient ? [{ id: 'mark-separator', kind: 'separator' as const }, ...directoryMarkItems(directoryMenu.row)] : []),
  ] : [];

  const busy = [...directories].some(([path, value]) => expanded.has(path) && value.state === 'loading');
  return <section className="project-panel" aria-label="Project files" style={{ '--tree-background': theme.background, '--tree-foreground': theme.foreground, '--tree-selection': theme.selection, '--tree-unfocused-selection': theme.unfocusedSelection, '--tree-hover': theme.hover, '--tree-selected-annotation': theme.selectedAnnotation } as CSSProperties}>
    <header className="project-panel-heading">
      <h2><MenuButton label="Project view options" className="project-title-menu" align="start" items={[
        { id: 'repository-path', label: 'Show repository path', kind: 'checkbox', checked: preferences.showRepositoryPath, onSelect: () => updatePreference('showRepositoryPath') },
        { id: 'status-colors', label: 'Show file status colors', kind: 'checkbox', checked: preferences.showStatusColors, onSelect: () => updatePreference('showStatusColors') },
        { id: 'directory-status', label: 'Highlight changed directories', kind: 'checkbox', checked: preferences.highlightChangedDirectories, onSelect: () => updatePreference('highlightChangedDirectories') },
        { id: 'scope-backgrounds', label: 'Scope backgrounds', kind: 'checkbox', checked: preferences.scopeBackgrounds, onSelect: () => updatePreference('scopeBackgrounds') },
        { id: 'visibility', kind: 'separator' },
        { id: 'excluded', label: 'Show excluded files', kind: 'checkbox', checked: preferences.showExcluded, onSelect: () => updatePreference('showExcluded') },
        { id: 'ignored', label: 'Show ignored files', kind: 'checkbox', checked: preferences.showIgnored, onSelect: () => updatePreference('showIgnored') },
        { id: 'hidden', label: 'Show hidden files', kind: 'checkbox', checked: preferences.showHidden, onSelect: () => updatePreference('showHidden') },
      ]}>Project</MenuButton></h2>
      <div className="project-toolbar" role="toolbar" aria-label="Project actions">
        <button type="button" className="project-tool" aria-label="Refresh project" title="Refresh project" disabled={busy} onClick={refresh}><ProjectIcon name="refresh" className={busy ? 'project-spinning' : ''} /></button>
        <span className="project-tool-divider" />
        <button type="button" className="project-tool" aria-label="Locate open file" title="Locate open file" disabled={!selectedPath} onClick={locate}><ProjectIcon name="locate" /></button>
        <button type="button" className="project-tool" aria-label="Expand loaded folders" title="Expand loaded folders" onClick={() => {
          const known = [...directories.values()].flatMap(value => value.directory?.entries ?? []).filter(entry => entry.kind === 'directory');
          setExpanded(current => new Set([...current, '', ...known.map(entry => entry.path)]));
        }}><ProjectIcon name="expand" /></button>
        <button type="button" className="project-tool" aria-label="Collapse project folders" title="Collapse all folders" onClick={() => { setExpanded(new Set()); setFocusedPath(''); setSelectedDirectory(''); }}><ProjectIcon name="collapse" /></button>
      </div>
    </header>
    {actionError && <div className="project-action-error" role="status">{actionError}<button type="button" aria-label="Dismiss project action error" onClick={() => setActionError(undefined)}>×</button></div>}
    <div ref={treeElement} className="project-tree" role="tree" aria-label="Project files" aria-busy={busy} onKeyDown={onTreeKey}>
      <div className="project-tree-content" role="presentation">
      {visible.map(row => {
        const directory = isDirectory(row);
        const state = directories.get(row.path);
        const current = selectedDirectory === row.path || selectedDirectory === null && selectedPath === row.path;
        const unsupported = row.entry?.kind === 'symlink' || row.entry?.kind === 'submodule';
        const name = row.entry?.name ?? repositoryName;
        const facts = rowFacts(row);
        const presentation = resolveTreePresentation(facts, theme, preferences, { expanded: expanded.has(row.path), loading: state?.state === 'loading' });
        return <Fragment key={row.path}>
          <div role="treeitem" aria-label={row.entry ? row.path : repositoryName}
            aria-level={row.depth + 1} aria-posinset={row.position} aria-setsize={row.siblings}
            aria-expanded={directory ? expanded.has(row.path) : undefined} aria-selected={current}
            aria-busy={directory && expanded.has(row.path) ? state?.state === 'loading' : undefined}
            aria-description={presentation.accessibilityDescription}
            tabIndex={row.path === activePath ? 0 : -1}
            ref={element => { if (element) rowElements.current.set(row.path, element); else rowElements.current.delete(row.path); }}
            data-path={row.path} data-kind={row.entry?.kind ?? 'root'}
            data-role={facts.role.kind} data-role-declared={facts.role.declared} data-git-state={facts.git.state}
            data-inclusion={facts.inclusion.state} data-generated={facts.generated.value}
            data-diagnostic={presentation.diagnosticUnderline?.severity}
            className={`project-tree-row${current ? ' is-current' : ''}${row.path === '' ? ' project-root' : ''}`}
            style={{ paddingLeft: `calc(${6 + row.depth * 18}px * var(--ui-scale, 1))`, '--tree-row-background': presentation.scopeBackground ?? 'transparent', '--tree-row-foreground': presentation.foreground, '--tree-row-annotation': presentation.annotationForeground, '--tree-row-diagnostic': presentation.diagnosticUnderline?.color } as CSSProperties}
            title={presentation.tooltip}
            onPointerEnter={() => prefetch(row, true)}
            onFocus={() => { setFocusedPath(row.path); onFocusEntry?.(row.entry ?? null); prefetch(row, true); }} onClick={() => activate(row)}
            onContextMenu={event => { if (directory) showDirectoryMenu(event, row); else if (row.entry) fileActions?.(event, { kind: 'file', path: row.path, entryId: row.entry.id }); }}
            onKeyDown={event => { if (directory) showDirectoryMenu(event, row); else if (row.entry) fileActions?.(event, { kind: 'file', path: row.path, entryId: row.entry.id }); }}>
            <span className={`project-disclosure${expanded.has(row.path) ? ' is-open' : ''}`}>{directory && <ProjectIcon name="chevron" />}</span>
            <TreeSemanticIcon path={row.path} presentation={presentation} theme={theme} />
            <span className="project-node-name">{displayProjectName(name)}</span>
            {!row.entry && preferences.showRepositoryPath && <span className="project-root-path">{displayProjectName(repositoryPath)}</span>}
            {presentation.annotation && <span className="project-kind-label project-annotation">{presentation.annotation}</span>}
            {unsupported && <span className="project-kind-label">{row.entry?.kind}</span>}
          </div>
          {directory && expanded.has(row.path) && state?.state === 'error' && <div className="project-directory-message project-directory-error" style={{ paddingLeft: 46 + row.depth * 18 }} role="status">{state.error}<button type="button" onClick={() => { void ensureLoaded(row.path, row.entry?.id ?? null, true); }}>Retry</button></div>}
          {directory && expanded.has(row.path) && state?.state === 'ready' && !state.directory?.entries.some(entry => isTreeNodeVisible(projectEntryFacts(repositoryKey, entry), preferences)) && <div className="project-directory-message" style={{ paddingLeft: 46 + row.depth * 18 }}>{state.directory?.entries.length ? 'No visible files' : 'Empty folder'}</div>}
          {directory && expanded.has(row.path) && state?.directory?.truncated && <div className="project-directory-message project-directory-error" style={{ paddingLeft: 46 + row.depth * 18 }}>This directory is too large. Only the first {state.directory.entries.length.toLocaleString()} entries are listed.</div>}
        </Fragment>;
      })}
      </div>
    </div>
    {directoryMenu && <ContextMenu label="Directory actions" position={directoryMenu.position} items={directoryMenuItems} returnFocus={directoryMenu.returnFocus} onClose={() => setDirectoryMenu(undefined)} />}
  </section>;
}
