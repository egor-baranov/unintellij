import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { applicationActionIds, validateApplicationMenuState } from '../../shared/actions/contracts';
import { applicationShortcutReference, createApplicationMenuTemplate, type ApplicationMenuOptions } from './application-menu';

function options(patch: Partial<ApplicationMenuOptions> = {}): ApplicationMenuOptions {
  return {
    platform: 'darwin', appName: 'unintellij', state: {}, projects: [],
    dispatch: vi.fn(), open: vi.fn(), closeProject: vi.fn(), focusProject: vi.fn(), showShortcuts: vi.fn(), ...patch,
  };
}
function entries(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap(item => [item, ...(Array.isArray(item.submenu) ? entries(item.submenu) : [])]);
}
function find(template: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  const item = entries(template).find(entry => entry.id === id);
  if (!item) throw new Error(`Missing menu item ${id}`);
  return item;
}
function click(item: MenuItemConstructorOptions) { (item.click as (() => void) | undefined)?.(); }

describe('native application menu', () => {
  it('exposes supported actions once, with native application groups and no browser template commands', () => {
    const template = createApplicationMenuTemplate(options());
    expect(template.map(item => item.label)).toEqual(['unintellij', 'File', 'Edit', 'View', 'Navigate', 'Code', 'Git', 'Window', 'Help']);
    const items = entries(template);
    for (const id of applicationActionIds) expect(items.filter(item => item.id === id)).toHaveLength(1);
    expect(items.some(item => ['reload', 'forceReload', 'resetZoom', 'zoomIn', 'zoomOut', 'toggleDevTools'].includes(item.role ?? ''))).toBe(false);
    expect(find(template, 'app.about').role).toBe('about');
    expect(find(template, 'app.quit').role).toBe('quit');
    expect(find(template, 'edit.copy').role).toBe('copy');
  });

  it('disables every renderer command until a window publishes context', () => {
    const template = createApplicationMenuTemplate(options());
    for (const id of applicationActionIds) expect(find(template, id).enabled).toBe(false);
    expect(find(template, 'file.closeProject').enabled).toBe(false);
    expect(find(template, 'file.openProjects').enabled).toBe(false);
    expect(find(template, 'file.open').enabled).not.toBe(false);
  });

  it('uses only the provided focused-window state for capabilities and checkmarks', () => {
    const first = createApplicationMenuTemplate(options({ focusedWindowId: 4, state: {
      'file.save': { enabled: true }, 'file.autoSave': { enabled: true, checked: true },
      'view.diff.aligned': { enabled: true, checked: true }, 'view.diff.compact': { enabled: true, checked: false },
      'view.diff.inline': { enabled: true, checked: true }, 'view.diff.sideBySide': { enabled: true, checked: false },
    } }));
    expect(find(first, 'file.save').enabled).toBe(true);
    expect(find(first, 'file.autoSave')).toMatchObject({ type: 'checkbox', checked: true });
    expect(find(first, 'view.diff.aligned')).toMatchObject({ type: 'radio', checked: true });
    expect(find(first, 'view.diff.compact').checked).toBe(false);
    expect(find(first, 'view.diff.inline')).toMatchObject({ type: 'radio', checked: true });
    expect(find(first, 'view.diff.sideBySide').checked).toBe(false);
    const next = createApplicationMenuTemplate(options({ focusedWindowId: 7, state: { 'file.autoSave': { enabled: true, checked: false } } }));
    expect(find(next, 'file.autoSave').checked).toBe(false);
    expect(find(next, 'file.save').enabled).toBe(false);
    expect(find(next, 'file.closeProject').enabled).toBe(true);
    expect(find(next, 'view.project')).toMatchObject({ type: 'checkbox', checked: false });
    expect(find(next, 'view.commit')).toMatchObject({ type: 'checkbox', checked: false });
  });

  it('dispatches typed renderer IDs and keeps project window operations separate', () => {
    const input = options({ focusedWindowId: 4, projects: [
      { windowId: 4, name: 'client', path: '/work/client' }, { windowId: 7, name: 'server', path: '/work/server' },
    ], state: { 'edit.findInFiles': { enabled: true } } });
    const template = createApplicationMenuTemplate(input);
    click(find(template, 'edit.findInFiles'));
    expect(input.dispatch).toHaveBeenCalledWith('edit.findInFiles');
    const project = find(template, 'window.project.7');
    expect(project).toMatchObject({ label: 'server', toolTip: '/work/server', checked: false });
    expect(find(template, 'window.project.4').checked).toBe(true);
    click(project);
    expect(input.focusProject).toHaveBeenCalledWith(7);
    click(find(template, 'file.open'));
    click(find(template, 'file.closeProject'));
    expect(input.open).toHaveBeenCalledOnce();
    expect(input.closeProject).toHaveBeenCalledOnce();
  });

  it.each(['darwin', 'win32', 'linux'] as const)('provides platform-appropriate settings and non-conflicting accelerators on %s', platform => {
    const template = createApplicationMenuTemplate(options({ platform }));
    expect(find(template, 'app.settings').accelerator).toBe(platform === 'darwin' ? 'CmdOrCtrl+,' : 'Ctrl+Alt+S');
    expect(find(template, 'file.refresh').accelerator).toBe('CmdOrCtrl+Alt+Y');
    expect(find(template, 'edit.replace').accelerator).toBe('CmdOrCtrl+R');
    expect(find(template, 'file.closeTab').accelerator).toBe('CmdOrCtrl+W');
    expect(find(template, 'file.closeProject').accelerator).toBe('CmdOrCtrl+Shift+W');
    const accelerators = entries(template).flatMap(item => item.accelerator ? [item.accelerator] : []);
    expect(new Set(accelerators).size).toBe(accelerators.length);
    if (platform !== 'darwin') {
      expect(template[0].label).toBe('File');
      expect(find(template, 'app.about').role).toBe('about');
      expect(find(template, 'app.quit').role).toBe('quit');
    }
    expect(applicationShortcutReference(platform)).toContain(platform === 'darwin' ? 'Settings — ⌘+,' : 'Settings — Ctrl+Alt+S');
  });

  it('rejects arbitrary menu commands and malformed renderer state', () => {
    for (const value of [null, [], { 'run.shell': { enabled: true } }, { 'file.save': true }, { 'file.save': { enabled: 'yes' } }, { 'file.save': { enabled: true, checked: 1 } }, { 'file.save': { enabled: true, command: 'anything' } }]) {
      expect(() => validateApplicationMenuState(value)).toThrow('Invalid application menu state');
    }
    expect(validateApplicationMenuState({ 'file.autoSave': { enabled: true, checked: false } })).toEqual({ 'file.autoSave': { enabled: true, checked: false } });
  });
});
