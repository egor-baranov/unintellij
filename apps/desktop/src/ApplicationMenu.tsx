import { useEffect, useState, useSyncExternalStore } from 'react';
import { monaco } from '../../shared/monaco';
import { installApplicationMenu, useApplicationActions } from '../../shared/actions/renderer';
import { dirtyKeys, getBuffer, saveBuffer, subscribeEditing, useEditingRevision } from '../../shared/editing/store';
import { getFileSavingSettings, saveFileSavingSettings, subscribeFileSavingSettings } from '../../shared/settings/fileSaving';

function nativeTextInput(): boolean {
  const element = document.activeElement;
  return element instanceof HTMLInputElement && !element.readOnly && !element.disabled
    || element instanceof HTMLTextAreaElement && !element.readOnly && !element.disabled
    || element instanceof HTMLElement && element.isContentEditable;
}
async function waitForSave(key: string): Promise<void> {
  if (!getBuffer(key)?.saving) return;
  await new Promise<void>(resolve => {
    const unsubscribe = subscribeEditing(() => { if (!getBuffer(key)?.saving) { unsubscribe(); resolve(); } });
  });
}

/** One bridge subscription for this window. Editors register their own actions;
 * text-input undo remains native when focus belongs to a form or search field. */
export function ApplicationMenu({ repositoryId, onError }: { repositoryId?: string; onError: (message: string) => void }) {
  useEditingRevision();
  const saving = useSyncExternalStore(subscribeFileSavingSettings, getFileSavingSettings);
  const [, focusChanged] = useState(0);
  useEffect(() => installApplicationMenu(window.desktop, onError), [onError]);
  useEffect(() => {
    let live = true;
    const changed = () => queueMicrotask(() => { if (live) focusChanged(value => value + 1); });
    document.addEventListener('focusin', changed); document.addEventListener('focusout', changed);
    return () => { live = false; document.removeEventListener('focusin', changed); document.removeEventListener('focusout', changed); };
  }, []);
  const focusedEditor = monaco.editor.getEditors().find(editor => editor.hasTextFocus());
  const canEdit = focusedEditor ? !focusedEditor.getOption(monaco.editor.EditorOption.readOnly) : nativeTextInput();
  const undo = async (action: 'undo' | 'redo') => {
    const editor = monaco.editor.getEditors().find(editor => editor.hasTextFocus());
    if (editor) { if (!editor.getOption(monaco.editor.EditorOption.readOnly)) editor.trigger('application-menu', action, null); }
    else if (nativeTextInput()) await window.desktop.performNativeEdit(action);
  };
  const keys = repositoryId ? dirtyKeys().filter(key => getBuffer(key)?.repositoryId === repositoryId) : [];
  useApplicationActions({
    'file.autoSave': { checked: saving.autoSave, run: () => saveFileSavingSettings({ autoSave: !getFileSavingSettings().autoSave }) },
    'file.saveAll': { enabled: keys.length > 0, run: async () => {
      for (const key of keys) {
        await waitForSave(key);
        if (!await saveBuffer(key) && getBuffer(key)?.error) throw new Error(getBuffer(key)!.error);
      }
    } },
    'edit.undo': { enabled: canEdit, allowInModal: true, run: () => undo('undo') },
    'edit.redo': { enabled: canEdit, allowInModal: true, run: () => undo('redo') },
  });
  return null;
}
