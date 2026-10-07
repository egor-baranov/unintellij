import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { MenuAction, MenuEntry } from './MenuButton';
import { UiIcon } from './UiIcon';
import './ui.css';
import './context-menu.css';

export interface ContextMenuSubmenu extends Omit<MenuAction, 'onSelect' | 'kind' | 'checked'> {
  kind?: 'submenu';
  items: ContextMenuEntry[];
}
export type ContextMenuEntry = MenuEntry | ContextMenuSubmenu;
export interface ContextMenuProps {
  label: string;
  /** Viewport coordinates, for example PointerEvent.clientX/clientY. */
  position: { x: number; y: number };
  items: ContextMenuEntry[];
  onClose: () => void;
  /** Omit to restore the element focused when the menu mounted; null disables restoration. */
  returnFocus?: HTMLElement | null;
}
type Action = MenuAction | ContextMenuSubmenu;
const isAction = (entry: ContextMenuEntry): entry is Action => entry.kind !== 'separator' && entry.kind !== 'label';
const isSubmenu = (entry: Action): entry is ContextMenuSubmenu => 'items' in entry;

/** Renderer-owned context menus. Hosts resolve capabilities and async actions. */
export function ContextMenu({ label, position, items, onClose, returnFocus }: ContextMenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const latest = useRef({ onClose, returnFocus }); latest.current = { onClose, returnFocus };
  const closed = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const dismiss = useCallback((restore = true) => {
    if (closed.current) return;
    closed.current = true;
    // Remove the popup before an action opens another surface or moves focus.
    flushSync(() => setDismissed(true));
    const target = latest.current.returnFocus === undefined ? initialFocus.current : latest.current.returnFocus;
    if (restore && target?.isConnected) target.focus({ preventScroll: true });
    latest.current.onClose();
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) dismiss();
    };
    const blur = () => dismiss(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', blur); };
  }, [dismiss]);
  if (dismissed) return null;
  return createPortal(<div ref={root} className="ui-context-root" onContextMenu={event => event.preventDefault()}>
    <ContextPanel label={label} position={position} items={items} depth={0} focusRequest={1} dismiss={dismiss} />
  </div>, document.body);
}

interface PanelProps {
  label: string;
  items: ContextMenuEntry[];
  depth: number;
  position?: { x: number; y: number };
  anchor?: HTMLElement;
  focusRequest: number;
  dismiss: (restore?: boolean) => void;
  onBack?: () => void;
  onEntered?: () => void;
  id?: string;
}
interface Placement { left: number; top: number; maxHeight: number; minWidth: number; maxWidth: number }

function ContextPanel({ label, items, depth, position, anchor, focusRequest, dismiss, onBack, onEntered, id }: PanelProps) {
  const ownId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const actions = useMemo(() => items.filter(isAction), [items]);
  const enabled = useMemo(() => actions.filter(item => !item.disabled), [actions]);
  const [activeId, setActiveId] = useState<string | undefined>(() => enabled[0]?.id);
  const [submenu, setSubmenu] = useState<{ id: string; focus: number }>();
  const [placement, setPlacement] = useState<Placement>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nextFocus = useRef(0);
  const pendingFocus = useRef(focusRequest > 0);
  const search = useRef({ text: '', time: 0 });
  const child = actions.find(item => item.id === submenu?.id && !item.disabled && isSubmenu(item));
  const childMenu = child && isSubmenu(child) ? child : undefined;
  const childAnchor = childMenu ? rows.current.get(childMenu.id) : undefined;
  function clearHover() { clearTimeout(hoverTimer.current); hoverTimer.current = undefined; }
  function select(id: string | undefined) {
    pendingFocus.current = true; setActiveId(id);
    // A pointer can enter the already-active first row of a hover-opened child;
    // the ID then stays equal, so focus cannot depend on a state update alone.
    if (placement) {
      const target = rows.current.get(id ?? '');
      (target ?? panel.current)?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
      pendingFocus.current = false;
    }
  }
  function openSubmenu(item: ContextMenuSubmenu, focus: boolean) {
    clearHover(); setActiveId(item.id);
    setSubmenu(previous => previous?.id === item.id && !focus ? previous : { id: item.id, focus: focus ? ++nextFocus.current : 0 });
  }
  function activate(item: Action) {
    if (item.disabled) return;
    if (isSubmenu(item)) { openSubmenu(item, true); return; }
    dismiss();
    void item.onSelect();
  }
  function pointAt(item: Action) {
    clearHover();
    if (item.disabled) return;
    select(item.id);
    // The small delay lets the pointer cross neighboring rows into an open
    // submenu. Entering a child cancels its ancestor's pending replacement.
    hoverTimer.current = setTimeout(() => {
      if (isSubmenu(item)) openSubmenu(item, false); else setSubmenu(undefined);
    }, 160);
  }
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => {
    if (!enabled.some(item => item.id === activeId)) select(enabled[0]?.id);
    if (submenu && !childMenu) setSubmenu(undefined);
  }, [enabled, activeId, submenu, childMenu]);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    pendingFocus.current = true;
    const target = rows.current.get(activeId ?? '');
    if (placement) { (target ?? panel.current)?.focus({ preventScroll: true }); pendingFocus.current = false; }
  }, [focusRequest]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    let frame = 0;
    const place = () => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      // CSS UI scale already affects dimensions; these ratios also account for
      // any host CSS zoom without mixing viewport and layout coordinates.
      const zoomX = rect.width / (Number.parseFloat(style.width) || rect.width) || 1;
      const zoomY = rect.height / (Number.parseFloat(style.height) || rect.height) || 1;
      const originX = rect.left - (Number.parseFloat(element.style.left) || 0) * zoomX;
      const originY = rect.top - (Number.parseFloat(element.style.top) || 0) * zoomY;
      const uiScale = Number.parseFloat(style.getPropertyValue('--ui-scale')) || 1;
      const edge = 8;
      const availableWidth = Math.max(1, window.innerWidth - edge * 2);
      const availableHeight = Math.max(1, window.innerHeight - edge * 2);
      const maxWidth = Math.min(390 * uiScale, availableWidth / zoomX);
      const minWidth = Math.min(224 * uiScale, maxWidth);
      const width = Math.min(rect.width, maxWidth * zoomX);
      const maxHeight = Math.min(560 * uiScale, availableHeight / zoomY);
      const borders = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
      const height = Math.min((element.scrollHeight + borders) * zoomY, maxHeight * zoomY);
      let left = position?.x ?? edge, top = position?.y ?? edge;
      if (anchor) {
        const row = anchor.getBoundingClientRect();
        const parent = anchor.closest('[role="menu"]')?.getBoundingClientRect() ?? row;
        const roomRight = window.innerWidth - parent.right - edge;
        const roomLeft = parent.left - edge;
        left = roomRight >= width - 2 || roomRight >= roomLeft ? parent.right - 2 : parent.left - width + 2;
        top = row.top - Number.parseFloat(style.paddingTop) * zoomY;
      }
      left = Math.max(edge, Math.min(window.innerWidth - width - edge, left));
      top = Math.max(edge, Math.min(window.innerHeight - height - edge, top));
      const next = { left: (left - originX) / zoomX, top: (top - originY) / zoomY, maxHeight, minWidth, maxWidth };
      setPlacement(previous => previous && Object.keys(next).every(key => previous[key as keyof Placement] === next[key as keyof Placement]) ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    const observer = new ResizeObserver(schedule);
    observer.observe(element); if (anchor) observer.observe(anchor);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true); };
  }, [anchor, position?.x, position?.y, items]);
  useLayoutEffect(() => {
    if (!placement || !pendingFocus.current) return;
    const target = rows.current.get(activeId ?? '');
    (target ?? panel.current)?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
    pendingFocus.current = false;
  }, [activeId, placement]);

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    clearHover();
    const index = enabled.findIndex(item => item.id === activeId);
    const current = enabled[index];
    switch (event.key) {
      case 'Escape': event.preventDefault(); dismiss(); return;
      case 'Tab': dismiss(); return;
      case 'ArrowLeft': event.preventDefault(); onBack?.(); return;
      case 'ArrowRight': event.preventDefault(); if (current && isSubmenu(current)) openSubmenu(current, true); return;
      case 'Enter': case ' ': event.preventDefault(); if (current) activate(current); return;
      case 'ArrowDown': case 'ArrowUp': {
        event.preventDefault(); setSubmenu(undefined);
        if (enabled.length) select(enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length].id);
        return;
      }
      case 'Home': case 'End': event.preventDefault(); setSubmenu(undefined); select(event.key === 'Home' ? enabled[0]?.id : enabled.at(-1)?.id); return;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        const now = performance.now();
        search.current.text = (now - search.current.time < 700 ? search.current.text : '') + event.key.toLocaleLowerCase();
        search.current.time = now;
        const chars = [...search.current.text], query = chars.every(char => char === chars[0]) ? chars[0] : search.current.text;
        for (let offset = 1; offset <= enabled.length; offset++) {
          const item = enabled[(Math.max(-1, index) + offset) % enabled.length];
          if (item.label.toLocaleLowerCase().startsWith(query)) { setSubmenu(undefined); select(item.id); break; }
        }
      }
    }
  }

  return <>
    <div ref={panel} id={id ?? ownId} role="menu" aria-label={label} tabIndex={-1}
      className="ui-menu ui-context-menu" data-menu-depth={depth}
      style={{ ...placement, left: placement?.left ?? 0, top: placement?.top ?? 0, zIndex: 1600 + depth, visibility: placement ? 'visible' : 'hidden' }}
      onKeyDown={keyDown} onPointerEnter={onEntered}>
      {items.map(entry => entry.kind === 'separator' ? <div key={entry.id} className="ui-menu-separator" role="separator" />
        : entry.kind === 'label' ? <div key={entry.id} className="ui-menu-label" role="presentation">{entry.label}</div>
          : <button key={entry.id} ref={element => { if (element) rows.current.set(entry.id, element); else rows.current.delete(entry.id); }}
            type="button" role={entry.kind === 'checkbox' ? 'menuitemcheckbox' : entry.kind === 'radio' ? 'menuitemradio' : 'menuitem'}
            aria-label={entry.label} aria-description={entry.description}
            aria-checked={entry.kind === 'checkbox' || entry.kind === 'radio' ? !!entry.checked : undefined}
            aria-haspopup={isSubmenu(entry) ? 'menu' : undefined} aria-expanded={isSubmenu(entry) ? childMenu?.id === entry.id : undefined}
            aria-controls={isSubmenu(entry) && childMenu?.id === entry.id ? `${ownId}-submenu` : undefined}
            aria-disabled={entry.disabled || undefined} disabled={entry.disabled} tabIndex={activeId === entry.id ? 0 : -1}
            className={`ui-menu-item ${entry.className ?? ''}${activeId === entry.id ? ' is-active' : ''}`}
            onPointerEnter={() => pointAt(entry)} onFocus={() => setActiveId(entry.id)} onClick={() => activate(entry)}>
            <span className="ui-menu-icon">{!isSubmenu(entry) && entry.checked ? <UiIcon name="check" /> : entry.icon}</span>
            <span className="ui-menu-copy"><span className="ui-menu-item-label">{entry.label}</span>{entry.description && <span className="ui-menu-description" title={entry.description}>{entry.description}</span>}</span>
            {entry.shortcut && <span className="ui-menu-shortcut">{entry.shortcut}</span>}
            {isSubmenu(entry) && <UiIcon name="chevron-right" size={12} className="ui-context-arrow" />}
          </button>)}
    </div>
    {childMenu && childAnchor && <ContextPanel key={childMenu.id} id={`${ownId}-submenu`} label={childMenu.label} items={childMenu.items} depth={depth + 1}
      anchor={childAnchor} focusRequest={submenu!.focus} dismiss={dismiss}
      onEntered={() => { clearHover(); setActiveId(childMenu.id); onEntered?.(); }}
      onBack={() => { clearHover(); setSubmenu(undefined); select(childMenu.id); rows.current.get(childMenu.id)?.focus({ preventScroll: true }); }} />}
  </>;
}
