import type { MenuItemConstructorOptions } from 'electron';
import type { ApplicationActionId, ApplicationMenuState } from '../../shared/actions/contracts';

interface ActionDefinition { label: string; accelerator?: string; type?: 'checkbox' | 'radio' }
const actions: Record<ApplicationActionId, ActionDefinition> = {
  'app.settings': { label: 'Settings…', accelerator: 'CmdOrCtrl+,' },
  'file.newFile': { label: 'File…', accelerator: 'CmdOrCtrl+N' },
  'file.newFolder': { label: 'Directory…' },
  'file.rename': { label: 'Rename…', accelerator: 'Shift+F6' },
  'file.save': { label: 'Save', accelerator: 'CmdOrCtrl+S' },
  'file.saveAll': { label: 'Save All', accelerator: 'CmdOrCtrl+Shift+S' },
  'file.closeTab': { label: 'Close Tab', accelerator: 'CmdOrCtrl+W' },
  'file.closeAllTabs': { label: 'Close All Tabs' },
  'file.refresh': { label: 'Synchronize', accelerator: 'CmdOrCtrl+Alt+Y' },
  'file.autoSave': { label: 'Auto Save', type: 'checkbox' },
  'edit.undo': { label: 'Undo', accelerator: 'CmdOrCtrl+Z' },
  'edit.redo': { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z' },
  'edit.find': { label: 'Find…', accelerator: 'CmdOrCtrl+F' },
  'edit.replace': { label: 'Replace…', accelerator: 'CmdOrCtrl+R' },
  'edit.findInFiles': { label: 'Find in Files…', accelerator: 'CmdOrCtrl+Shift+F' },
  // Both can be off when the sidebar is hidden. Native radio groups force one
  // selection, so let the actual workspace state own these checkmarks.
  'view.project': { label: 'Project', accelerator: 'CmdOrCtrl+1', type: 'checkbox' },
  'view.commit': { label: 'Commit', accelerator: 'CmdOrCtrl+0', type: 'checkbox' },
  'view.sidebar': { label: 'Show Sidebar', accelerator: 'CmdOrCtrl+B', type: 'checkbox' },
  'view.wrap': { label: 'Soft Wraps', accelerator: 'Alt+Z', type: 'checkbox' },
  'view.diff.sideBySide': { label: 'Side by Side', type: 'radio' },
  'view.diff.inline': { label: 'Inline', type: 'radio' },
  'view.diff.compact': { label: 'Compact', type: 'radio' },
  'view.diff.aligned': { label: 'Aligned', type: 'radio' },
  'view.diff.sync': { label: 'Synchronize Scrolling', type: 'checkbox' },
  'view.diff.collapse': { label: 'Collapse Unchanged Regions', type: 'checkbox' },
  'view.diff.whitespace': { label: 'Ignore Whitespace', type: 'checkbox' },
  'navigate.nextChange': { label: 'Next Change', accelerator: 'Alt+Down' },
  'navigate.previousChange': { label: 'Previous Change', accelerator: 'Alt+Up' },
  'navigate.nextTab': { label: 'Next Tab', accelerator: 'Ctrl+Tab' },
  'navigate.previousTab': { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab' },
  'navigate.source': { label: 'Jump to Source', accelerator: 'F4' },
  'navigate.line': { label: 'Go to Line…', accelerator: 'CmdOrCtrl+L' },
  'code.commentLine': { label: 'Comment with Line Comment', accelerator: 'CmdOrCtrl+/' },
  'code.commentBlock': { label: 'Comment with Block Comment', accelerator: 'CmdOrCtrl+Alt+/' },
  'code.indent': { label: 'Indent Selection' },
  'code.outdent': { label: 'Unindent Selection' },
  'git.branches': { label: 'Branches…', accelerator: 'Alt+`' },
  'git.commit': { label: 'Commit…', accelerator: 'CmdOrCtrl+K' },
  'git.push': { label: 'Push…', accelerator: 'CmdOrCtrl+Shift+K' },
  'git.update': { label: 'Update Project…', accelerator: 'CmdOrCtrl+T' },
  'git.newBranch': { label: 'New Branch…', accelerator: 'CmdOrCtrl+Alt+N' },
  'git.fetch': { label: 'Fetch' },
  'window.splitRight': { label: 'Split Right' },
  'window.splitDown': { label: 'Split Down' },
  'window.unsplit': { label: 'Unsplit' },
  'window.nextGroup': { label: 'Next Editor Group', accelerator: 'CmdOrCtrl+Alt+Right' },
};

export interface ApplicationMenuOptions {
  platform: NodeJS.Platform;
  appName: string;
  state: ApplicationMenuState;
  focusedWindowId?: number;
  projects: { windowId: number; name: string; path: string }[];
  dispatch(action: ApplicationActionId): void;
  open(): void;
  closeProject(): void;
  focusProject(windowId: number): void;
  showShortcuts(): void;
}

/** Native chrome describes supported application actions; renderer state alone
 * enables context-sensitive commands, so unloaded/crashed windows cannot act. */
export function createApplicationMenuTemplate(options: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const mac = options.platform === 'darwin';
  const separator = (): MenuItemConstructorOptions => ({ type: 'separator' });
  const action = (id: ApplicationActionId): MenuItemConstructorOptions => ({
    id, ...actions[id], enabled: options.state[id]?.enabled === true,
    ...(id === 'app.settings' && !mac ? { accelerator: 'Ctrl+Alt+S' } : {}),
    ...(actions[id].type ? { checked: options.state[id]?.checked === true } : {}),
    click: () => options.dispatch(id),
  });
  const menu = (label: string, submenu: MenuItemConstructorOptions[]): MenuItemConstructorOptions => ({ label, submenu });
  const hasWindow = options.focusedWindowId !== undefined;
  return [
    ...(mac ? [menu(options.appName, [
      { id: 'app.about', role: 'about' }, separator(), action('app.settings'), separator(),
      { role: 'services' }, separator(), { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, separator(),
      { id: 'app.quit', role: 'quit' },
    ])] : []),
    menu('File', [
      menu('New', [action('file.newFile'), action('file.newFolder')]),
      { id: 'file.open', label: 'Open…', accelerator: 'CmdOrCtrl+O', click: options.open },
      { id: 'file.openProjects', label: 'Open Projects', enabled: options.projects.length > 0, submenu: options.projects.map(project => ({
        id: `window.project.${project.windowId}`, label: project.name, toolTip: project.path,
        type: 'checkbox', checked: project.windowId === options.focusedWindowId,
        click: () => options.focusProject(project.windowId),
      })) },
      separator(), action('file.save'), action('file.saveAll'), action('file.autoSave'), action('file.refresh'),
      separator(), action('file.rename'), separator(), action('file.closeTab'), action('file.closeAllTabs'),
      { id: 'file.closeProject', label: 'Close Project', accelerator: 'CmdOrCtrl+Shift+W', enabled: hasWindow, click: options.closeProject },
      ...(!mac ? [separator(), action('app.settings'), separator(), { id: 'app.quit', role: 'quit' } as MenuItemConstructorOptions] : []),
    ]),
    menu('Edit', [
      action('edit.undo'), action('edit.redo'), separator(),
      { id: 'edit.cut', role: 'cut' }, { id: 'edit.copy', role: 'copy' }, { id: 'edit.paste', role: 'paste' }, { id: 'edit.selectAll', role: 'selectAll' },
      separator(), action('edit.find'), action('edit.replace'), action('edit.findInFiles'),
    ]),
    menu('View', [
      menu('Tool Windows', [action('view.project'), action('view.commit')]), action('view.sidebar'),
      separator(), action('view.wrap'), menu('Diff', [
        action('view.diff.sideBySide'), action('view.diff.inline'), separator(),
        action('view.diff.compact'), action('view.diff.aligned'), separator(), action('view.diff.sync'), action('view.diff.collapse'), action('view.diff.whitespace'),
      ]),
    ]),
    menu('Navigate', [
      action('navigate.nextChange'), action('navigate.previousChange'), separator(),
      action('navigate.nextTab'), action('navigate.previousTab'), separator(), action('navigate.source'), action('navigate.line'),
    ]),
    menu('Code', [action('code.commentLine'), action('code.commentBlock'), separator(), action('code.indent'), action('code.outdent')]),
    menu('Git', [action('git.branches'), action('git.newBranch'), separator(), action('git.commit'), action('git.push'), action('git.update'), action('git.fetch')]),
    menu('Window', [
      { id: 'window.minimize', role: 'minimize' }, { id: 'window.zoom', role: 'zoom' }, { id: 'window.fullscreen', role: 'togglefullscreen' },
      separator(), action('window.splitRight'), action('window.splitDown'), action('window.unsplit'), action('window.nextGroup'),
      ...(mac ? [separator(), { role: 'front' } as MenuItemConstructorOptions] : []),
    ]),
    menu('Help', [
      { id: 'help.shortcuts', label: 'Keyboard Shortcuts', click: options.showShortcuts },
      ...(!mac ? [separator(), { id: 'app.about', role: 'about' } as MenuItemConstructorOptions] : []),
    ]),
  ];
}

export function applicationShortcutReference(platform: NodeJS.Platform): string {
  const format = (accelerator: string) => accelerator.replace('CmdOrCtrl', platform === 'darwin' ? '⌘' : 'Ctrl').replaceAll('Shift', '⇧').replaceAll('Alt', platform === 'darwin' ? '⌥' : 'Alt');
  return [
    `Open project — ${format('CmdOrCtrl+O')}`,
    ...Object.entries(actions).flatMap(([id, definition]) => definition.accelerator ? [`${definition.label.replace('…', '')} — ${format(id === 'app.settings' && platform !== 'darwin' ? 'Ctrl+Alt+S' : definition.accelerator)}`] : []),
    `Close project — ${format('CmdOrCtrl+Shift+W')}`,
  ].join('\n');
}
