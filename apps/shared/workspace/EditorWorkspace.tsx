import { Fragment, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FileTypeIcon } from '../icons';
import { MenuButton, UiIcon, type ContextMenuEntry } from '../ui';
import { useFileActions } from '../files/FileActions';
import { GroupDivider } from './GroupDivider';
import { type GroupId, type SplitDirection, type WorkspaceTab } from './model';
import type { EditorWorkspaceController } from './useEditorWorkspace';
import './workspace.css';
import { getBuffer, saveBuffer, useEditingRevision } from '../editing/store';
import { UnsavedDialog } from '../editing/UnsavedDialog';
import { useApplicationActions } from '../actions/renderer';
import { WorkspaceApplicationActions } from './ApplicationActionsContext';
import { editorGroupDividerThicknessPx } from './tabDrag';
import { useTabDrag } from './useTabDrag';

const opposite = (groupId: GroupId): GroupId => groupId === 'primary' ? 'secondary' : 'primary';

export interface EditorWorkspaceProps {
  workspace: EditorWorkspaceController;
  renderTab: (tab: WorkspaceTab, groupId: GroupId) => ReactNode;
  emptyState?: ReactNode;
  applicationActionsEnabled?: boolean;
}

export function EditorWorkspace({ workspace, renderTab, emptyState, applicationActionsEnabled = true }: EditorWorkspaceProps) {
  const { state } = workspace;
  const fileActions = useFileActions();
  const token = useId();
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterClose = useRef<string | undefined>(undefined);
  const focusDestination = useRef(false);
  const { dragged, mode: dragMode, dropHint, start: startTabDrag } = useTabDrag(root, workspace, () => { focusDestination.current = true; });
  const previousActiveTabs = useRef(new Map<GroupId, string | undefined>());
  const latestGroups = useRef(state.groups); latestGroups.current = state.groups;
  const measuredTabStrips = useRef(new WeakMap<Element, number>());
  const split = state.groups.length === 2;
  const tabStripGroups = state.groups.filter(group => group.tabs.length).map(group => group.id).join(',');
  useEditingRevision();
  const [pendingClose, setPendingClose] = useState<{ keys: string[]; perform: () => void }>();
  function guardClose(tabs: WorkspaceTab[], perform: () => void) {
    const closing = new Set(tabs.map(tab => tab.instanceId));
    const retained = new Set(state.groups.flatMap(group => group.tabs).filter(tab => !closing.has(tab.instanceId)).map(tab => tab.editKey));
    const keys = [...new Set(tabs.map(tab => tab.editKey).filter((key): key is string => !!key && !retained.has(key) && !!(getBuffer(key)?.dirty || getBuffer(key)?.saving)))];
    if (keys.length) setPendingClose({ keys, perform }); else perform();
  }

  const activeGroup = state.groups.find(group => group.id === state.activeGroupId)!;
  const activeTab = activeGroup.tabs.find(tab => tab.id === activeGroup.activeId);
  const activeBuffer = getBuffer(activeTab?.editKey);
  const activateAdjacent = (offset: number) => {
    const index = activeGroup.tabs.findIndex(tab => tab.id === activeGroup.activeId);
    const next = activeGroup.tabs[(index + offset + activeGroup.tabs.length) % activeGroup.tabs.length];
    if (next) { focusDestination.current = true; workspace.activate(activeGroup.id, next.id); }
  };
  const splitActive = (direction: SplitDirection) => { focusDestination.current = true; workspace.split(activeGroup.id, direction); };
  useApplicationActions(applicationActionsEnabled ? {
    'file.save': { enabled: !!activeBuffer?.dirty && !activeBuffer.saving, run: () => { if (activeTab?.editKey) void saveBuffer(activeTab.editKey); } },
    'file.closeTab': { enabled: !!activeTab, run: () => { if (activeTab) close(activeGroup.id, activeTab.id); } },
    'file.closeAllTabs': { enabled: state.groups.some(group => group.tabs.length > 0), run: () => {
      guardClose(state.groups.flatMap(group => group.tabs), () => {
        // Closing the secondary group first avoids the reducer renaming it to
        // primary while there are still queued closes for its former identity.
        for (const group of [...state.groups].reverse()) for (const tab of group.tabs) workspace.close(group.id, tab.id);
      });
    } },
    'navigate.nextTab': { enabled: activeGroup.tabs.length > 1, run: () => activateAdjacent(1) },
    'navigate.previousTab': { enabled: activeGroup.tabs.length > 1, run: () => activateAdjacent(-1) },
    'window.splitRight': { enabled: !!activeTab, run: () => splitActive('right') },
    'window.splitDown': { enabled: !!activeTab, run: () => splitActive('down') },
    'window.unsplit': { enabled: split, run: () => { focusDestination.current = true; workspace.join(); } },
    'window.nextGroup': { enabled: split, run: () => { focusDestination.current = true; workspace.focusGroup(opposite(activeGroup.id)); } },
  } : {});

  useLayoutEffect(() => {
    const strips = root.current?.querySelectorAll<HTMLElement>('.workspace-tabs');
    if (!strips) return;
    let frame = 0;
    const resized = new Set<HTMLElement>();
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const strip = entry.target as HTMLElement, width = strip.clientWidth;
        const previous = measuredTabStrips.current.get(strip);
        measuredTabStrips.current.set(strip, width);
        if (previous !== undefined && previous !== width && width > 0) resized.add(strip);
      }
      if (!resized.size || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        for (const strip of resized) {
          const group = latestGroups.current.find(group => group.id === strip.dataset.tabGroup);
          const active = group?.tabs.find(tab => tab.id === group.activeId);
          const button = active ? buttons.current.get(active.instanceId) : undefined;
          // A width correction must not move another tab out from under a
          // pointer that has just focused it but has not delivered its click.
          const focused = document.activeElement;
          if (focused !== button && focused instanceof HTMLElement && strip.contains(focused) && focused.getAttribute('role') === 'tab') continue;
          if (!dragged.current) button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        resized.clear();
      });
    });
    for (const strip of strips) observer.observe(strip);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [tabStripGroups]);

  useLayoutEffect(() => {
    if (focusAfterClose.current) {
      const button = buttons.current.get(focusAfterClose.current);
      if (button) { button.focus(); focusAfterClose.current = undefined; }
    }
    for (const group of state.groups) {
      const active = group.tabs.find(tab => tab.id === group.activeId);
      const changed = previousActiveTabs.current.get(group.id) !== active?.instanceId;
      const focusRequested = focusDestination.current && group.id === state.activeGroupId;
      if (active) {
        const button = buttons.current.get(active.instanceId);
        if (focusRequested && button) { button.focus({ preventScroll: true }); focusDestination.current = false; }
        // Focusing a group on pointerdown must not move its existing selected
        // tab between pointerdown and click on a different, partly visible tab.
        if (!dragged.current && (changed || focusRequested)) button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    previousActiveTabs.current = new Map(state.groups.map(group => [group.id, group.tabs.find(tab => tab.id === group.activeId)?.instanceId]));
  }, [state.groups, state.activeGroupId]);

  function close(groupId: GroupId, id: string) {
    const group = state.groups.find(group => group.id === groupId)!;
    const index = group.tabs.findIndex(tab => tab.id === id);
    const remaining = group.tabs.filter(tab => tab.id !== id);
    const other = state.groups.find(group => group.id !== groupId);
    focusAfterClose.current = (remaining.find(tab => tab.id === group.activeId) ?? remaining[Math.min(index, remaining.length - 1)] ?? other?.tabs.find(tab => tab.id === other.activeId))?.instanceId;
    guardClose(group.tabs.filter(tab => tab.id === id), () => workspace.close(groupId, id));
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      const group = state.groups.find(group => group.id === state.activeGroupId);
      const active = group?.tabs.find(tab => tab.id === group.activeId);
      if (active?.editKey && getBuffer(active.editKey)) { event.preventDefault(); event.stopPropagation(); void saveBuffer(active.editKey); }
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'w') {
      const group = state.groups.find(group => group.id === state.activeGroupId);
      if (group?.activeId) { event.preventDefault(); event.stopPropagation(); close(group.id, group.activeId); }
    }
  }
  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>, groupId: GroupId, tab: WorkspaceTab) {
    if (fileActions?.(event, { kind: tab.kind, path: tab.path, documentId: tab.id }, tabActions(groupId, tab))) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const group = state.groups.find(group => group.id === groupId)!;
    const index = group.tabs.indexOf(tab);
    let next: WorkspaceTab | undefined;
    if (event.key === 'ArrowLeft') next = group.tabs[(index - 1 + group.tabs.length) % group.tabs.length];
    else if (event.key === 'ArrowRight') next = group.tabs[(index + 1) % group.tabs.length];
    else if (event.key === 'Home') next = group.tabs[0];
    else if (event.key === 'End') next = group.tabs.at(-1);
    else if (event.key === 'Delete') { event.preventDefault(); close(groupId, tab.id); return; }
    else return;
    event.preventDefault();
    if (next) { workspace.activate(groupId, next.id); buttons.current.get(next.instanceId)?.focus(); }
  }
  function tabActions(groupId: GroupId, tab: WorkspaceTab): ContextMenuEntry[] {
    const group = state.groups.find(group => group.id === groupId)!;
    const others = group.tabs.filter(other => other.id !== tab.id);
    const splitTab = (direction: SplitDirection) => {
      focusDestination.current = true;
      workspace.activate(groupId, tab.id);
      workspace.split(groupId, direction);
    };
    return [
      { id: 'close', label: 'Close', onSelect: () => close(groupId, tab.id) },
      { id: 'close-others', label: 'Close Other Tabs', disabled: !others.length, onSelect: () => guardClose(others, () => {
        workspace.activate(groupId, tab.id);
        for (const other of others) workspace.close(groupId, other.id);
      }) },
      { id: 'close-all', label: 'Close All Tabs', onSelect: () => guardClose(group.tabs, () => { for (const other of group.tabs) workspace.close(groupId, other.id); }) },
      { id: 'split-separator', kind: 'separator' },
      { id: 'split-right', label: 'Split Right', icon: <UiIcon name="split" />, onSelect: () => splitTab('right') },
      { id: 'split-down', label: 'Split Down', icon: <UiIcon name="split" style={{ transform: 'rotate(90deg)' }} />, onSelect: () => splitTab('down') },
    ];
  }

  return <div ref={root} className={`editor-workspace${split ? ` is-split split-${state.direction}` : ''}${dragMode ? ' is-dragging-tab' : ''}`}
    data-active-group={state.activeGroupId} data-direction={state.direction} data-tab-drag-mode={dragMode ?? undefined} onKeyDownCapture={keyDown}
    style={split ? state.direction === 'right'
      ? { gridTemplateColumns: `minmax(0, ${state.splitRatio}fr) ${editorGroupDividerThicknessPx}px minmax(0, ${1 - state.splitRatio}fr)` }
      : { gridTemplateRows: `minmax(0, ${state.splitRatio}fr) ${editorGroupDividerThicknessPx}px minmax(0, ${1 - state.splitRatio}fr)` } : undefined}>
    {state.groups.map((group, number) => {
      const active = group.tabs.find(tab => tab.id === group.activeId);
      const panelId = `${token}-${group.id}-panel`;
      const insertion = dropHint?.kind === 'tabs' && dropHint.groupId === group.id && dragged.current
        ? <div aria-hidden="true" className="workspace-tab-insertion" data-testid="tab-drop-placeholder" data-drop-index={dropHint.index} data-drop-boundary={dropHint.boundary}
          style={{ width: dragged.current.width, height: dragged.current.height }} /> : null;
      const insertionBoundary = insertion && dropHint?.kind === 'tabs' ? dropHint.boundary : -1;
      return <Fragment key={group.id}>
        {number > 0 && <GroupDivider root={root} direction={state.direction} ratio={state.splitRatio} onChange={workspace.setRatio} thickness={editorGroupDividerThicknessPx} />}
        <section className={`workspace-group${group.id === state.activeGroupId ? ' is-active' : ''}`} data-group={group.id} aria-label={`Editor group ${number + 1}`}
          onPointerDownCapture={() => workspace.focusGroup(group.id)} onFocusCapture={() => workspace.focusGroup(group.id)}>
          {group.tabs.length > 0 && <header className="workspace-tabbar">
            <div className="workspace-tabs" role="tablist" data-tab-group={group.id} aria-label={`Editor tabs ${number + 1}`}>
              {group.tabs.map((tab, index) => {
                const comparison = tab.kind === 'comparison';
                const prefix = comparison ? 'Commit: ' : '';
                const label = `${prefix}${tab.path}${comparison && tab.description ? ` — ${tab.description}` : ''}`;
                // Keep the captured pointer source mounted while the preview changes.
                return <Fragment key={tab.instanceId}>
                  {insertionBoundary === index && insertion}
                  <div role="presentation" data-document-id={tab.id} className={`workspace-tab-shell${group.activeId === tab.id ? ' is-selected' : ''}${dragMode && dragged.current?.instanceId === tab.instanceId ? dragMode === 'reorder' ? ' is-reordering-tab' : ' is-drag-source' : ''}`}>
                    <button ref={node => { if (node) buttons.current.set(tab.instanceId, node); else buttons.current.delete(tab.instanceId); }}
                      id={`${token}-${tab.instanceId}`} role="tab" aria-label={label} aria-selected={group.activeId === tab.id} aria-controls={panelId}
                      tabIndex={group.activeId === tab.id ? 0 : -1} className="workspace-tab" data-document-id={tab.id} data-instance-id={tab.instanceId} title={label}
                      onClick={() => workspace.activate(group.id, tab.id)} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); close(group.id, tab.id); } }}
                      onKeyDown={event => tabKeyDown(event, group.id, tab)} draggable={false}
                      onContextMenu={event => fileActions?.(event, { kind: tab.kind, path: tab.path, documentId: tab.id }, tabActions(group.id, tab))}
                      onPointerDown={event => startTabDrag(event, group.id, tab)} onDragStart={event => event.preventDefault()}>
                      {comparison ? <UiIcon name="diff" /> : <FileTypeIcon path={tab.path} />}<span className="workspace-tab-name">{prefix}{tab.path.slice(tab.path.lastIndexOf('/') + 1)}</span>
                      {(getBuffer(tab.editKey)?.dirty || getBuffer(tab.editKey)?.saving) && <span className="workspace-unsaved" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
                    </button>
                    <button type="button" tabIndex={-1} className="workspace-tab-close" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => close(group.id, tab.id)}><UiIcon name="close" size={12} /></button>
                  </div>
                </Fragment>;
              })}
              {insertionBoundary === group.tabs.length && insertion}
            </div>
            <MenuButton label={`Editor group ${number + 1} options`} showChevron={false} className="workspace-options" items={[
              { id: 'save', label: 'Save', shortcut: '⌘/Ctrl S', disabled: !getBuffer(active?.editKey)?.dirty || getBuffer(active?.editKey)?.saving, onSelect: () => { if (active?.editKey) void saveBuffer(active.editKey); } },
              { id: 'split-right', label: 'Split right', icon: <UiIcon name="split" />, disabled: !active, onSelect: () => { focusDestination.current = true; workspace.split(group.id, 'right'); } },
              { id: 'split-down', label: 'Split down', icon: <UiIcon name="split" />, disabled: !active, onSelect: () => { focusDestination.current = true; workspace.split(group.id, 'down'); } },
              { id: 'move', label: 'Move tab to other group', disabled: !active || !split, onSelect: () => { if (active) { focusDestination.current = true; workspace.move(group.id, active.id, opposite(group.id)); } } },
              { id: 'separator', kind: 'separator' },
              { id: 'close-other', label: 'Close other tabs', disabled: group.tabs.length < 2, onSelect: () => {
                const others = group.tabs.filter(tab => tab.id !== group.activeId);
                guardClose(others, () => { for (const tab of others) workspace.close(group.id, tab.id); });
              } },
              { id: 'join', label: 'Unsplit', disabled: !split, onSelect: () => { focusDestination.current = true; workspace.join(); } },
            ]}><UiIcon name="more" /></MenuButton>
          </header>}
          <div id={panelId} className="workspace-content" role="tabpanel" aria-labelledby={active ? `${token}-${active.instanceId}` : undefined} aria-label={active ? undefined : 'Empty editor group'}>
            {active ? <WorkspaceApplicationActions.Provider key={active.instanceId} value={applicationActionsEnabled && group.id === state.activeGroupId}>{renderTab(active, group.id)}</WorkspaceApplicationActions.Provider> : emptyState ?? <div className="workspace-empty"><UiIcon name="file" /><span>Select a file to open it</span></div>}
            {(['left', 'right', 'up', 'down'] as const).map(edge => <div key={edge} aria-hidden="true" className={`workspace-drop-zone drop-${edge}`} data-testid={`editor-drop-${edge}`} />)}
          </div>
        </section>
      </Fragment>;
    })}
    {dropHint?.kind === 'content' && <div aria-hidden="true" className="workspace-drop-preview" data-testid="workspace-drop-preview"
      data-drop-kind={dropHint.edge ? 'split' : 'move'} data-drop-direction={dropHint.edge} data-drop-group={dropHint.destination} data-drop-rounding={dropHint.rounding}
      style={{ left: dropHint.left, top: dropHint.top, width: dropHint.width, height: dropHint.height }} />}
    {pendingClose && <UnsavedDialog keys={pendingClose.keys} onCancel={() => setPendingClose(undefined)} onContinue={() => { pendingClose.perform(); setPendingClose(undefined); }} />}
  </div>;
}
