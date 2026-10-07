import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dirtyKeys, discardBuffer, getBuffer, pauseAutomaticSaving, saveBuffer, useEditingRevision } from './store';
import { AutoSaveController } from './autoSave';
import { getFileSavingSettings, subscribeFileSavingSettings } from '../settings/fileSaving';
import './editing.css';

export function UnsavedDialog({ keys, onContinue, onCancel }: { keys: string[]; onContinue: () => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  useEditingRevision();
  const entries = keys.map(key => getBuffer(key)).filter(entry => !!entry);
  const pendingKeys = JSON.stringify(keys);
  useEffect(() => pauseAutomaticSaving(JSON.parse(pendingKeys) as string[]), [pendingKeys]);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return createPortal(<dialog ref={dialog} className="unsaved-dialog" aria-labelledby="unsaved-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="unsaved-title">Save changes?</h2>
    <p>{entries.length === 1 ? entries[0].path : `${entries.length} files`} {entries.length === 1 ? 'has' : 'have'} unsaved changes.</p>
    {entries.some(entry => entry.error) && <p role="alert">{entries.find(entry => entry.error)?.error}</p>}
    <footer>
      <button disabled={busy} onClick={onCancel}>Cancel</button>
      <button disabled={busy || entries.some(entry => entry.saving)} onClick={() => { keys.forEach(discardBuffer); onContinue(); }}>Discard</button>
      <button className="save-primary" disabled={busy || entries.some(entry => entry.saving)} onClick={async () => {
        setBusy(true);
        for (const key of keys) if (!await saveBuffer(key)) { setBusy(false); return; }
        setBusy(false); onContinue();
      }}>{busy ? 'Saving…' : 'Save'}</button>
    </footer>
  </dialog>, document.body);
}

/** Electron cancels beforeunload while this renderer-owned confirmation is open. */
export function EditingGuard() {
  const [exiting, setExiting] = useState(false);
  const allowExit = useRef(false);
  useEffect(() => {
    const autoSave = new AutoSaveController();
    const update = () => autoSave.setEnabled(getFileSavingSettings().autoSave);
    const unsubscribe = subscribeFileSavingSettings(update);
    update();
    return () => { unsubscribe(); autoSave.dispose(); };
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (allowExit.current || !dirtyKeys().length) return;
      event.preventDefault(); event.returnValue = '';
      if (window.desktop) setExiting(true);
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);
  return exiting ? <UnsavedDialog keys={dirtyKeys()} onCancel={() => setExiting(false)} onContinue={() => { allowExit.current = true; window.close(); }} /> : null;
}
