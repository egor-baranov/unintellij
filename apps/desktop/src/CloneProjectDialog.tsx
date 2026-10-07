import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UiIcon } from '../../shared/ui';
import './project-actions.css';

/** Native destination selection follows URL entry; the backend owns cloning. */
export function CloneProjectDialog({ onClose, onClone }: { onClose: () => void; onClone: (url: string) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const titleId = useId(), inputId = useId(), hintId = useId();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.showModal(); input.current?.focus();
    return () => { mounted.current = false; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={dialog} className="project-action-dialog" aria-labelledby={titleId} aria-describedby={hintId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={event => {
      event.preventDefault(); if (busy || !url.trim()) return;
      setBusy(true); setError(undefined);
      void onClone(url.trim()).then(() => { if (mounted.current) onClose(); }).catch(cause => {
        if (mounted.current) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
      });
    }}>
      <header><h2 id={titleId}>Clone Repository</h2><button type="button" aria-label="Close" disabled={busy} onClick={onClose}><UiIcon name="close" /></button></header>
      <div className="project-action-fields">
        <label htmlFor={inputId}>Repository URL</label>
        <input ref={input} id={inputId} type="text" value={url} disabled={busy} spellCheck={false} autoComplete="off" placeholder="https://github.com/owner/project.git"
          onChange={event => setUrl(event.target.value)} />
        <p id={hintId}>Enter an HTTPS or SSH repository URL, then choose a new project folder.</p>
        {error && <p className="project-action-error" role="alert">{error}</p>}
        {busy && <p role="status">Cloning repository…</p>}
      </div>
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="project-action-primary" disabled={busy || !url.trim()} type="submit">Choose destination…</button></footer>
    </form>
  </dialog>, document.body);
}
