import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { changeDialogBounds, clampDialogBounds, defaultDialogBounds, type DialogBounds, type DialogGesture } from './dialogBounds';

// Remember geometry only for this application window's session.
let rememberedBounds: DialogBounds | undefined;
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

export function useDialogFrame(dialog: RefObject<HTMLDialogElement | null>) {
  const [bounds, setBounds] = useState(() => rememberedBounds ? clampDialogBounds(rememberedBounds, viewport()) : defaultDialogBounds(viewport()));
  const current = useRef(bounds);
  const drag = useRef<{ id: number; kind: DialogGesture; x: number; y: number; bounds: DialogBounds; capture: HTMLElement } | null>(null);
  const frame = useRef(0);
  const pending = useRef<DialogBounds | null>(null);
  const [gesture, setGesture] = useState<DialogGesture | null>(null);

  function commit(next: DialogBounds) {
    current.current = next; rememberedBounds = next; setBounds(next);
  }
  function finish(cancel = false) {
    cancelAnimationFrame(frame.current); frame.current = 0;
    const start = drag.current;
    if (cancel && start) commit(clampDialogBounds(start.bounds, viewport()));
    else if (pending.current) commit(pending.current);
    pending.current = null; drag.current = null; setGesture(null);
    if (start?.capture.hasPointerCapture(start.id)) start.capture.releasePointerCapture(start.id);
  }
  useEffect(() => {
    const resize = () => { finish(); commit(clampDialogBounds(current.current, viewport())); };
    const blur = () => finish();
    window.addEventListener('resize', resize);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('resize', resize); window.removeEventListener('blur', blur);
      cancelAnimationFrame(frame.current);
      const start = drag.current;
      drag.current = null; pending.current = null;
      if (start?.capture.hasPointerCapture(start.id)) start.capture.releasePointerCapture(start.id);
    };
  }, [dialog]);

  function begin(event: PointerEvent<HTMLElement>, kind: DialogGesture) {
    if (event.button !== 0 || !event.isPrimary || drag.current || !dialog.current) return;
    event.preventDefault(); event.stopPropagation();
    const next = clampDialogBounds(current.current, viewport());
    // Keep clicks/double-clicks targeted at the title, rather than retargeting
    // them to the dialog when the pointer is released after a stationary press.
    const capture = event.target instanceof HTMLElement ? event.target : event.currentTarget;
    drag.current = { id: event.pointerId, kind, x: event.clientX, y: event.clientY, bounds: next, capture };
    capture.setPointerCapture(event.pointerId);
    setGesture(kind);
  }
  function move(event: PointerEvent<HTMLDialogElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    pending.current = changeDialogBounds(start.bounds, start.kind, event.clientX - start.x, event.clientY - start.y, viewport());
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (pending.current) { commit(pending.current); pending.current = null; }
    });
  }
  function reset() { finish(); commit(defaultDialogBounds(viewport())); }
  function keyDown(event: KeyboardEvent<HTMLElement>, kind: 'move' | 'se') {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const delta = event.shiftKey ? 40 : 10;
    const offsets: Record<string, [number, number]> = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] };
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); reset(); return; }
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault(); event.stopPropagation();
    finish(); commit(changeDialogBounds(current.current, kind, ...offset, viewport()));
  }
  return { bounds, gesture, begin, move, reset, keyDown, cancel: () => finish(true),
    end: (event: PointerEvent<HTMLDialogElement>) => { if (drag.current?.id === event.pointerId) finish(); },
  };
}
