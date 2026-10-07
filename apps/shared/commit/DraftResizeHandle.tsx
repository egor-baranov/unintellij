import { useEffect, useRef, useState, type RefObject } from 'react';

/** Resizes the message from its top edge, leaving the file tree and actions usable. */
export function DraftResizeHandle({ message, tree, visible }: {
  message: RefObject<HTMLTextAreaElement | null>;
  tree: RefObject<HTMLDivElement | null>;
  visible: boolean;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; y: number; height: number } | null>(null);
  const frame = useRef(0);
  const pending = useRef<number | undefined>(undefined);
  const [bounds, setBounds] = useState({ minimum: 65, maximum: 240, value: 65 });

  function geometry() {
    const input = message.current, files = tree.current;
    const panel = files?.parentElement, footer = input?.parentElement;
    if (!input || !files || !panel || !footer || !panel.clientHeight || !input.clientHeight) return;
    const value = input.getBoundingClientRect().height;
    const minimum = parseFloat(getComputedStyle(input).minHeight) || 65;
    const treeMinimum = parseFloat(getComputedStyle(files).minHeight) || 100;
    const available = panel.getBoundingClientRect().bottom - files.getBoundingClientRect().top;
    const overhead = footer.getBoundingClientRect().height - value;
    return { minimum, maximum: Math.max(minimum, available - treeMinimum - overhead), value };
  }
  function resize(height?: number) {
    const input = message.current;
    if (!input) return;
    if (height === undefined) input.style.removeProperty('height');
    const next = geometry();
    if (!next) return;
    const value = Math.max(next.minimum, Math.min(next.maximum, height ?? next.value));
    if (height !== undefined || Math.abs(value - next.value) > .5) input.style.height = `${value}px`;
    setBounds(previous => previous.minimum === next.minimum && previous.maximum === next.maximum && previous.value === value
      ? previous : { ...next, value });
  }
  function end() {
    cancelAnimationFrame(frame.current); frame.current = 0; pending.current = undefined;
    const id = drag.current?.id; drag.current = null;
    if (id !== undefined && handle.current?.hasPointerCapture(id)) handle.current.releasePointerCapture(id);
  }
  // Wait for the following textarea sibling's ref to be attached before observing.
  useEffect(() => {
    if (!visible) { end(); return; }
    const input = message.current, files = tree.current;
    if (!input || !files) return;
    let measurement = 0;
    const measure = () => {
      const next = geometry();
      if (!next) return;
      if (next.value > next.maximum + .5 || next.value < next.minimum - .5) resize(next.value);
      else setBounds(previous => previous.minimum === next.minimum && previous.maximum === next.maximum && previous.value === next.value ? previous : next);
    };
    const observer = new ResizeObserver(() => { cancelAnimationFrame(measurement); measurement = requestAnimationFrame(measure); });
    for (const node of [input, files, input.parentElement, files.parentElement]) if (node) observer.observe(node);
    measure();
    return () => { observer.disconnect(); cancelAnimationFrame(measurement); end(); };
  }, [visible, message, tree]);

  return <div ref={handle} className="commit-draft-resizer" role="separator" tabIndex={0}
    aria-label="Resize commit message" aria-orientation="horizontal" aria-controls={message.current?.id}
    aria-valuemin={Math.round(bounds.minimum)} aria-valuemax={Math.round(bounds.maximum)} aria-valuenow={Math.round(bounds.value)}
    aria-valuetext={`${Math.round(bounds.value)} pixels`} title="Drag to resize commit message; double-click to reset"
    onDoubleClick={() => resize()}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      const size = geometry(); if (!size) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
      drag.current = { id: event.pointerId, y: event.clientY, height: size.value };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const start = drag.current; if (!start || start.id !== event.pointerId) return;
      pending.current = start.height + start.y - event.clientY;
      if (!frame.current) frame.current = requestAnimationFrame(() => {
        frame.current = 0; if (pending.current !== undefined) resize(pending.current); pending.current = undefined;
      });
    }}
    onPointerUp={event => {
      const start = drag.current; if (!start || start.id !== event.pointerId) return;
      resize(start.height + start.y - event.clientY); end();
    }} onPointerCancel={end} onLostPointerCapture={end}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const size = geometry(); if (!size) return;
      const step = event.shiftKey ? 40 : 10;
      switch (event.key) {
        case 'ArrowUp': resize(size.value + step); break;
        case 'ArrowDown': resize(size.value - step); break;
        case 'Home': resize(size.minimum); break;
        case 'End': resize(size.maximum); break;
        case 'Enter': resize(); break;
        case 'Escape': end(); break;
        default: return;
      }
      event.preventDefault(); event.stopPropagation();
    }} />;
}
