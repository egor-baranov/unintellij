import { useEffect, useRef, useState } from 'react';
import { UiIcon } from '../ui/UiIcon';
import { SettingsDialog } from './SettingsDialog';
import { useApplicationActions } from '../actions/renderer';
import './settings.css';

export function SettingsButton({ label, className = '' }: { label?: string; className?: string } = {}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useApplicationActions({ 'app.settings': { enabled: !open, run: () => setOpen(true) } });
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || open) return;
      const controlShortcut = event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey && event.code === 'KeyS';
      const macShortcut = event.metaKey && !event.ctrlKey && !event.altKey && event.key === ',';
      if (!controlShortcut && !macShortcut) return;
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [open]);
  function close() {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }
  return <>
    <button ref={trigger} type="button" className={`ui-toolbar-icon app-settings-button ${className}`} aria-label="Settings"
      aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="Control+Alt+S Meta+," title="Settings (⌘, / Ctrl+Alt+S)" onClick={() => setOpen(true)}><UiIcon name="settings" />{label && <span>{label}</span>}</button>
    {open && <SettingsDialog onClose={close} />}
  </>;
}
