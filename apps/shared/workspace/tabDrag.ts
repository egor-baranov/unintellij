import type { DockEdge, GroupId, SplitDirection } from './model';

export const editorGroupDividerThicknessPx = 1;

export interface TabDragBounds { id: string; left: number; width: number }
export interface TabInsertion { index: number; boundary: number }
export interface TabReorderLayout { index: number; offsets: Record<string, number> }
export interface TabPlaceholderBounds { boundary: number; left: number; width: number; gap: number }
export interface SplitDropBounds { left: number; top: number; width: number; height: number }

/** All four edges use the same hit depth. At corners the nearest normalized
 * edge wins; the center remains a move target. Inputs are local CSS pixels. */
export function contentDropEdge(width: number, height: number, x: number, y: number): DockEdge | undefined {
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x > width || y > height) return;
  const horizontal = Math.min(160, width * .24), vertical = Math.min(130, height * .24);
  const candidates: { edge: DockEdge; distance: number }[] = [
    { edge: 'left', distance: x / horizontal },
    { edge: 'right', distance: (width - x) / horizontal },
    { edge: 'up', distance: y / vertical },
    { edge: 'down', distance: (height - y) / vertical },
  ];
  const nearest = candidates.reduce((best, candidate) => candidate.distance < best.distance ? candidate : best);
  return nearest.distance < 1 ? nearest.edge : undefined;
}

/** Bounds and pointer share the tab strip's scroll coordinate system. Keep an
 * existing slot stable while hovering it, including either adjoining half-gap.
 * Boundary addresses the rendered tabs; index addresses the destination after
 * removing its existing copy of the dragged document. */
export function tabInsertion(tabs: readonly TabDragBounds[], draggedId: string, pointerX: number, placeholder?: TabPlaceholderBounds): TabInsertion {
  const next = tabs.findIndex(tab => pointerX < tab.left + tab.width / 2);
  const withinPlaceholder = placeholder && pointerX >= placeholder.left - placeholder.gap / 2
    && pointerX <= placeholder.left + placeholder.width + placeholder.gap / 2;
  const boundary = withinPlaceholder ? Math.min(tabs.length, placeholder.boundary) : next < 0 ? tabs.length : next;
  const existing = tabs.findIndex(tab => tab.id === draggedId);
  return { index: boundary - Number(existing >= 0 && existing < boundary), boundary };
}

/** Project a reorder from the original, untransformed scroll-space bounds.
 * Neighbors occupy their eventual slots while the source follows the pointer.
 * Crossing an original neighbor's midpoint with the source's leading edge
 * swaps that neighbor. These fixed thresholds keep a stationary pointer stable. */
export function tabReorderLayout(tabs: readonly TabDragBounds[], draggedId: string, draggedLeft: number, gap: number): TabReorderLayout {
  const sourceIndex = tabs.findIndex(tab => tab.id === draggedId), source = tabs[sourceIndex];
  if (!source) return { index: 0, offsets: Object.fromEntries(tabs.map(tab => [tab.id, 0])) };
  const first = tabs[0].left, last = tabs.at(-1)!;
  const end = last.left + last.width - source.width;
  const left = Math.max(first, Math.min(end, draggedLeft));
  let index = sourceIndex;
  if (left > source.left) {
    while (index < tabs.length - 1 && tabs[index + 1].left + tabs[index + 1].width / 2 < left + source.width) index++;
  } else if (left < source.left) {
    while (index > 0 && tabs[index - 1].left + tabs[index - 1].width / 2 > left) index--;
  }
  const remaining = tabs.filter(tab => tab.id !== draggedId);
  remaining.splice(index, 0, source);
  let targetLeft = first;
  const offsets = Object.fromEntries(remaining.map(tab => {
    const offset = (tab === source ? left : targetLeft) - tab.left;
    targetLeft += tab.width + gap;
    return [tab.id, offset];
  }));
  return { index, offsets };
}

/** Match the workspace grid, including its divider. Split drops reorient the
 * two existing groups, so the preview uses the complete workspace bounds. */
export function splitDropBounds(width: number, height: number, ratio: number, direction: SplitDirection, destination: GroupId, divider = editorGroupDividerThicknessPx): SplitDropBounds {
  const axis = direction === 'right' ? width : height;
  const gap = Math.min(Math.max(0, divider), axis);
  const primary = Math.max(0, axis - gap) * Math.min(1, Math.max(0, ratio));
  const start = destination === 'primary' ? 0 : primary + gap;
  const size = destination === 'primary' ? primary : Math.max(0, axis - start);
  return direction === 'right' ? { left: start, top: 0, width: size, height }
    : { left: 0, top: start, width, height: size };
}
