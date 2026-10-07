import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TreeAction, TreeActionsInfo } from '../../desktop/src/bridge';

export type DialogTreeAction = 'remove' | 'rename' | 'create-file' | 'create-directory';
const titles: Record<DialogTreeAction, string> = { remove: 'Remove from Git', rename: 'Rename', 'create-file': 'New File', 'create-directory': 'New Folder' };

/** Renderer-owned prompts. Validation in the main process remains authoritative. */
export function TreeActionDialog({ kind, info, onPerform, onClose }: {
  kind: DialogTreeAction;
  info: TreeActionsInfo;
  onPerform: (action: TreeAction) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const titleId = useId(), nameId = useId(), errorId = useId();
  const [name, setName] = useState(kind === 'rename' ? info.path.split('/').at(-1) ?? '' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const title = titles[kind];
  const parent = kind === 'rename' || info.kind !== 'directory' ? info.parentPath : info.path;
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal(); input.current?.focus(); input.current?.select();
    return () => { mounted.current = false; dialog.current?.close(); };
  }, []);
  useEffect(() => { if (error && !busy) input.current?.focus(); }, [error, busy]);
  async function submit() {
    if (pending.current) return;
    if (kind !== 'remove' && (!name.trim() || name === '.' || name === '..' || /[/\\\0]/.test(name))) {
      setError('Enter a name without folder separators.'); input.current?.focus(); return;
    }
    pending.current = true; setBusy(true); setError(undefined);
    try {
      await onPerform(kind === 'remove' ? { kind } : { kind, name });
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
    } finally {
      pending.current = false;
    }
  }
  return createPortal(<dialog ref={dialog} className="tree-action-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h2 id={titleId}>{title}</h2>
      {kind === 'remove' ? <p>Remove <strong>{info.kind === 'group' ? `${info.removeFileCount ?? info.fileCount} ${(info.removeFileCount ?? info.fileCount) === 1 ? 'file' : 'files'} in ${info.label}` : info.path || 'the project'}</strong> from Git tracking? Local files will be kept.</p> : <>
        <p className="tree-action-location" title={parent || 'Project root'}>{kind === 'rename' ? info.path : parent || 'Project root'}</p>
        <label htmlFor={nameId}>Name</label>
        <input ref={input} id={nameId} value={name} disabled={busy} autoComplete="off" spellCheck={false}
          aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
          onChange={event => { setName(event.target.value); setError(undefined); }} />
      </>}
      {error && <p id={errorId} className="tree-action-validation" role="alert">{error}</p>}
      <footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="tree-action-primary" disabled={busy || kind !== 'remove' && !name.trim()}>
          {busy ? 'Applying…' : kind === 'remove' ? 'Remove from Git' : kind === 'rename' ? 'Rename' : 'Create'}
        </button>
      </footer>
    </form>
  </dialog>, document.body);
}
