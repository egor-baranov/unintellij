/** Renderer commands are a fixed vocabulary, never executable code or paths. */
export const applicationActionIds = [
  'app.settings', 'file.newFile', 'file.newFolder', 'file.rename', 'file.save', 'file.saveAll', 'file.closeTab', 'file.closeAllTabs', 'file.refresh', 'file.autoSave',
  'edit.undo', 'edit.redo', 'edit.find', 'edit.replace', 'edit.findInFiles',
  'view.project', 'view.commit', 'view.sidebar', 'view.wrap', 'view.diff.sideBySide', 'view.diff.inline', 'view.diff.compact', 'view.diff.aligned', 'view.diff.sync', 'view.diff.collapse', 'view.diff.whitespace',
  'navigate.nextChange', 'navigate.previousChange', 'navigate.nextTab', 'navigate.previousTab', 'navigate.source', 'navigate.line',
  'code.commentLine', 'code.commentBlock', 'code.indent', 'code.outdent',
  'git.branches', 'git.commit', 'git.push', 'git.update', 'git.newBranch', 'git.fetch',
  'window.splitRight', 'window.splitDown', 'window.unsplit', 'window.nextGroup',
] as const;
export type ApplicationActionId = typeof applicationActionIds[number];
export interface ApplicationActionState { enabled: boolean; checked?: boolean }
export type ApplicationMenuState = Partial<Record<ApplicationActionId, ApplicationActionState>>;
export const isApplicationActionId = (value: unknown): value is ApplicationActionId => typeof value === 'string' && (applicationActionIds as readonly string[]).includes(value);
export function validateApplicationMenuState(value: unknown): ApplicationMenuState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid application menu state.');
  const result: ApplicationMenuState = {};
  for (const [key, state] of Object.entries(value)) {
    if (!isApplicationActionId(key) || !state || typeof state !== 'object' || Array.isArray(state)
      || !('enabled' in state) || typeof state.enabled !== 'boolean'
      || Object.keys(state).some(field => field !== 'enabled' && field !== 'checked')
      || ('checked' in state && typeof state.checked !== 'boolean')) throw new Error('Invalid application menu state.');
    result[key] = { enabled: state.enabled, ...('checked' in state ? { checked: state.checked as boolean } : {}) };
  }
  return result;
}
