import { useEffect, useRef, useState } from 'react';
import type { editor } from 'monaco-editor';
import type { SmartDiff } from 'monaco-smart-diff';
import { monaco } from '../monaco';
import { useApplicationActions } from '../actions/renderer';
import type { ViewerPreferences, ViewerState } from '../DiffSurface';
import { useWorkspaceApplicationActions } from './ApplicationActionsContext';

/** Menus target the actual focused pane, including a read-only original pane. */
export function useEditorApplicationActions({ fileEditor, viewer, preferences, state, onPreferences }: {
  fileEditor: editor.IStandaloneCodeEditor | null;
  viewer: SmartDiff | null;
  preferences: ViewerPreferences;
  state: ViewerState;
  onPreferences: (preferences: ViewerPreferences) => void;
}) {
  const active = useWorkspaceApplicationActions();
  const lastFocused = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [, update] = useState(0);
  useEffect(() => {
    const editors = fileEditor ? [fileEditor] : viewer ? Object.values(viewer.getEditors()) : [];
    lastFocused.current = null;
    const listeners = editors.flatMap(instance => [
      instance.onDidFocusEditorWidget(() => { lastFocused.current = instance; update(value => value + 1); }),
      instance.onDidChangeModel(() => update(value => value + 1)),
      instance.onDidChangeConfiguration(event => {
        if (event.hasChanged(monaco.editor.EditorOption.readOnly)) update(value => value + 1);
      }),
    ]);
    return () => { for (const listener of listeners) listener.dispose(); lastFocused.current = null; };
  }, [fileEditor, viewer]);
  const target = () => {
    if (fileEditor) return fileEditor;
    if (!viewer) return null;
    const editors = viewer.getEditors();
    return Object.values(editors).find(instance => instance.hasWidgetFocus()) ?? lastFocused.current ?? editors.modified;
  };
  const current = target();
  const ready = !!current?.getModel();
  const writable = ready && !current!.getOption(monaco.editor.EditorOption.readOnly);
  const action = (id: string, requiresWrite = false) => ({
    enabled: ready && (!requiresWrite || writable) && !!current?.getAction(id),
    run: async () => {
      const instance = target();
      if (!instance?.getModel() || (requiresWrite && instance.getOption(monaco.editor.EditorOption.readOnly))) return;
      instance.focus();
      const command = instance.getAction(id);
      if (command?.isSupported()) await command.run();
    },
  });
  // Presentation controls also apply to identical files and partial/timeout
  // comparisons; change navigation follows the viewer's reported count.
  const diffReady = !!viewer && ready;
  const sideBySide = preferences.viewMode !== 'inline';
  useApplicationActions(active ? {
    'edit.find': action('actions.find'),
    'edit.replace': action('editor.action.startFindReplaceAction', true),
    'navigate.line': action('editor.action.gotoLine'),
    'code.commentLine': action('editor.action.commentLine', true),
    'code.commentBlock': action('editor.action.blockComment', true),
    'code.indent': action('editor.action.indentLines', true),
    'code.outdent': action('editor.action.outdentLines', true),
    'navigate.nextChange': { enabled: diffReady && state.changeCount > 0, run: () => viewer?.nextChange() },
    'navigate.previousChange': { enabled: diffReady && state.changeCount > 0, run: () => viewer?.previousChange() },
    'view.wrap': { enabled: ready, checked: preferences.wrap, run: () => onPreferences({ ...preferences, wrap: !preferences.wrap }) },
    'view.diff.sideBySide': { enabled: diffReady, checked: !!viewer && sideBySide, run: () => onPreferences({ ...preferences, viewMode: 'side-by-side' }) },
    'view.diff.inline': { enabled: diffReady, checked: !!viewer && !sideBySide, run: () => onPreferences({ ...preferences, viewMode: 'inline' }) },
    'view.diff.compact': { enabled: diffReady && sideBySide, checked: !!viewer && preferences.layout === 'compact', run: () => onPreferences({ ...preferences, layout: 'compact' }) },
    'view.diff.aligned': { enabled: diffReady && sideBySide, checked: !!viewer && preferences.layout === 'aligned', run: () => onPreferences({ ...preferences, layout: 'aligned' }) },
    'view.diff.sync': { enabled: diffReady && sideBySide, checked: !!viewer && preferences.sync, run: () => onPreferences({ ...preferences, sync: !preferences.sync }) },
    'view.diff.collapse': { enabled: diffReady, checked: !!viewer && preferences.collapse, run: () => onPreferences({ ...preferences, collapse: !preferences.collapse }) },
    'view.diff.whitespace': { enabled: diffReady, checked: !!viewer && preferences.whitespace, run: () => onPreferences({ ...preferences, whitespace: !preferences.whitespace }) },
  } : {});
}
