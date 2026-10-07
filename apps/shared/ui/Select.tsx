import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { UiIcon } from './UiIcon';
import './select.css';

export interface SelectOption<T extends string = string> { value: T; label: string; disabled?: boolean }
export interface SelectProps<T extends string = string> {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** An adjacent editable field already displays the value (font suggestions). */
  compact?: boolean;
}

/** Renderer-owned select. The HTML popover top layer escapes scrolling forms
 * while remaining inside a modal dialog's focus scope; no native select menu. */
export function Select<T extends string>({ label, value, options, onChange, disabled, compact }: SelectProps<T>) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string>();
  const [placement, setPlacement] = useState<{ left: number; top: number; width: number; maxHeight: number }>();
  const search = useRef({ text: '', time: 0 });
  const enabled = options.filter(option => !option.disabled);
  const selected = options.find(option => option.value === value);
  const activeIndex = options.findIndex(option => option.value === active);
  function close() { panel.current?.hidePopover(); setOpen(false); search.current.text = ''; }
  function show() {
    if (disabled) return;
    setActive(enabled.find(option => option.value === value)?.value ?? enabled[0]?.value);
    setPlacement(undefined); setOpen(true);
  }
  function choose(option: SelectOption<T>) {
    if (option.disabled) return;
    close(); trigger.current?.focus({ preventScroll: true }); onChange(option.value);
  }
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const popup = panel.current;
    popup.showPopover();
    let frame = 0;
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const edge = 8, gap = 4;
      const width = Math.min(Math.max(anchor.width, compact ? 280 : 160), window.innerWidth - 2 * edge);
      popup.style.width = `${width}px`;
      const below = window.innerHeight - anchor.bottom - gap - edge, above = anchor.top - gap - edge;
      const naturalHeight = popup.scrollHeight + 2;
      const down = below >= Math.min(320, naturalHeight) || below >= above;
      const maxHeight = Math.max(24, Math.min(320, down ? below : above));
      const height = Math.min(naturalHeight, maxHeight);
      const left = Math.max(edge, Math.min(window.innerWidth - width - edge, compact ? anchor.right - width : anchor.left));
      const top = Math.max(edge, down ? anchor.bottom + gap : anchor.top - gap - height);
      setPlacement(previous => previous?.left === left && previous.top === top && previous.width === width && previous.maxHeight === maxHeight ? previous : { left, top, width, maxHeight });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
    position();
    const observer = new ResizeObserver(schedule);
    observer.observe(popup); if (trigger.current) observer.observe(trigger.current);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    const blur = () => close();
    document.addEventListener('pointerdown', outside, true); window.addEventListener('blur', blur);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true);
      document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', blur);
      popup.hidePopover();
    };
  }, [open, compact]);
  useLayoutEffect(() => {
    if (open && placement && active) rows.current.get(active)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, placement?.maxHeight]);
  useEffect(() => {
    if (disabled && open) close();
    if (open && !enabled.some(option => option.value === active)) setActive(enabled[0]?.value);
  }, [disabled, open, active, options]);

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { if (open) close(); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation();
      if (!open) show(); else { const option = enabled.find(option => option.value === active); if (option) choose(option); }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!open) {
        show();
        if (event.key === 'Home') setActive(enabled[0]?.value);
        if (event.key === 'End') setActive(enabled.at(-1)?.value);
        return;
      }
      const index = enabled.findIndex(option => option.value === active);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      setActive(enabled[next]?.value); return;
    }
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    if (!open) show();
    const now = performance.now();
    search.current.text = (now - search.current.time < 700 ? search.current.text : '') + event.key.toLocaleLowerCase();
    search.current.time = now;
    const letters = [...search.current.text], query = letters.every(letter => letter === letters[0]) ? letters[0] : search.current.text;
    const index = enabled.findIndex(option => option.value === (open ? active : value));
    for (let offset = 1; offset <= enabled.length; offset++) {
      const option = enabled[(index + offset + enabled.length) % enabled.length];
      if (option.label.toLocaleLowerCase().startsWith(query)) { setActive(option.value); break; }
    }
  }
  return <div className={`ui-select${compact ? ' ui-select-compact' : ''}`}>
    <button ref={trigger} type="button" role="combobox" className="ui-select-trigger" aria-label={label} title={label}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined} disabled={disabled}
      onClick={() => open ? close() : show()} onKeyDown={keyDown} onBlur={() => { if (open) close(); }}>
      {!compact && <span>{selected?.label ?? value}</span>}<UiIcon name="chevron-down" />
    </button>
    {open && <div ref={panel} id={id} role="listbox" aria-label={label} popover="manual" className="ui-select-popup"
      style={{ ...placement, visibility: placement ? 'visible' : 'hidden' }} onPointerDown={event => event.preventDefault()}>
      {options.map((option, index) => <div key={option.value} ref={node => { if (node) rows.current.set(option.value, node); else rows.current.delete(option.value); }}
        id={`${id}-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
        className={`ui-select-option${active === option.value ? ' is-active' : ''}`} onPointerMove={() => { if (!option.disabled) setActive(option.value); }} onClick={() => choose(option)}>
        <span className="ui-select-check">{option.value === value && <UiIcon name="check" />}</span><span>{option.label}</span>
      </div>)}
    </div>}
  </div>;
}
