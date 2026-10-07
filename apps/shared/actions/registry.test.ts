import { describe, expect, it, vi } from 'vitest';
import { ApplicationActionRegistry } from './registry';
import { validateApplicationMenuState } from './contracts';

describe('application action ownership', () => {
  it('routes to the current owner and removes unmounted editor actions', async () => {
    const registry = new ApplicationActionRegistry(() => {}), old = vi.fn(), current = vi.fn();
    const removeOld = registry.register({ 'file.save': { run: old } });
    const removeCurrent = registry.register({ 'file.save': { run: current }, 'view.wrap': { run: current, checked: true } });
    expect(registry.state()['view.wrap']).toEqual({ enabled: true, checked: true });
    await registry.execute('file.save'); expect(current).toHaveBeenCalledTimes(1); expect(old).not.toHaveBeenCalled();
    removeOld(); removeCurrent();
    await registry.execute('file.save'); expect(current).toHaveBeenCalledTimes(1);
    expect(registry.state()).toEqual({});
  });
  it('rechecks disabled/modal actions at dispatch while allowing text-input undo', async () => {
    const registry = new ApplicationActionRegistry(() => {}), save = vi.fn(), undo = vi.fn(), disabled = vi.fn();
    registry.register({ 'file.save': { run: save }, 'edit.undo': { run: undo, allowInModal: true }, 'code.indent': { run: disabled, enabled: false } });
    registry.setBlocked(true);
    expect(registry.state()['file.save']?.enabled).toBe(false);
    await registry.execute('file.save'); await registry.execute('edit.undo'); await registry.execute('code.indent');
    expect(save).not.toHaveBeenCalled(); expect(undo).toHaveBeenCalledTimes(1); expect(disabled).not.toHaveBeenCalled();
    registry.setBlocked(false); await registry.execute('file.save'); expect(save).toHaveBeenCalledTimes(1);
  });
  it('propagates failures for the host to display without running another action', async () => {
    const registry = new ApplicationActionRegistry(() => {});
    registry.register({ 'file.save': { run: async () => { throw new Error('Disk changed'); } } });
    await expect(registry.execute('file.save')).rejects.toThrow('Disk changed');
  });
});

describe('application menu IPC state', () => {
  it('accepts only command availability and checkmarks', () => {
    expect(validateApplicationMenuState({ 'view.wrap': { enabled: true, checked: false } })).toEqual({ 'view.wrap': { enabled: true, checked: false } });
  });
  it.each([null, [], { execute: { enabled: true } }, { 'file.save': { enabled: 'true' } },
    { 'file.save': { enabled: true, path: '/outside' } }, { 'file.save': { enabled: true, checked: 1 } }])('rejects unknown commands and extra payload fields: %j', value => {
    expect(() => validateApplicationMenuState(value)).toThrow('Invalid application menu state');
  });
});
