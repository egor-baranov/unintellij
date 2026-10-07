import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { JetBrainsIcon } from '../icons';
import type { CommitOptions } from './options';
import './CommitSettings.css';

export interface CommitSettingsProps {
  value: CommitOptions;
  onChange: (value: CommitOptions) => void;
  disabled?: boolean;
}

/** Commit options remain local to the host until it submits a reviewed commit. */
export function CommitSettings({ value, onChange, disabled = false }: CommitSettingsProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ left: number; top: number; maxHeight: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const author = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const authorId = useId();

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect(), popup = panel.current;
      if (!anchor || !popup) return;
      const edge = 8, gap = 6;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const offsetLeft = viewport?.offsetLeft ?? 0, offsetTop = viewport?.offsetTop ?? 0;
      const above = Math.max(0, anchor.top - offsetTop - gap - edge);
      const below = Math.max(0, offsetTop + height - anchor.bottom - gap - edge);
      const naturalHeight = popup.scrollHeight + 2;
      const showAbove = above >= Math.min(naturalHeight, 180) || above >= below;
      const maxHeight = Math.max(0, Math.min(showAbove ? above : below, height - edge * 2));
      const actualHeight = Math.min(naturalHeight, maxHeight);
      const left = Math.max(offsetLeft + edge, Math.min(offsetLeft + width - popup.offsetWidth - edge, anchor.right - popup.offsetWidth));
      const top = Math.max(offsetTop + edge, Math.min(offsetTop + height - actualHeight - edge, showAbove ? anchor.top - gap - actualHeight : anchor.bottom + gap));
      setPlacement(previous => previous?.left === left && previous.top === top && previous.maxHeight === maxHeight ? previous : { left, top, maxHeight });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
    position();
    const observer = new ResizeObserver(schedule);
    if (trigger.current) observer.observe(trigger.current);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [open]);

  const positioned = Boolean(placement);
  useLayoutEffect(() => {
    if (open && positioned) author.current?.focus({ preventScroll: true });
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside, true);
    };
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      const inputs = [...(panel.current?.querySelectorAll<HTMLInputElement>('input:not(:disabled)') ?? [])];
      const first = inputs[0], last = inputs.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }
  }

  const checkbox = (key: 'signOff' | 'checkWhitespace' | 'checkTodo', label: string, description: string) => (
    <label className="commit-settings-option" title={description}>
      <input type="checkbox" checked={value[key]} aria-description={description}
        onChange={event => onChange({ ...value, [key]: event.target.checked })} />
      <span>{label}</span>
    </label>
  );

  return <>
    <button ref={trigger} type="button" className="commit-tool commit-settings" aria-label="Commit settings" title="Commit settings"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} disabled={disabled}
      onClick={() => { if (open) close(true); else { setPlacement(undefined); setOpen(true); } }}
      onKeyDown={event => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setPlacement(undefined); setOpen(true); }
      }}>
      <JetBrainsIcon name="settings" className="commit-icon" />
    </button>
    {open && createPortal(<div ref={panel} id={panelId} className="commit-settings-popup" role="dialog" aria-label="Commit settings"
      onKeyDown={onKeyDown} style={{ left: placement?.left ?? 0, top: placement?.top ?? 0, maxHeight: placement?.maxHeight ?? 'calc(100dvh - 16px)', visibility: placement ? 'visible' : 'hidden' }}>
      <fieldset>
        <legend>Git</legend>
        <label className="commit-settings-author" htmlFor={authorId}>
          <span>Author:</span>
          <input ref={author} id={authorId} type="text" value={value.author} maxLength={4096} spellCheck={false}
            placeholder="Name <email> (optional)" autoComplete="off"
            title="Leave blank to use the repository's configured author."
            onChange={event => onChange({ ...value, author: event.target.value })} />
        </label>
        {checkbox('signOff', 'Sign-off commit', 'Append a Signed-off-by line using your Git committer identity.')}
      </fieldset>
      <fieldset>
        <legend>Commit Checks</legend>
        {checkbox('checkWhitespace', 'Check whitespace', 'Prevent committing new trailing whitespace or whitespace errors.')}
        {checkbox('checkTodo', 'Check TODO', 'Prevent committing newly added lines containing TODO.')}
      </fieldset>
    </div>, document.body)}
  </>;
}
