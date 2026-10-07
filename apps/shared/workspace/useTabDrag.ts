import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { dockPlacement, type DockEdge, type GroupId, type WorkspaceTab } from './model';
import type { EditorWorkspaceController } from './useEditorWorkspace';
import { contentDropEdge, splitDropBounds, tabInsertion, tabReorderLayout } from './tabDrag';

type DragMode = 'reorder' | 'dock';
export type TabDropHint = { kind: 'tabs'; groupId: GroupId; index: number; boundary: number }
  | { kind: 'content'; groupId: GroupId; destination: GroupId; edge?: DockEdge; rounding: DockEdge | 'all'; left: number; top: number; width: number; height: number };
interface TabGesture {
  groupId: GroupId; id: string; instanceId: string; width: number; height: number;
  pointerId: number; button: HTMLButtonElement; shell: HTMLElement; strip: HTMLElement;
  startX: number; startY: number; x: number; y: number; grabX: number; grabY: number;
  active: boolean; mode: DragMode; index: number;
}

/** One captured pointer gesture: slide in the source row, detach outside it.
 * Only release mutates workspace order, so cancellation never rebuilds editors. */
export function useTabDrag(root: RefObject<HTMLDivElement | null>, workspace: EditorWorkspaceController, onCommit: () => void) {
  const dragged = useRef<TabGesture | null>(null);
  const ghost = useRef<HTMLElement | null>(null);
  const projected = useRef(new Set<HTMLElement>());
  const frame = useRef(0);
  const scrolling = useRef<{ element: HTMLElement; groupId: GroupId } | null>(null);
  const currentHint = useRef<TabDropHint | null>(null);
  const suppressClick = useRef(false);
  const [mode, setMode] = useState<DragMode | null>(null);
  const [dropHint, setDropHint] = useState<TabDropHint | null>(null);

  function hint(value: TabDropHint | null) {
    if (JSON.stringify(currentHint.current) === JSON.stringify(value)) return;
    currentHint.current = value; setDropHint(value);
  }
  function clearProjection() {
    for (const element of projected.current) element.style.removeProperty('transform');
    projected.current.clear();
  }
  function stopScroll() { cancelAnimationFrame(frame.current); frame.current = 0; scrolling.current = null; }
  function clear(publish = true) {
    const item = dragged.current;
    dragged.current = null;
    stopScroll(); clearProjection(); ghost.current?.remove(); ghost.current = null;
    currentHint.current = null;
    if (item?.button.hasPointerCapture(item.pointerId)) item.button.releasePointerCapture(item.pointerId);
    if (publish) { setMode(null); setDropHint(null); }
  }
  function stripInsertion(element: HTMLElement, groupId: GroupId, clientX: number): TabDropHint {
    const rect = element.getBoundingClientRect(), scale = rect.width / element.offsetWidth || 1;
    const bounds = (node: HTMLElement) => {
      const box = node.getBoundingClientRect();
      return { left: (box.left - rect.left) / scale + element.scrollLeft, width: box.width / scale };
    };
    const tabs = [...element.querySelectorAll<HTMLElement>('.workspace-tab-shell')].map(shell => ({ id: shell.dataset.documentId!, ...bounds(shell) }));
    const placeholder = element.querySelector<HTMLElement>('.workspace-tab-insertion');
    const slot = placeholder ? { ...bounds(placeholder), boundary: Number(placeholder.dataset.dropBoundary), gap: parseFloat(getComputedStyle(element).columnGap) || 0 } : undefined;
    return { kind: 'tabs', groupId, ...tabInsertion(tabs, dragged.current!.id, (clientX - rect.left) / scale + element.scrollLeft, slot) };
  }
  function paintReorder(item: TabGesture) {
    const strip = item.strip, rect = strip.getBoundingClientRect(), scale = rect.width / strip.offsetWidth || 1;
    const style = getComputedStyle(strip), gap = parseFloat(style.columnGap) || 0;
    const shells = [...strip.querySelectorAll<HTMLElement>('.workspace-tab-shell')];
    // Reconstruct untransformed flex positions, preserving fractional widths.
    // Reading the translated neighbors would feed the preview into hit testing.
    let left = parseFloat(style.paddingLeft) || 0;
    const tabs = shells.map(shell => {
      const width = parseFloat(getComputedStyle(shell).width);
      const bounds = { id: shell.dataset.documentId!, left, width };
      left += width + gap;
      return bounds;
    });
    const layout = tabReorderLayout(tabs, item.id, (item.x - rect.left) / scale + strip.scrollLeft - item.grabX, gap);
    item.index = layout.index;
    for (const shell of shells) {
      shell.style.transform = `translateX(${layout.offsets[shell.dataset.documentId!] ?? 0}px)`;
      projected.current.add(shell);
    }
  }
  function paintGhost(item: TabGesture) {
    if (!ghost.current) {
      const image = item.shell.cloneNode(true) as HTMLElement;
      image.className = 'workspace-tab-drag-image'; image.setAttribute('aria-hidden', 'true');
      image.querySelector('.workspace-tab-close')?.remove();
      image.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
      image.querySelectorAll('button').forEach(node => { node.tabIndex = -1; node.draggable = false; });
      image.style.width = `${item.width}px`; image.style.height = `${item.height}px`;
      document.body.append(image); ghost.current = image;
    }
    ghost.current.style.transform = `translate3d(${item.x - item.grabX}px, ${item.y - item.grabY}px, 0)`;
  }
  function contentHint(element: HTMLElement, groupId: GroupId, item: TabGesture): TabDropHint {
    const content = element.getBoundingClientRect();
    const scaleX = content.width / element.offsetWidth || 1, scaleY = content.height / element.offsetHeight || 1;
    const edge = contentDropEdge(element.offsetWidth, element.offsetHeight, (item.x - content.left) / scaleX, (item.y - content.top) / scaleY);
    const { state } = workspace, host = root.current!, placement = edge ? dockPlacement(edge) : undefined;
    const destination = placement?.destination ?? groupId;
    if (edge) return { kind: 'content', groupId, destination, edge, rounding: edge,
      ...splitDropBounds(host.clientWidth, host.clientHeight, state.splitRatio, placement!.direction, destination) };
    const source = state.groups.find(group => group.id === item.groupId)!;
    const target = element.closest<HTMLElement>('.workspace-group')!;
    const rect = host.getBoundingClientRect(), targetRect = target.getBoundingClientRect();
    const hostScaleX = rect.width / host.offsetWidth || 1, hostScaleY = rect.height / host.offsetHeight || 1;
    const fillsWorkspace = item.groupId !== groupId && source.tabs.length === 1;
    const rounding = fillsWorkspace || state.groups.length === 1 ? 'all' : state.direction === 'right'
      ? groupId === 'primary' ? 'left' : 'right' : groupId === 'primary' ? 'up' : 'down';
    return { kind: 'content', groupId, destination, rounding,
      left: fillsWorkspace ? 0 : (targetRect.left - rect.left) / hostScaleX,
      top: fillsWorkspace ? 0 : (targetRect.top - rect.top) / hostScaleY,
      width: fillsWorkspace ? host.clientWidth : target.offsetWidth, height: fillsWorkspace ? host.clientHeight : target.offsetHeight };
  }
  function scrollTabs() {
    frame.current = 0;
    const target = scrolling.current, item = dragged.current;
    if (!target || !item?.active) return;
    const rect = target.element.getBoundingClientRect(), edge = Math.min(42, rect.width / 4);
    const speed = item.x < rect.left + edge ? -Math.min(12, (rect.left + edge - item.x) / 3)
      : item.x > rect.right - edge ? Math.min(12, (item.x - rect.right + edge) / 3) : 0;
    if (!speed) return;
    const before = target.element.scrollLeft;
    target.element.scrollLeft += speed;
    if (item.mode === 'reorder') paintReorder(item);
    else hint(stripInsertion(target.element, target.groupId, item.x));
    if (before !== target.element.scrollLeft) frame.current = requestAnimationFrame(() => handlers.current.scroll());
  }
  function scrollAt(element: HTMLElement, groupId: GroupId) {
    scrolling.current = { element, groupId };
    if (!frame.current) frame.current = requestAnimationFrame(() => handlers.current.scroll());
  }
  function update(item: TabGesture) {
    const row = item.strip.parentElement!.getBoundingClientRect();
    const inRow = item.x >= row.left && item.x <= row.right && item.y >= row.top && item.y <= row.bottom;
    const nextMode = inRow ? 'reorder' : 'dock';
    if (item.mode !== nextMode) { clearProjection(); item.mode = nextMode; setMode(nextMode); }
    if (inRow) {
      ghost.current?.remove(); ghost.current = null; hint(null);
      paintReorder(item); scrollAt(item.strip, item.groupId);
      return;
    }
    clearProjection(); paintGhost(item);
    // Capture keeps DOM events on the source. Actual geometry underneath the
    // pointer determines the destination, including Monaco's nested elements.
    const target = document.elementFromPoint(item.x, item.y);
    if (!target || !root.current?.contains(target)) { stopScroll(); hint(null); return; }
    const strip = target.closest<HTMLElement>('.workspace-tabbar')?.querySelector<HTMLElement>('.workspace-tabs');
    if (strip) {
      const groupId = strip.dataset.tabGroup as GroupId;
      hint(stripInsertion(strip, groupId, item.x)); scrollAt(strip, groupId);
      return;
    }
    stopScroll();
    const content = target.closest<HTMLElement>('.workspace-content');
    hint(content ? contentHint(content, content.closest<HTMLElement>('.workspace-group')!.dataset.group as GroupId, item) : null);
  }
  function move(event: PointerEvent) {
    const item = dragged.current;
    if (!item || event.pointerId !== item.pointerId) return;
    item.x = event.clientX; item.y = event.clientY;
    if (!item.active) {
      if (Math.hypot(item.x - item.startX, item.y - item.startY) < 4) return;
      item.active = true; suppressClick.current = true; setMode('reorder');
    }
    event.preventDefault(); event.stopPropagation();
    update(item);
  }
  function finish(event: PointerEvent) {
    const item = dragged.current;
    if (!item || event.pointerId !== item.pointerId) return;
    if (!item.active) { clear(); return; }
    event.preventDefault(); event.stopPropagation();
    item.x = event.clientX; item.y = event.clientY; update(item);
    const target = currentHint.current;
    clear();
    if (item.mode === 'reorder') { onCommit(); workspace.move(item.groupId, item.id, item.groupId, item.index); }
    else if (target?.kind === 'tabs') { onCommit(); workspace.move(item.groupId, item.id, target.groupId, target.index); }
    else if (target?.kind === 'content') {
      onCommit();
      if (target.edge) workspace.dock(item.groupId, item.id, target.edge);
      else workspace.move(item.groupId, item.id, target.groupId);
    }
  }
  function start(event: ReactPointerEvent<HTMLButtonElement>, groupId: GroupId, tab: WorkspaceTab) {
    if (event.button !== 0 || !event.isPrimary || dragged.current) return;
    const button = event.currentTarget, shell = button.parentElement!, strip = shell.closest<HTMLElement>('.workspace-tabs')!;
    const box = shell.getBoundingClientRect(), style = getComputedStyle(shell);
    const width = parseFloat(style.width), height = parseFloat(style.height);
    dragged.current = { groupId, id: tab.id, instanceId: tab.instanceId, width, height,
      pointerId: event.pointerId, button, shell, strip, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      grabX: (event.clientX - box.left) / (box.width / width || 1), grabY: (event.clientY - box.top) / (box.height / height || 1),
      active: false, mode: 'reorder', index: workspace.state.groups.find(group => group.id === groupId)!.tabs.indexOf(tab) };
    button.setPointerCapture(event.pointerId);
  }
  const handlers = useRef({ move, finish, clear, scroll: scrollTabs });
  handlers.current = { move, finish, clear, scroll: scrollTabs };
  useEffect(() => {
    const pointerMove = (event: PointerEvent) => handlers.current.move(event);
    const pointerUp = (event: PointerEvent) => handlers.current.finish(event);
    const cancel = () => handlers.current.clear();
    const pointerCancel = (event: PointerEvent) => { if (event.pointerId === dragged.current?.pointerId) cancel(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && dragged.current) { event.preventDefault(); event.stopPropagation(); cancel(); } };
    const click = (event: MouseEvent) => {
      // A canceled pointer may never emit a click. Do not consume a later
      // keyboard/assistive activation while waiting for that trailing event.
      if (suppressClick.current && event.detail > 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
    };
    const down = () => { if (!dragged.current) suppressClick.current = false; };
    window.addEventListener('pointermove', pointerMove, { capture: true, passive: false });
    window.addEventListener('pointerup', pointerUp, true);
    window.addEventListener('pointercancel', pointerCancel, true); window.addEventListener('lostpointercapture', pointerCancel, true);
    window.addEventListener('blur', cancel); window.addEventListener('resize', cancel); window.addEventListener('keydown', key, true);
    window.addEventListener('click', click, true); window.addEventListener('pointerdown', down, true);
    return () => {
      handlers.current.clear(false);
      window.removeEventListener('pointermove', pointerMove, true); window.removeEventListener('pointerup', pointerUp, true);
      window.removeEventListener('pointercancel', pointerCancel, true); window.removeEventListener('lostpointercapture', pointerCancel, true);
      window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); window.removeEventListener('keydown', key, true);
      window.removeEventListener('click', click, true); window.removeEventListener('pointerdown', down, true);
    };
  }, []);
  useLayoutEffect(() => {
    const item = dragged.current;
    if (!item) return;
    if (!workspace.state.groups.some(group => group.id === item.groupId && group.tabs.some(tab => tab.instanceId === item.instanceId && tab.id === item.id))) clear();
    else if (item.active && item.mode === 'reorder') paintReorder(item);
  }, [workspace.state.groups, mode]);
  return { dragged, mode, dropHint, start };
}
