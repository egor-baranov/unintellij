import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { UiIcon } from './UiIcon';
import './ui.css';

export interface MenuAction {
  id: string;
  label: string;
  kind?: 'item' | 'checkbox' | 'radio';
  onSelect: () => void | Promise<void>;
  icon?: ReactNode;
  description?: string;
  title?: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  className?: string;
}
export type MenuEntry = MenuAction | { id: string; kind: 'separator' } | { id: string; kind: 'label'; label: string };
export interface MenuButtonProps {
  label: string;
  children?: ReactNode;
  items: MenuEntry[];
  align?: 'start' | 'end';
  showChevron?: boolean;
  className?: string;
  menuClassName?: string;
  title?: string;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}
const isAction = (entry: MenuEntry): entry is MenuAction => entry.kind !== 'separator' && entry.kind !== 'label';

/** A keyboard-operable, portal-mounted menu. Presentation remains host-owned. */
export function MenuButton({ label, children, items, align = 'end', showChevron = true, className = '', menuClassName = '', title, disabled, onOpenChange }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  const [placement, setPlacement] = useState<{ left: number; top: number; maxHeight: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const rowElements = useRef(new Map<string, HTMLButtonElement>());
  const search = useRef('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const menuId = useId();
  const actions = useMemo(() => items.filter(isAction), [items]);
  const enabled = useMemo(() => actions.filter(item => !item.disabled), [actions]);
  const latest = useRef({ onOpenChange }); latest.current = { onOpenChange };

  function close(restoreFocus: boolean) {
    setOpen(false); setPlacement(undefined); search.current = '';
    clearTimeout(searchTimer.current);
    latest.current.onOpenChange?.(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function show(initial: 'first' | 'last' | 'checked' = 'checked') {
    if (disabled) return;
    const active = initial === 'last' ? enabled.at(-1) : initial === 'checked' ? enabled.find(item => item.checked) ?? enabled[0] : enabled[0];
    setActiveId(active?.id); setPlacement(undefined); setOpen(true);
    latest.current.onOpenChange?.(true);
  }
  function activate(item: MenuAction) {
    if (item.disabled) return;
    close(true);
    void item.onSelect();
  }
  useEffect(() => () => clearTimeout(searchTimer.current), []);
  useEffect(() => {
    if (open && activeId && !enabled.some(item => item.id === activeId)) setActiveId(enabled[0]?.id);
  }, [open, activeId, enabled]);

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    function position() {
      const anchor = trigger.current?.getBoundingClientRect(), panel = menu.current;
      if (!anchor || !panel) return;
      const edge = 8, gap = 5;
      const below = Math.max(0, window.innerHeight - anchor.bottom - gap - edge);
      const above = Math.max(0, anchor.top - gap - edge);
      const naturalHeight = panel.scrollHeight + 2;
      const showBelow = below >= Math.min(560, naturalHeight) || below >= above;
      const maxHeight = Math.min(560, Math.max(24, showBelow ? below : above), window.innerHeight - edge * 2);
      const height = Math.min(naturalHeight, maxHeight);
      const left = Math.max(edge, Math.min(window.innerWidth - panel.offsetWidth - edge, align === 'start' ? anchor.left : anchor.right - panel.offsetWidth));
      const top = Math.max(edge, Math.min(window.innerHeight - height - edge, showBelow ? anchor.bottom + gap : anchor.top - gap - height));
      setPlacement(previous => previous?.left === left && previous.top === top && previous.maxHeight === maxHeight ? previous : { left, top, maxHeight });
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
    position();
    const observer = new ResizeObserver(schedule);
    if (trigger.current) observer.observe(trigger.current);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true); };
  }, [open, align]);

  useLayoutEffect(() => {
    if (!open || !placement) return;
    const active = activeId ? rowElements.current.get(activeId) : undefined;
    if (active) { active.focus({ preventScroll: true }); active.scrollIntoView({ block: 'nearest' }); }
    else menu.current?.focus({ preventScroll: true });
  }, [open, activeId, placement?.maxHeight]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [open]);

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = enabled.findIndex(item => item.id === activeId);
    const move = (offset: number) => { if (enabled.length) setActiveId(enabled[(index + offset + enabled.length) % enabled.length].id); };
    switch (event.key) {
      case 'Escape': event.preventDefault(); event.stopPropagation(); close(true); return;
      case 'Tab': close(true); return;
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'Home': setActiveId(enabled[0]?.id); break;
      case 'End': setActiveId(enabled.at(-1)?.id); break;
      case 'Enter': case ' ': { const item = enabled.find(entry => entry.id === activeId); if (item) activate(item); break; }
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        search.current += event.key.toLocaleLowerCase();
        clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => { search.current = ''; }, 700);
        const chars = [...search.current];
        const query = chars.every(char => char === chars[0]) ? chars[0] : search.current;
        for (let offset = 1; offset <= enabled.length; offset++) {
          const item = enabled[(Math.max(-1, index) + offset) % enabled.length];
          if (item.label.toLocaleLowerCase().startsWith(query)) { setActiveId(item.id); break; }
        }
      }
    }
    event.preventDefault(); event.stopPropagation();
  }
  return <>
    <button ref={trigger} type="button" className={`ui-menu-trigger ${className}`} aria-label={label} title={title ?? label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled}
      onClick={() => { if (open) close(false); else show(); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp' ? 'last' : 'first'); } }}>
      {children ?? label}{showChevron && <UiIcon name="chevron-down" className="ui-menu-chevron" />}
    </button>
    {open && createPortal(<div ref={menu} id={menuId} role="menu" aria-label={label} tabIndex={-1} className={`ui-menu ${menuClassName}`}
      style={{ left: placement?.left ?? 0, top: placement?.top ?? 0, maxHeight: placement?.maxHeight ?? 'calc(100vh - 16px)', visibility: placement ? 'visible' : 'hidden' }} onKeyDown={onMenuKey}>
      {items.map(entry => entry.kind === 'separator' ? <div key={entry.id} className="ui-menu-separator" role="separator" /> : entry.kind === 'label' ? <div key={entry.id} className="ui-menu-label" role="presentation">{entry.label}</div> :
        <button key={entry.id} ref={element => { if (element) rowElements.current.set(entry.id, element); else rowElements.current.delete(entry.id); }} type="button"
          role={entry.kind === 'checkbox' ? 'menuitemcheckbox' : entry.kind === 'radio' ? 'menuitemradio' : 'menuitem'} aria-label={entry.label}
          aria-description={entry.description} title={entry.title} aria-checked={entry.kind === 'radio' || entry.kind === 'checkbox' ? Boolean(entry.checked) : undefined} aria-disabled={entry.disabled || undefined}
          disabled={entry.disabled} tabIndex={activeId === entry.id ? 0 : -1} className={`ui-menu-item ${entry.className ?? ''}${activeId === entry.id ? ' is-active' : ''}`}
          onPointerMove={() => { if (!entry.disabled) setActiveId(entry.id); }} onFocus={() => setActiveId(entry.id)} onClick={() => activate(entry)}>
          <span className="ui-menu-icon">{entry.checked ? <UiIcon name="check" /> : entry.icon}</span>
          <span className="ui-menu-copy"><span className="ui-menu-item-label">{entry.label}</span>{entry.description && <span className="ui-menu-description" title={entry.title ?? entry.description}>{entry.description}</span>}</span>
          {entry.shortcut && <span className="ui-menu-shortcut">{entry.shortcut}</span>}
        </button>)}
    </div>, document.body)}
  </>;
}
