import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { SplitDirection } from './model';

export function GroupDivider({ root, direction, ratio, onChange, thickness = 5, label = 'Resize editor groups', firstPaneLabel = 'first group' }: {
  root: RefObject<HTMLDivElement | null>; direction: SplitDirection; ratio: number; onChange: (ratio: number) => void;
  thickness?: number; label?: string; firstPaneLabel?: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; start: number; ratio: number; size: number } | null>(null);
  const frame = useRef(0), pending = useRef<number | undefined>(undefined);
  const latest = useRef({ ratio, onChange }); latest.current = { ratio, onChange };
  const [minimum, setMinimum] = useState(.15);
  const [resizing, setResizing] = useState(false);
  const clamp = (value: number) => Math.max(minimum, Math.min(1 - minimum, value));
  function end() {
    cancelAnimationFrame(frame.current); frame.current = 0; pending.current = undefined;
    const id = drag.current?.id; drag.current = null; setResizing(false);
    if (id !== undefined && element.current?.hasPointerCapture(id)) element.current.releasePointerCapture(id);
  }
  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
    const id = drag.current?.id;
    if (id !== undefined && element.current?.hasPointerCapture(id)) element.current.releasePointerCapture(id);
    drag.current = null;
  }, []);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => {
      const size = (direction === 'right' ? node.clientWidth : node.clientHeight) - thickness;
      const next = Math.max(.15, Math.min(.5, (direction === 'right' ? 220 : 160) / Math.max(1, size)));
      setMinimum(next);
      const effective = Math.max(next, Math.min(1 - next, latest.current.ratio));
      if (effective !== latest.current.ratio) latest.current.onChange(effective);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [root, direction, thickness]);

  return <div ref={element} className={`workspace-divider${resizing ? ' is-resizing' : ''}`} role="separator" tabIndex={0} aria-label={label}
    aria-orientation={direction === 'right' ? 'vertical' : 'horizontal'} aria-valuemin={Math.round(minimum * 100)} aria-valuemax={Math.round((1 - minimum) * 100)} aria-valuenow={Math.round(ratio * 100)}
    aria-valuetext={`${Math.round(ratio * 100)}% ${firstPaneLabel}`} title={`${label}; double-click to reset`}
    onDoubleClick={() => onChange(.5)}
    onPointerDown={event => { if (event.button !== 0 || drag.current) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { id: event.pointerId, start: direction === 'right' ? event.clientX : event.clientY, ratio, size: Math.max(1, (direction === 'right' ? root.current!.clientWidth : root.current!.clientHeight) - thickness) }; event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || event.pointerId !== start.id) return;
      pending.current = clamp(start.ratio + ((direction === 'right' ? event.clientX : event.clientY) - start.start) / start.size);
      if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; if (pending.current !== undefined) onChange(pending.current); pending.current = undefined; });
    }}
    onPointerUp={event => { if (event.pointerId === drag.current?.id) { if (pending.current !== undefined) onChange(pending.current); end(); } }}
    onPointerCancel={end} onLostPointerCapture={() => { if (drag.current) end(); }}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const previous = direction === 'right' ? 'ArrowLeft' : 'ArrowUp', next = direction === 'right' ? 'ArrowRight' : 'ArrowDown';
      let value: number;
      if (event.key === previous) value = ratio - (event.shiftKey ? .1 : .02);
      else if (event.key === next) value = ratio + (event.shiftKey ? .1 : .02);
      else if (event.key === 'Home') value = minimum;
      else if (event.key === 'End') value = 1 - minimum;
      else if (event.key === 'Enter') value = .5;
      else if (event.key === 'Escape') { end(); return; }
      else return;
      event.preventDefault(); event.stopPropagation(); onChange(clamp(value));
    }} />;
}
