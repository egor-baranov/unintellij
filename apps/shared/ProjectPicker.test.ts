import { describe, expect, it } from 'vitest';
import { pickerProjectGroups } from './ProjectPicker';

describe('project picker groups', () => {
  it('keeps open projects out of recent history while retaining history order', () => {
    const open = { id: 'window', name: 'same-name', path: '/projects/open' };
    const recent = { id: 'history', name: 'same-name', path: '/elsewhere/closed' };
    expect(pickerProjectGroups([open, { ...open, id: 'second-window' }], [
      { ...open, id: 'history-open' }, recent, { ...recent, id: 'duplicate-history' },
    ])).toEqual({ open: [open], recent: [recent] });
  });
  it('preserves distinct paths, capability IDs, and host-formatted display paths', () => {
    const open = { id: 'same-id', name: 'project', path: '/home/me/project', displayPath: '~/project' };
    const recent = { id: 'same-id', name: 'project', path: '/home/me/project-other', displayPath: '~/project-other' };
    expect(pickerProjectGroups([open], [recent])).toEqual({ open: [open], recent: [recent] });
  });
});
