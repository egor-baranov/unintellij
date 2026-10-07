import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { UiIcon } from '../ui';
import type { UiIconName } from '../ui/UiIcon';
import type { CommitSubmission } from '../commit/options';
import { useApplicationActions } from '../actions/renderer';
import { BranchDialog, type BranchDialogRequest } from './BranchDialog';
import type { BranchClient, BranchComparison, BranchOperation, BranchSnapshot, GitBranch } from './types';
import { buildBranchEntries, branchRowPositions, visibleBranchRange, type BranchListEntry } from './branch-list';
import './branches.css';

export interface BranchSelectorProps {
  repository: { id: string; name: string; path: string };
  client: BranchClient;
  refreshToken?: number;
  onRepositoryChanged: () => void;
  onCompare: (comparison: BranchComparison) => void;
  onCommit?: () => void;
  commitRequest?: CommitSubmission & { id: number };
  preview?: boolean;
}
interface Preferences { favorites: string[]; groupPrefixes: boolean; showTags: boolean; showRecent: boolean }
interface BranchAction { id: string; label: string; icon?: UiIconName; shortcut?: string; disabled?: boolean; run: () => void; separator?: boolean }
type Entry = BranchListEntry | { id: string; label: string; kind: 'action'; action: BranchAction };
const defaults: Preferences = { favorites: [], groupPrefixes: true, showTags: true, showRecent: true };
function readPreferences(path: string): Preferences {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(`smart-diff.branches:${path}`) ?? 'null');
    if (!saved || typeof saved !== 'object') return defaults;
    const value = saved as Partial<Preferences>;
    return { favorites: Array.isArray(value.favorites) ? value.favorites.filter((ref): ref is string => typeof ref === 'string') : [], groupPrefixes: value.groupPrefixes !== false, showTags: value.showTags !== false, showRecent: value.showRecent !== false };
  } catch { return defaults; }
}
const messageFor = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The host provides a narrow Git client. This UI never accesses Node, files, or Git directly. */
export function BranchSelector({ repository, client, refreshToken, onRepositoryChanged, onCompare, onCommit, commitRequest, preview }: BranchSelectorProps) {
  const [snapshot, setSnapshot] = useState<BranchSnapshot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState(false);
  const [preferences, setPreferences] = useState(() => readPreferences(repository.path));
  const [collapsed, setCollapsed] = useState(new Set<string>(['Tags']));
  const [active, setActive] = useState<string>();
  const [focusedEntry, setFocusedEntry] = useState<string>();
  const [submenu, setSubmenu] = useState<{ branch: GitBranch; entry: string }>();
  const [subActive, setSubActive] = useState(0);
  const [dialog, setDialog] = useState<BranchDialogRequest>();
  const [dialogSnapshot, setDialogSnapshot] = useState<BranchSnapshot>();
  const [dialogError, setDialogError] = useState<string>();
  const [placement, setPlacement] = useState({ left: 8, top: 48, maxHeight: 600 });
  const [subPlacement, setSubPlacement] = useState({ left: 8, top: 48, maxHeight: 600 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const subPanel = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const list = useRef<HTMLDivElement>(null);
  const rowProbe = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | undefined>(undefined);
  const [listViewport, setListViewport] = useState({ top: 0, height: 600 });
  const [listMetrics, setListMetrics] = useState({ row: 29, section: 15, group: 1 });
  const subRows = useRef(new Map<string, HTMLButtonElement>());
  const generation = useRef(0);
  const request = useRef(0);
  const mutating = useRef(false);
  const defaultFavoritesPending = useRef(false);
  const previousRefresh = useRef(refreshToken);
  const previousCommit = useRef<number | undefined>(undefined);
  const popupId = useId();
  const props = useRef({ repository, client, onRepositoryChanged, onCompare });
  props.current = { repository, client, onRepositoryChanged, onCompare };

  async function load() {
    if (mutating.current) return;
    const id = ++request.current, epoch = generation.current;
    const current = props.current;
    setLoading(true);
    try {
      const next = await current.client.listBranches(current.repository.id);
      if (id !== request.current || epoch !== generation.current) return;
      setSnapshot(next);
      if (defaultFavoritesPending.current) {
        defaultFavoritesPending.current = false;
        const initial = { ...defaults, favorites: next.branches.filter(branch => branch.kind === 'local' && (branch.name === 'main' || branch.name === 'master')).map(branch => branch.ref) };
        setPreferences(initial);
        try { localStorage.setItem(`smart-diff.branches:${current.repository.path}`, JSON.stringify(initial)); } catch { /* Keep the defaults for this session. */ }
      }
    } catch (reason) {
      if (id === request.current && epoch === generation.current) setError(messageFor(reason));
    } finally { if (id === request.current && epoch === generation.current) setLoading(false); }
  }
  useEffect(() => {
    generation.current++; request.current++;
    mutating.current = false;
    setSnapshot(undefined); setOpen(false); setFocusedEntry(undefined); setDialog(undefined); setBusy(false); setSubmenu(undefined); setError(undefined); setNotice(undefined);
    const saved = readPreferences(repository.path);
    defaultFavoritesPending.current = saved === defaults;
    setPreferences(saved); setCollapsed(new Set(['Tags']));
    void load();
    return () => { generation.current++; request.current++; };
  }, [repository.id, repository.path, client]);
  useEffect(() => {
    if (previousRefresh.current === refreshToken) return;
    previousRefresh.current = refreshToken;
    void load();
  }, [refreshToken]);
  useEffect(() => {
    if (!commitRequest || commitRequest.id === previousCommit.current || !snapshot) return;
    previousCommit.current = commitRequest.id;
    ask({ kind: 'commit', ...commitRequest });
  }, [commitRequest, snapshot]);
  useEffect(() => { if (open) { const frame = requestAnimationFrame(() => search.current?.focus()); return () => cancelAnimationFrame(frame); } }, [open]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  function savePreferences(next: Preferences) {
    defaultFavoritesPending.current = false;
    setPreferences(next);
    try { localStorage.setItem(`smart-diff.branches:${repository.path}`, JSON.stringify(next)); } catch { /* Session preferences still work without local storage. */ }
  }
  function favorite(branch: GitBranch) {
    const favorites = preferences.favorites.includes(branch.ref) ? preferences.favorites.filter(ref => ref !== branch.ref) : [...preferences.favorites, branch.ref];
    savePreferences({ ...preferences, favorites });
  }
  function toggleGroup(id: string) { setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function close(restore = true) { setFocusedEntry(undefined); setOpen(false); setSubmenu(undefined); setSettings(false); if (restore) trigger.current?.focus({ preventScroll: true }); }
  function show() { setQuery(''); setOpen(true); setSettings(false); setActive(undefined); if (!loading && !error) void load(); }
  function ask(next: BranchDialogRequest) { setSubmenu(undefined); setDialogError(undefined); setDialogSnapshot(snapshot); setDialog(next); }
  async function execute(operation: BranchOperation, reviewedToken?: string, pushAfterCommit = false) {
    if (!snapshot || busy || mutating.current) return;
    if (operation.kind === 'commit' && operation.changeIds && !snapshot.selectedCommitSupported) {
      setDialogError('Restart unintellij to load selected-file commit support.'); return;
    }
    const epoch = generation.current, current = props.current;
    mutating.current = true; request.current++; setLoading(false);
    setBusy(true); setError(undefined); setDialogError(undefined); setNotice(undefined);
    try {
      const result = await current.client.runBranchOperation(current.repository.id, reviewedToken ?? snapshot.token, operation);
      if (epoch !== generation.current) return;
      setSnapshot(result.snapshot); setNotice(result.message); setSubmenu(undefined);
      if (operation.kind === 'commit' && pushAfterCommit) {
        // Commit succeeded. Push is a separate step with a freshly reviewed remote;
        // retries here must never create another commit.
        setDialogSnapshot(result.snapshot);
        setDialog({ kind: 'push', branch: result.snapshot.branches.find(branch => branch.current), afterCommit: true });
      } else setDialog(undefined);
      if (epoch === generation.current) current.onRepositoryChanged();
      requestAnimationFrame(() => search.current?.focus());
    } catch (reason) {
      if (epoch !== generation.current) return;
      const message = messageFor(reason);
      setError(message); setDialogError(message);
      // Git can enter a conflicted state even when the command fails. Read it back
      // so abort/continue stay available and the retry uses a fresh snapshot token.
      try { const next = await current.client.listBranches(current.repository.id); if (epoch === generation.current) setSnapshot(next); } catch { /* Keep the original actionable error. */ }
      if (epoch === generation.current) current.onRepositoryChanged();
    } finally { if (epoch === generation.current) { mutating.current = false; setBusy(false); } }
  }
  async function compare(branch: GitBranch, target: 'head' | 'working') {
    if (busy) return;
    const epoch = generation.current, current = props.current;
    setBusy(true); setError(undefined); setSubmenu(undefined);
    try {
      const comparison = await current.client.compareBranches(current.repository.id, branch.ref, target);
      if (epoch !== generation.current) return;
      current.onCompare(comparison); close();
    } catch (reason) { if (epoch === generation.current) setError(messageFor(reason)); }
    finally { if (epoch === generation.current) setBusy(false); }
  }
  async function copy(branch: GitBranch) {
    try { await navigator.clipboard.writeText(branch.name); setNotice(`Copied ${branch.name}`); setSubmenu(undefined); search.current?.focus(); }
    catch (reason) { setError(`Could not copy the branch name: ${messageFor(reason)}`); }
  }
  const unavailable = !snapshot || busy || Boolean(snapshot.operation);
  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const actions: BranchAction[] = [
    { id: 'update', label: 'Update Project…', icon: 'update', shortcut: mac ? '⌘T' : 'Ctrl+T', disabled: unavailable || !snapshot?.remotes.length || snapshot.unborn, run: () => ask({ kind: 'update' }) },
    { id: 'commit', label: 'Commit…', icon: 'commit', shortcut: mac ? '⌘K' : 'Ctrl+K', disabled: unavailable, run: () => { onCommit?.(); ask({ kind: 'commit' }); } },
    { id: 'push', label: 'Push…', icon: 'push', shortcut: mac ? '⇧⌘K' : 'Ctrl+Shift+K', disabled: unavailable || !snapshot?.remotes.length || !snapshot.head, run: () => ask({ kind: 'push' }) },
    { id: 'create', label: 'New Branch…', icon: 'branch', shortcut: mac ? '⌥⌘N' : 'Ctrl+Alt+N', separator: true, disabled: unavailable, run: () => ask({ kind: 'create' }) },
    { id: 'revision', label: 'Checkout Tag or Revision…', disabled: unavailable || snapshot.unborn, run: () => ask({ kind: 'checkout-revision' }) },
  ];
  const menuAction = (id: string) => {
    const action = actions.find(item => item.id === id);
    return { enabled: Boolean(action && !action.disabled && !dialog && snapshot?.repositoryId === repository.id), run: () => action?.run() };
  };
  useApplicationActions({
    'git.branches': { enabled: !dialog, run: show },
    'git.commit': menuAction('commit'),
    'git.push': menuAction('push'),
    'git.update': menuAction('update'),
    'git.newBranch': menuAction('create'),
    'git.fetch': {
      enabled: !busy && !dialog && snapshot?.repositoryId === repository.id && Boolean(snapshot.remotes.length),
      // Keep progress and failures visible when Fetch starts from the menu bar.
      run: () => { setOpen(true); return execute({ kind: 'fetch' }); },
    },
  });
  const operationActions: BranchAction[] = snapshot?.operation ? [
    { id: 'continue', label: `Continue ${snapshot.operation === 'merge' ? 'Merge' : 'Rebase'}`, icon: 'play', disabled: busy, run: () => { void execute({ kind: 'continue' }); } },
    { id: 'abort', label: `Abort ${snapshot.operation === 'merge' ? 'Merge' : 'Rebase'}`, icon: 'close', disabled: busy, run: () => ask({ kind: 'abort' }) },
  ] : [];
  const normalizedQuery = query.toLocaleLowerCase().trim();
  const branchEntries = useMemo(() => buildBranchEntries(snapshot, preferences, collapsed, normalizedQuery), [snapshot, preferences, collapsed, normalizedQuery]);
  // Action closures are kept outside the large immutable branch list. Hover and
  // scrolling only read these maps; neither rebuilds/sorts the repository tree.
  const menuActions = [...operationActions, ...actions].filter(action => !normalizedQuery || action.label.toLocaleLowerCase().includes(normalizedQuery));
  const actionSignature = menuActions.map(action => `${action.id}:${Boolean(action.disabled)}:${Boolean(action.separator)}`).join('|');
  const actionLookup = new Map(menuActions.map(action => [action.id, action]));
  const actionIds = useMemo(() => menuActions.map(action => action.id), [actionSignature]);
  const ids = useMemo(() => [...actionIds, ...branchEntries.map(entry => entry.id)], [actionIds, branchEntries]);
  const branchLookup = useMemo(() => new Map(branchEntries.map(entry => [entry.id, entry])), [branchEntries]);
  const indexById = useMemo(() => new Map(ids.map((id, index) => [id, index])), [ids]);
  const enabledIds = useMemo(() => [...menuActions.filter(action => !action.disabled).map(action => action.id), ...branchEntries.map(entry => entry.id)], [actionSignature, branchEntries]);
  function entryFor(id: string | undefined): Entry | undefined {
    if (!id) return undefined;
    const action = actionLookup.get(id);
    return action ? { kind: 'action', id, label: action.label, action } : branchLookup.get(id);
  }
  const selected = entryFor(active);
  const positions = useMemo(() => branchRowPositions([
    ...menuActions.map(action => ({ kind: 'action', separator: action.separator })), ...branchEntries,
  ], listMetrics.row, listMetrics.section, listMetrics.group), [actionSignature, branchEntries, listMetrics]);
  const totalHeight = positions.length ? positions.at(-1)!.top + positions.at(-1)!.height : 0;
  const range = visibleBranchRange(positions, listViewport.top, listViewport.height);
  const visibleIds = ids.slice(range.start, range.end);
  // Pointer selection and DOM focus are independent: hovering another row must
  // never allow the keyboard-focused row (including its favorite) to unmount.
  for (const id of [submenu?.entry, focusedEntry, active]) if (id && indexById.has(id) && !visibleIds.includes(id)) visibleIds.push(id);
  visibleIds.sort((a, b) => indexById.get(a)! - indexById.get(b)!);

  useLayoutEffect(() => {
    if (!open || !list.current || !rowProbe.current) return;
    const element = list.current, probe = rowProbe.current;
    const measure = () => {
      const style = getComputedStyle(probe);
      const next = { row: probe.getBoundingClientRect().height, section: parseFloat(style.marginTop), group: parseFloat(style.marginBottom) };
      setListMetrics(previous => previous.row === next.row && previous.section === next.section && previous.group === next.group ? previous : next);
      setListViewport({ top: element.scrollTop, height: element.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element); observer.observe(probe);
    return () => observer.disconnect();
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !list.current) return;
    list.current.scrollTop = 0;
    setListViewport(previous => ({ ...previous, top: 0 }));
  }, [open, normalizedQuery, preferences.groupPrefixes]);
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (id) { const row = rows.current.get(id); if (row) { pendingFocus.current = undefined; row.focus({ preventScroll: true }); } }
  });
  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || dialog) return;
      // This is the only application-wide binding. Text entry and Monaco's
      // ordinary command shortcuts remain untouched while the popup is closed.
      if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (event.code === 'Backquote' || event.key === '`')) {
        event.preventDefault(); event.stopPropagation(); if (!open) show(); else search.current?.focus(); return;
      }
      if (!open || !(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      const key = event.key.toLocaleLowerCase();
      const id = key === 't' && !event.altKey && !event.shiftKey ? 'update'
        : key === 'k' && !event.altKey ? event.shiftKey ? 'push' : 'commit'
        : (key === 'n' || event.code === 'KeyN') && event.altKey && !event.shiftKey ? 'create' : undefined;
      if (id) {
        event.preventDefault(); event.stopPropagation();
        const action = actions.find(action => action.id === id);
        if (action && !action.disabled) action.run();
      } else if (key === 'c' && !event.altKey && !event.shiftKey) {
        const focused = document.activeElement;
        const branch = submenu && subPanel.current?.contains(focused) ? submenu.branch : selected?.kind === 'branch' && rows.current.get(selected.id) === focused ? selected.branch : undefined;
        if (branch) { event.preventDefault(); event.stopPropagation(); void copy(branch); }
      }
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  });
  const subActions = useMemo<BranchAction[]>(() => {
    if (!submenu || !snapshot) return [];
    const branch = submenu.branch, current = branch.current, local = branch.kind === 'local';
    const blocked = busy || Boolean(snapshot.operation);
    return [
      ...(!current ? [{ id: 'checkout', label: 'Checkout', icon: 'check' as const, disabled: blocked || Boolean(branch.worktree), run: () => ask({ kind: 'checkout', branch }) }] : []),
      { id: 'new-from', label: 'New Branch from Selected…', icon: 'branch', disabled: blocked, run: () => ask({ kind: 'create', branch }) },
      { id: 'compare', label: 'Compare with Current', icon: 'compact', disabled: busy || !snapshot.head, run: () => { void compare(branch, 'head'); } },
      { id: 'compare-working', label: 'Show Diff with Working Tree', icon: 'split', disabled: busy, run: () => { void compare(branch, 'working'); } },
      ...(local ? [{ id: 'rename', label: 'Rename…', separator: true, disabled: blocked, run: () => ask({ kind: 'rename', branch }) }] : []),
      ...(!current ? [{ id: 'delete', label: 'Delete…', icon: 'close' as const, disabled: blocked || Boolean(branch.worktree), run: () => ask({ kind: 'delete', branch }) }] : []),
      ...(local ? [
        ...(current ? [{ id: 'update-branch', label: 'Update…', icon: 'update' as const, separator: true, disabled: blocked || !branch.upstream, run: () => ask({ kind: 'update', branch }) }] : []),
        { id: 'push-branch', label: 'Push…', icon: 'push' as const, disabled: blocked || !snapshot.remotes.length, run: () => ask({ kind: 'push', branch }) },
      ] : []),
      ...(branch.kind === 'tag' ? [{ id: 'push-tag', label: 'Push…', icon: 'push' as const, separator: true, disabled: blocked || !snapshot.remotes.length, run: () => ask({ kind: 'push', branch }) }] : []),
      ...(!current ? [
        { id: 'merge', label: `Merge into Current`, icon: 'merge' as const, separator: true, disabled: blocked || snapshot.unborn, run: () => ask({ kind: 'merge', branch }) },
        { id: 'rebase', label: 'Rebase Current onto Selected…', disabled: blocked || snapshot.unborn, run: () => ask({ kind: 'rebase', branch }) },
        ...(branch.kind !== 'tag' ? [
          { id: 'checkout-rebase', label: 'Checkout and Rebase onto Current…', disabled: blocked || Boolean(branch.worktree) || snapshot.unborn, run: () => ask({ kind: 'checkout-rebase', branch }) },
          { id: 'checkout-update', label: 'Checkout and Update…', disabled: blocked || Boolean(branch.worktree) || (!branch.upstream && local), run: () => ask({ kind: 'checkout-update', branch }) },
        ] : []),
      ] : []),
      { id: 'copy', label: 'Copy Branch Name', icon: 'copy', shortcut: mac ? '⌘C' : 'Ctrl+C', separator: true, run: () => { void copy(branch); } },
      { id: 'favorite', label: preferences.favorites.includes(branch.ref) ? 'Remove from Favorites' : 'Add to Favorites', icon: preferences.favorites.includes(branch.ref) ? 'favorite' : 'favorite-outline', shortcut: 'Space', run: () => { favorite(branch); setSubmenu(undefined); search.current?.focus(); } },
    ];
  }, [submenu, snapshot, busy, preferences, mac]);

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    function position() {
      const anchor = trigger.current?.getBoundingClientRect(), popup = panel.current;
      if (!anchor || !popup) return;
      const edge = 8, top = Math.min(anchor.bottom + 5, window.innerHeight - 80);
      const next = { left: Math.max(edge, Math.min(anchor.left, window.innerWidth - popup.offsetWidth - edge)), top, maxHeight: Math.max(64, window.innerHeight - top - edge) };
      setPlacement(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      const source = submenu ? rows.current.get(submenu.entry)?.getBoundingClientRect() : undefined;
      const child = subPanel.current;
      if (source && child) {
        const mainRight = next.left + popup.offsetWidth;
        const rightFits = mainRight + child.offsetWidth + edge <= window.innerWidth;
        const leftFits = next.left - child.offsetWidth >= edge;
        const left = rightFits ? mainRight + 3 : leftFits ? next.left - child.offsetWidth - 3 : Math.max(edge, window.innerWidth - child.offsetWidth - edge);
        const height = Math.min(child.scrollHeight, window.innerHeight - edge * 2);
        const sub = { left, top: Math.max(edge, Math.min(source.top, window.innerHeight - height - edge)), maxHeight: window.innerHeight - edge * 2 };
        setSubPlacement(previous => JSON.stringify(previous) === JSON.stringify(sub) ? previous : sub);
      }
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
    position();
    const observer = new ResizeObserver(schedule);
    if (panel.current) observer.observe(panel.current);
    if (subPanel.current) observer.observe(subPanel.current);
    window.addEventListener('resize', schedule); document.addEventListener('scroll', schedule, true);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true); };
  }, [open, submenu]);
  useEffect(() => {
    if (!open || dialog) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !panel.current?.contains(target) && !subPanel.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [open, dialog]);
  useEffect(() => {
    if (!submenu) return;
    const first = subActions.findIndex(action => !action.disabled);
    setSubActive(Math.max(first, 0));
    requestAnimationFrame(() => { const action = subActions[first]; if (action) subRows.current.get(action.id)?.focus({ preventScroll: true }); });
  }, [submenu]);

  function select(entry: Entry) {
    setActive(entry.id);
    pendingFocus.current = entry.id;
    const index = indexById.get(entry.id), element = list.current;
    if (index !== undefined && element) {
      const position = positions[index], bottom = position.top + position.height;
      if (position.top < element.scrollTop) element.scrollTop = position.top;
      else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
      setListViewport({ top: element.scrollTop, height: element.clientHeight });
    }
  }
  function activate(entry: Entry) {
    if (entry.kind === 'action') { if (!entry.action.disabled) entry.action.run(); }
    else if (entry.kind === 'group') toggleGroup(entry.id);
    else { setActive(entry.id); setSubmenu({ branch: entry.branch, entry: entry.id }); }
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (dialog) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); search.current?.select(); return; }
    const index = enabledIds.indexOf(active ?? '');
    const movedIndex = (direction: number) => index < 0 ? direction > 0 ? 0 : enabledIds.length - 1 : (index + direction + enabledIds.length) % enabledIds.length;
    switch (event.key) {
      case 'Escape': event.preventDefault(); event.stopPropagation(); if (settings) { setSettings(false); search.current?.focus(); } else close(); return;
      case 'ArrowDown': case 'ArrowUp': {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const item = entryFor(enabledIds[movedIndex(direction)]);
        if (item) select(item); break;
      }
      case 'Enter': { const entry = selected ?? enabledIds.map(entryFor).find(item => item?.kind !== 'group'); if (entry) activate(entry); break; }
      case 'ArrowRight': if (selected?.kind === 'branch') activate(selected); else if (selected?.kind === 'group' && !selected.expanded) toggleGroup(selected.id); else return; break;
      case 'ArrowLeft': if (selected?.kind === 'group' && selected.expanded) toggleGroup(selected.id); else return; break;
      case ' ': if (event.target === search.current || selected?.kind !== 'branch') return; favorite(selected.branch); break;
      case 'Home': case 'End': if (event.target === search.current) return; { const entry = entryFor(event.key === 'Home' ? enabledIds[0] : enabledIds.at(-1)); if (entry) { select(entry); rows.current.get(entry.id)?.focus({ preventScroll: true }); } } break;
      default:
        if (event.target !== search.current && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          setQuery(previous => previous + event.key); setActive(undefined); search.current?.focus(); event.preventDefault();
        }
        return;
    }
    event.preventDefault(); event.stopPropagation();
  }
  function renderEntry(entry: Entry): ReactNode {
    const selected = active === entry.id;
    const common = { 'data-entry': entry.id, ref: (node: HTMLButtonElement | null) => { if (node) rows.current.set(entry.id, node); else rows.current.delete(entry.id); }, onFocus: () => setActive(entry.id), onPointerMove: () => { if (!submenu) setActive(entry.id); } };
    if (entry.kind === 'action') return <button key={entry.id} {...common} type="button" role="menuitem" aria-label={entry.label} className={`branch-entry branch-action${selected ? ' is-selected' : ''}${entry.action.separator ? ' after-separator' : ''}`} disabled={entry.action.disabled} onClick={() => activate(entry)}><span className="branch-entry-icon">{entry.action.icon && <UiIcon name={entry.action.icon} />}</span><span>{entry.label}</span>{entry.action.shortcut && <kbd aria-hidden="true">{entry.action.shortcut}</kbd>}</button>;
    if (entry.kind === 'group') return <button key={entry.id} {...common} type="button" role="menuitem" aria-expanded={entry.expanded} className={`branch-entry branch-group${selected ? ' is-selected' : ''}${!entry.depth ? ' branch-section' : ''}`} style={{ paddingLeft: 10 + (entry.depth ?? 0) * 18 }} onClick={() => toggleGroup(entry.id)}><UiIcon name={entry.expanded ? 'chevron-down' : 'chevron-right'} />{entry.depth ? <UiIcon name="folder" /> : null}<span>{entry.label}</span></button>;
    const branch = entry.branch, isFavorite = preferences.favorites.includes(branch.ref);
    return <div key={entry.id} className={`branch-row${selected ? ' is-selected' : ''}${branch.current ? ' is-current' : ''}`}>
      <button {...common} type="button" role="menuitem" aria-label={branch.name} aria-current={branch.current ? 'true' : undefined} aria-haspopup="menu" aria-expanded={submenu?.entry === entry.id} className="branch-entry branch-row-main" style={{ paddingLeft: 10 + (entry.depth ?? 0) * 18 }} onClick={() => activate(entry)} onDoubleClick={() => { if (!branch.current && !branch.worktree && !unavailable) ask({ kind: 'checkout', branch }); }} title={[branch.name, branch.current ? 'Current branch' : '', branch.upstream ? `Tracks ${branch.upstream}` : '', branch.worktree ? `Checked out in ${branch.worktree}` : ''].filter(Boolean).join('\n')}>
        <UiIcon name={branch.current ? 'branch-current' : branch.kind === 'tag' ? 'branch-current' : 'branch'} className={branch.kind === 'tag' && !branch.current ? 'branch-tag' : ''} /><span className="branch-name">{entry.label}</span>
        {(branch.ahead > 0 || branch.behind > 0) && <span className="branch-tracking" aria-label={`${branch.ahead} outgoing, ${branch.behind} incoming`}>{branch.ahead > 0 && `↑${branch.ahead}`} {branch.behind > 0 && `↓${branch.behind}`}</span>}
        {branch.worktree && !branch.current && <UiIcon name="link" />}
      </button>
      <button className={`branch-favorite${isFavorite ? ' is-favorite' : ''}`} type="button" aria-label={`${isFavorite ? 'Remove' : 'Add'} ${branch.name} ${isFavorite ? 'from' : 'to'} favorites`} title="Toggle favorite (Space)" onClick={() => favorite(branch)}><UiIcon name={isFavorite ? 'favorite' : 'favorite-outline'} /></button>
      <UiIcon name="chevron-right" className="branch-row-arrow" />
    </div>;
  }
  const currentLabel = snapshot?.current?.replace(/^refs\/heads\//, '') ?? (snapshot?.unborn ? 'No commits' : snapshot?.head ? snapshot.head.slice(0, 8) : loading ? 'Loading…' : 'Git');
  const currentBranch = snapshot?.branches.find(branch => branch.current);
  return <>
    <button ref={trigger} type="button" className="branch-trigger ui-menu-trigger" aria-label="Git branches" title={`Git branches: ${currentLabel} (Alt+\`)`} aria-keyshortcuts="Alt+`" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined} onClick={() => { if (open) close(); else show(); }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show(); } }}>
      <UiIcon name="branch" /><span>{currentLabel}</span>{currentBranch && (currentBranch.ahead > 0 || currentBranch.behind > 0) && <span className="branch-tracking branch-trigger-tracking" aria-label={`${currentBranch.ahead} outgoing, ${currentBranch.behind} incoming`} title={`${currentBranch.ahead} outgoing, ${currentBranch.behind} incoming`}>{currentBranch.ahead > 0 && `↑${currentBranch.ahead}`} {currentBranch.behind > 0 && `↓${currentBranch.behind}`}</span>}{snapshot?.operation && <span className="branch-operation-dot" title={`${snapshot.operation} in progress`} />}<UiIcon name="chevron-down" />
    </button>
    {notice && !open && <div className="branch-toast" role="status">{notice}<button aria-label="Dismiss branch notification" onClick={() => setNotice(undefined)}><UiIcon name="close" /></button></div>}
    {open && createPortal(<div ref={panel} id={popupId} role="dialog" aria-label="Git branches and actions" className="branch-popup" style={placement} onKeyDown={keyboard}>
      <div className="branch-searchbar"><div className="branch-search"><UiIcon name="search" /><input ref={search} aria-label="Search for branches and actions" placeholder="Search for branches and actions" value={query} onChange={event => { setQuery(event.target.value); setActive(undefined); setSubmenu(undefined); }} />{query && <button aria-label="Clear branch search" onClick={() => { setQuery(''); search.current?.focus(); }}><UiIcon name="close" /></button>}</div><button className="ui-toolbar-icon" aria-label="Fetch all remotes" title="Fetch all remotes" disabled={busy || !snapshot?.remotes.length} onClick={() => { void execute({ kind: 'fetch' }); }}><UiIcon name="fetch" className={busy ? 'branch-spinning' : ''} /></button><button className="ui-toolbar-icon" aria-label="Branch popup settings" aria-expanded={settings} title="Branch popup settings" onClick={() => { setSettings(!settings); setSubmenu(undefined); }}><UiIcon name="settings" /></button></div>
      {settings && <div className="branch-settings" role="group" aria-label="Branch popup settings">{([
        ['groupPrefixes', 'Group by Prefix'], ['showRecent', 'Show Recent Branches'], ['showTags', 'Show Tags'],
      ] as const).map(([key, label]) => <button key={key} role="menuitemcheckbox" aria-checked={preferences[key]} onClick={() => savePreferences({ ...preferences, [key]: !preferences[key] })}><UiIcon name={preferences[key] ? 'check' : 'checkbox'} />{label}</button>)}</div>}
      {preview && <div className="branch-preview-label">Sample repository</div>}
      {snapshot?.operation && <div className="branch-operation-banner" role="status">{snapshot.operation === 'merge' ? 'Merge' : 'Rebase'} in progress. Resolve conflicts in your editor, then continue or abort.</div>}
      {loading && <div className="branch-status" role="status">Refreshing branches…</div>}
      {error && <div className="branch-feedback branch-error" role="alert"><span>{error}</span><button disabled={busy || loading} onClick={() => { setError(undefined); void load(); }}>Refresh</button></div>}
      {notice && <div className="branch-feedback branch-success" role="status">{notice}</div>}
      <div ref={list} className="branch-entries" role="menu" aria-label="Branches and actions" onFocusCapture={event => {
        const target = event.target;
        setFocusedEntry(target instanceof Element ? target.closest<HTMLElement>('[data-branch-entry-id]')?.dataset.branchEntryId : undefined);
      }} onBlurCapture={event => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocusedEntry(undefined);
      }} onScroll={event => {
        const element = event.currentTarget;
        setListViewport({ top: element.scrollTop, height: element.clientHeight });
      }}>
        <div ref={rowProbe} className="branch-virtual-probe" aria-hidden="true" />
        <div className="branch-virtual-content" style={{ height: totalHeight }}>
          {visibleIds.map(id => {
            const index = indexById.get(id)!, position = positions[index], entry = entryFor(id)!;
            return <div key={id} className="branch-virtual-row" style={{ top: position.top, height: position.height, paddingTop: position.gap }} data-row-index={index} data-branch-entry-id={id}>{renderEntry(entry)}</div>;
          })}
        </div>
        {!loading && !ids.length && <p className="branch-status">No matching branches or actions.</p>}
        {snapshot?.unborn && <p className="branch-status">No commits yet. Create the first commit to start branch history.</p>}
        {snapshot && !snapshot.current && !snapshot.unborn && <p className="branch-status">Detached HEAD at {snapshot.head?.slice(0, 8)}. Create a branch to keep new commits.</p>}
      </div>
      <div className="branch-footer"><span>{busy ? 'Working…' : '↵ Actions · Space Favorite'}</span><span title={repository.path}>{repository.name}</span></div>
    </div>, document.body)}
    {open && submenu && createPortal(<div ref={subPanel} className="branch-submenu" role="menu" aria-label={`Actions for ${submenu.branch.name}`} style={subPlacement} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); setSubmenu(undefined); rows.current.get(submenu.entry)?.focus(); return; }
      if (event.key === ' ') { event.preventDefault(); favorite(submenu.branch); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); const enabled = subActions.map((action, index) => ({ action, index })).filter(item => !item.action.disabled);
        const index = enabled.findIndex(item => item.index === subActive);
        const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length];
        if (next) { setSubActive(next.index); subRows.current.get(next.action.id)?.focus(); }
      }
    }}><div className="branch-subtitle">{submenu.branch.name}</div>{subActions.map((action, index) => <button key={action.id} ref={node => { if (node) subRows.current.set(action.id, node); else subRows.current.delete(action.id); }} type="button" role="menuitem" aria-label={action.label} className={`branch-entry${subActive === index ? ' is-selected' : ''}${action.separator ? ' after-separator' : ''}`} disabled={action.disabled} tabIndex={subActive === index ? 0 : -1} onFocus={() => setSubActive(index)} onPointerMove={() => setSubActive(index)} onClick={action.run}><span className="branch-entry-icon">{action.icon && <UiIcon name={action.icon} />}</span><span>{action.label}</span>{action.shortcut && <kbd aria-hidden="true">{action.shortcut}</kbd>}</button>)}</div>, document.body)}
    {dialog && dialogSnapshot && <BranchDialog key={`${dialog.kind}:${'branch' in dialog ? dialog.branch?.ref : ''}`} request={dialog} snapshot={dialogSnapshot} repositoryName={repository.name} preview={preview} busy={busy} error={dialogError}
      reviewChanged={Boolean(snapshot && snapshot.token !== dialogSnapshot.token)} onReviewLatest={() => { setDialogSnapshot(snapshot); setDialogError(undefined); }}
      onCancel={() => { setDialog(undefined); setDialogError(undefined); requestAnimationFrame(() => search.current?.focus()); }} onSubmit={operation => { void execute(operation, dialogSnapshot.token, dialog.kind === 'commit' && dialog.pushAfterCommit); }} />}
  </>;
}
