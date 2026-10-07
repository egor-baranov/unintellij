import { describe, expect, it } from 'vitest';
import { createWorkspace, dockPlacement, workspaceReducer } from './model';
import { contentDropEdge, splitDropBounds, tabInsertion, tabReorderLayout } from './tabDrag';

const tabs = [
  { id: 'a', left: 8, width: 100 },
  { id: 'b', left: 112, width: 160 },
  { id: 'c', left: 276, width: 80 },
];

describe('inline tab reorder geometry', () => {
  it('keeps every source in its initial slot before crossing a neighbor midpoint', () => {
    for (const [index, source] of tabs.entries()) {
      expect(tabReorderLayout(tabs, source.id, source.left, 4)).toEqual({ index, offsets: { a: 0, b: 0, c: 0 } });
    }
    expect(tabReorderLayout(tabs, 'a', 92, 4)).toEqual({ index: 0, offsets: { a: 84, b: 0, c: 0 } });
    expect(tabReorderLayout(tabs, 'c', 192, 4)).toEqual({ index: 2, offsets: { a: 0, b: 0, c: -84 } });
    expect(tabReorderLayout(tabs, 'b', 58, 4).index).toBe(1);
    expect(tabReorderLayout(tabs, 'b', 156, 4).index).toBe(1);
  });

  it('slides short tabs past a wider neighbor in both directions', () => {
    expect(tabReorderLayout(tabs, 'a', 92.25, 4)).toEqual({ index: 1, offsets: { a: 84.25, b: -104, c: 0 } });
    expect(tabReorderLayout(tabs, 'c', 191.75, 4)).toEqual({ index: 1, offsets: { a: 0, b: 84, c: -84.25 } });
  });

  it('slides a long tab past shorter neighbors in both directions', () => {
    expect(tabReorderLayout(tabs, 'b', 57.75, 4)).toEqual({ index: 0, offsets: { a: 164, b: -54.25, c: 0 } });
    expect(tabReorderLayout(tabs, 'b', 156.25, 4)).toEqual({ index: 2, offsets: { a: 0, b: 44.25, c: -164 } });
  });

  it('clamps the dragged tab to the occupied row and reaches either end with unequal widths', () => {
    expect(tabReorderLayout(tabs, 'b', -1000, 4)).toEqual({ index: 0, offsets: { a: 164, b: -104, c: 0 } });
    expect(tabReorderLayout(tabs, 'b', 1000, 4)).toEqual({ index: 2, offsets: { a: 0, b: 84, c: -164 } });
    expect(tabReorderLayout(tabs, 'a', 1000, 4)).toEqual({ index: 2, offsets: { a: 248, b: -104, c: -104 } });
    expect(tabReorderLayout(tabs, 'c', -1000, 4)).toEqual({ index: 0, offsets: { a: 84, b: 84, c: -268 } });
  });

  it('preserves fractional widths, gaps, and source movement', () => {
    const fractional = [{ id: 'a', left: 4.25, width: 80.5 }, { id: 'b', left: 89.25, width: 60 }, { id: 'c', left: 153.75, width: 120.25 }];
    expect(tabReorderLayout(fractional, 'a', 39, 4.5)).toEqual({ index: 1, offsets: { a: 34.75, b: -85, c: 0 } });
    expect(tabReorderLayout(fractional, 'c', 119.125, 4.5)).toEqual({ index: 1, offsets: { a: 0, b: 124.75, c: -34.625 } });
    expect(tabReorderLayout(fractional, 'b', 1000, 4.5)).toEqual({ index: 2, offsets: { a: 0, b: 124.75, c: -64.5 } });
  });

  it('uses stable original geometry without mutating bounds or remembering earlier positions', () => {
    const original = Object.freeze(tabs.map(tab => Object.freeze({ ...tab })));
    const expected = { index: 1, offsets: { a: 84.25, b: -104, c: 0 } };
    for (let repeat = 0; repeat < 5; repeat++) {
      tabReorderLayout(original, 'a', 1000, 4);
      expect(tabReorderLayout(original, 'a', 92.25, 4)).toEqual(expected);
      expect(tabReorderLayout(original, 'a', 8, 4)).toEqual({ index: 0, offsets: { a: 0, b: 0, c: 0 } });
    }
    // Translating the same scroll-space coordinates does not change the result.
    expect(tabReorderLayout(tabs.map(tab => ({ ...tab, left: tab.left - 120 })), 'a', -27.75, 4)).toEqual(expected);
  });

  it.each([
    { id: 'a', left: 180, order: ['b', 'a', 'c'] },
    { id: 'a', left: 230, order: ['b', 'c', 'a'] },
    { id: 'b', left: 10, order: ['b', 'a', 'c'] },
    { id: 'b', left: 190, order: ['a', 'c', 'b'] },
    { id: 'c', left: 100, order: ['a', 'c', 'b'] },
    { id: 'c', left: 10, order: ['c', 'a', 'b'] },
  ])('commits the projected order for $id at $left without replacing instances', ({ id, left, order }) => {
    let instance = 0;
    const state = createWorkspace(tabs.map(tab => ({ id: tab.id, path: `${tab.id}.ts`, kind: 'file' as const })), () => `instance-${++instance}`);
    const layout = tabReorderLayout(tabs, id, left, 4);
    const next = workspaceReducer(state, { type: 'move', sourceGroup: 'primary', targetGroup: 'primary', id, index: layout.index });
    expect(next.groups[0].tabs.map(tab => tab.id)).toEqual(order);
    expect(next.groups[0].activeId).toBe(id);
    for (const tab of next.groups[0].tabs) expect(tab).toBe(state.groups[0].tabs.find(original => original.id === tab.id));
    expect(state.groups[0].tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c']);
  });

  it('handles a sole tab, an empty row, and a source removed during the gesture', () => {
    expect(tabReorderLayout([tabs[0]], 'a', 1000, 4)).toEqual({ index: 0, offsets: { a: 0 } });
    expect(tabReorderLayout([], 'a', 1000, 4)).toEqual({ index: 0, offsets: {} });
    expect(tabReorderLayout(tabs, 'missing', 1000, 4)).toEqual({ index: 0, offsets: { a: 0, b: 0, c: 0 } });
  });
});

describe('tab insertion geometry', () => {
  it('uses tab midpoints to identify the first, middle and trailing boundaries', () => {
    expect(tabInsertion(tabs, 'new', -10)).toEqual({ index: 0, boundary: 0 });
    expect(tabInsertion(tabs, 'new', 57)).toEqual({ index: 0, boundary: 0 });
    expect(tabInsertion(tabs, 'new', 58)).toEqual({ index: 1, boundary: 1 });
    expect(tabInsertion(tabs, 'new', 191)).toEqual({ index: 1, boundary: 1 });
    expect(tabInsertion(tabs, 'new', 192)).toEqual({ index: 2, boundary: 2 });
    expect(tabInsertion(tabs, 'new', 400)).toEqual({ index: 3, boundary: 3 });
  });

  it('supports partial offscreen tabs without clamping their real boundary', () => {
    const scrolled = tabs.map(tab => ({ ...tab, left: tab.left - 120 }));
    expect(tabInsertion(scrolled, 'new', 0)).toEqual({ index: 1, boundary: 1 });
    expect(tabInsertion(scrolled, 'new', 100)).toEqual({ index: 2, boundary: 2 });
  });

  it('adjusts reorder indices for removal of the dragged tab', () => {
    expect(tabInsertion(tabs, 'a', 280)).toEqual({ index: 1, boundary: 2 });
    expect(tabInsertion(tabs, 'c', 20)).toEqual({ index: 0, boundary: 0 });
    expect(tabInsertion(tabs, 'b', 120)).toEqual({ index: 1, boundary: 1 });
    expect(tabInsertion(tabs, 'b', 230)).toEqual({ index: 1, boundary: 2 });
  });

  it('places a moved duplicate before the promised neighbor in another group', () => {
    let instance = 0;
    let state = createWorkspace(tabs.map(tab => ({ id: tab.id, path: `${tab.id}.ts`, kind: 'file' as const })), () => `instance-${++instance}`);
    state = workspaceReducer(state, { type: 'activate', groupId: 'primary', id: 'b' });
    state = workspaceReducer(state, { type: 'split', groupId: 'primary', direction: 'right', instanceId: 'moved-instance' });
    const insertion = tabInsertion(tabs, 'b', 280);
    const next = workspaceReducer(state, { type: 'move', sourceGroup: 'secondary', targetGroup: 'primary', id: 'b', index: insertion.index });
    expect(insertion.boundary).toBe(2);
    expect(next.groups[0].tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c']);
    expect(next.groups[0].tabs[1].instanceId).toBe('moved-instance');
    expect(next.groups).toHaveLength(1);
  });

  it('preserves fractional tab bounds and supports an empty destination', () => {
    expect(tabInsertion([{ id: 'a', left: 4.25, width: 80.5 }, { id: 'b', left: 89.25, width: 60 }], 'new', 60)).toEqual({ index: 1, boundary: 1 });
    expect(tabInsertion([], 'new', 500)).toEqual({ index: 0, boundary: 0 });
  });

  it('retains the stored boundary across the slot and adjoining half-gaps after tabs shift', () => {
    const placeholder = { boundary: 2, left: 276, width: 160, gap: 4 };
    const shifted = tabs.map((tab, index) => index < 2 ? tab : { ...tab, left: tab.left + 164 });
    // The rendered slot still promises the boundary after b, even though
    // deduplication makes its final destination index one position smaller.
    for (const pointer of [274, 276, 356, 436, 438]) {
      expect(tabInsertion(shifted, 'b', pointer, placeholder)).toEqual({ index: 1, boundary: 2 });
    }
    expect(tabInsertion(shifted, 'b', 191, placeholder)).toEqual({ index: 1, boundary: 1 });
    expect(tabInsertion(shifted, 'b', 490, placeholder)).toEqual({ index: 2, boundary: 3 });
  });

  it('keeps a wide first slot stable without moving the source or skipping its next neighbor', () => {
    const placeholder = { boundary: 0, left: 8, width: 160, gap: 4 };
    const shifted = tabs.map(tab => ({ ...tab, left: tab.left + 164 }));
    expect(tabInsertion(shifted, 'c', 169, placeholder)).toEqual({ index: 0, boundary: 0 });
    expect(tabInsertion(shifted, 'c', 222, placeholder)).toEqual({ index: 1, boundary: 1 });
    expect(tabInsertion(tabs, 'a', 500, { boundary: 3, left: 360, width: 160, gap: 4 })).toEqual({ index: 2, boundary: 3 });
  });
});

describe('split drop preview geometry', () => {
  it('detects every edge and keeps the center available for moving tabs', () => {
    expect(contentDropEdge(1000, 800, 30, 400)).toBe('left');
    expect(contentDropEdge(1000, 800, 970, 400)).toBe('right');
    expect(contentDropEdge(1000, 800, 500, 30)).toBe('up');
    expect(contentDropEdge(1000, 800, 500, 770)).toBe('down');
    expect(contentDropEdge(1000, 800, 500, 400)).toBeUndefined();
    expect(contentDropEdge(1000, 800, -1, 400)).toBeUndefined();
    expect(contentDropEdge(1000, 800, 500, 801)).toBeUndefined();
    expect(contentDropEdge(0, 800, 0, 400)).toBeUndefined();
  });

  it('chooses the nearest edge in corners instead of letting bottom/right mask left/top', () => {
    expect(contentDropEdge(1000, 800, 8, 750)).toBe('left');
    expect(contentDropEdge(1000, 800, 50, 795)).toBe('down');
    expect(contentDropEdge(1000, 800, 992, 50)).toBe('right');
    expect(contentDropEdge(1000, 800, 950, 5)).toBe('up');
    expect(contentDropEdge(200, 120, 45, 60)).toBe('left');
    expect(contentDropEdge(200, 120, 49, 60)).toBeUndefined();
  });

  it('uses the chosen physical side for preview geometry and the final docked group', () => {
    for (const edge of ['left', 'right', 'up', 'down'] as const) {
      const placement = dockPlacement(edge);
      const state = workspaceReducer(createWorkspace([
        { id: 'a', path: 'a.ts', kind: 'file' }, { id: 'b', path: 'b.ts', kind: 'file' },
      ]), { type: 'dock', sourceGroup: 'primary', id: 'b', edge, instanceId: 'copy' });
      expect(state.activeGroupId).toBe(placement.destination);
      expect(state.direction).toBe(placement.direction);
      const bounds = splitDropBounds(1001, 801, .5, placement.direction, placement.destination);
      expect(bounds.left).toBe(edge === 'right' ? 501 : 0);
      expect(bounds.top).toBe(edge === 'down' ? 401 : 0);
    }
  });

  it('matches final right split groups with the divider excluded from the ratio', () => {
    expect(splitDropBounds(1001, 700, .3, 'right', 'primary')).toEqual({ left: 0, top: 0, width: 300, height: 700 });
    expect(splitDropBounds(1001, 700, .3, 'right', 'secondary')).toEqual({ left: 301, top: 0, width: 700, height: 700 });
  });

  it('matches final down split groups independently of the hovered group', () => {
    expect(splitDropBounds(1000, 801, .6, 'down', 'primary')).toEqual({ left: 0, top: 0, width: 1000, height: 480 });
    expect(splitDropBounds(1000, 801, .6, 'down', 'secondary')).toEqual({ left: 0, top: 481, width: 1000, height: 320 });
  });

  it('retains fractional dimensions without leaving seams or overlaps', () => {
    for (const direction of ['right', 'down'] as const) {
      const primary = splitDropBounds(1000.5, 800.75, .37, direction, 'primary', 4.5);
      const secondary = splitDropBounds(1000.5, 800.75, .37, direction, 'secondary', 4.5);
      if (direction === 'right') {
        expect(primary.width + 4.5).toBeCloseTo(secondary.left);
        expect(secondary.left + secondary.width).toBeCloseTo(1000.5);
      } else {
        expect(primary.height + 4.5).toBeCloseTo(secondary.top);
        expect(secondary.top + secondary.height).toBeCloseTo(800.75);
      }
    }
  });

  it('keeps minimum-size previews nonnegative when the divider fills the axis', () => {
    expect(splitDropBounds(.5, 500, .5, 'right', 'secondary')).toEqual({ left: .5, top: 0, width: 0, height: 500 });
  });
});
