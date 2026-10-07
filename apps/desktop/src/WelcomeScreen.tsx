import { useEffect, useState } from 'react';
import type { RecentProject } from './bridge';
import { SettingsButton } from '../../shared/settings/SettingsButton';
import { UiIcon } from '../../shared/ui';
import { ProjectBadge } from '../../shared/ProjectBadge';
import './welcome.css';

/** The launcher owns no editor, repository capabilities, or workspace chrome. */
export function WelcomeScreen({ busy, error, onOpen, onCreate, onClone, onRecent, onDismissError }: {
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onCreate?: () => void;
  onClone?: () => void;
  onRecent: (id: string) => void;
  onDismissError: () => void;
}) {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string>();
  const [search, setSearch] = useState('');
  useEffect(() => {
    let live = true;
    // A renderer updated by Vite can outlive its main process/preload. Explain
    // that mismatch rather than exposing a missing-method exception to users.
    const read = async () => {
      if (!window.desktop.listRecentProjects) throw new Error('unintellij was updated. Restart the application to load the new desktop features.');
      return window.desktop.listRecentProjects();
    };
    void read().then(value => { if (live) setProjects(value); }).catch(cause => {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (live) setHistoryError(/No handler registered for ['"]repository:recent['"]/.test(message)
        ? 'unintellij was updated. Restart the application to load the new desktop features.' : message);
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  const query = search.trim().toLocaleLowerCase();
  const filtered = projects.filter(project => `${project.name}\n${project.path}\n${project.displayPath ?? ''}`.toLocaleLowerCase().includes(query));
  return <main className="application welcome-screen" aria-label="Welcome">
    <header className="topbar desktop-topbar welcome-titlebar" />
    <div className="welcome-layout">
      <aside className="welcome-sidebar" aria-label="Welcome navigation">
        <div className="welcome-caption">Welcome</div>
        <div className="welcome-navigation-current" aria-current="page"><UiIcon name="project" /><span>Projects</span></div>
        <SettingsButton label="Customize…" className="welcome-settings" />
      </aside>
      <div className="welcome-content">
        <header className="welcome-heading">
          <h1>Projects</h1>
          <div className="welcome-actions" role="group" aria-label="Project actions">
            <button className="welcome-create" disabled={busy || !onCreate} onClick={onCreate}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="currentColor" /></svg>New Project…
            </button>
            <button disabled={busy} onClick={onOpen}><UiIcon name="folder" />Open…</button>
            <button disabled={busy || !onClone} onClick={onClone}><UiIcon name="branch" />Get from VCS…</button>
          </div>
        </header>
      {(error || historyError) && <div className="welcome-error" role="alert">
        <span>{error || historyError}</span>
        <button className="chrome-icon-button" aria-label="Dismiss error" onClick={() => { setHistoryError(undefined); onDismissError(); }}><UiIcon name="close" /></button>
      </div>}
      <section className="welcome-projects" aria-labelledby="recent-projects-heading">
        <label className="welcome-search"><UiIcon name="search" />
          <input type="search" aria-label="Search projects" placeholder="Search projects" value={search} spellCheck={false} autoComplete="off"
            onChange={event => setSearch(event.target.value)} onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); setSearch(''); }
              if (event.key === 'Enter' && filtered[0] && !busy) { event.preventDefault(); onRecent(filtered[0].id); }
              if (event.key === 'ArrowDown') { event.preventDefault(); event.currentTarget.closest('section')?.querySelector<HTMLButtonElement>('.welcome-project:not(:disabled)')?.focus(); }
            }} />
        </label>
        <h2 id="recent-projects-heading">Recent projects</h2>
        <div className="welcome-project-list">
          {filtered.length > 0 ? <ul aria-label="Recent projects" onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.welcome-project:not(:disabled)'));
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
            buttons[next]?.focus();
          }}>{filtered.map(project => <li key={project.id}>
            <button className="welcome-project" disabled={busy} aria-label={`Open ${project.name}`} title={project.path} onClick={() => onRecent(project.id)}>
              <ProjectBadge project={project} />
              <span className="welcome-project-details"><strong>{project.name}</strong><span>{project.displayPath ?? project.path}</span></span>
            </button>
          </li>)}</ul> : <div className="welcome-empty" role="status">
            <p>{loading ? 'Loading recent projects…' : query ? 'No matching projects.' : 'Your recent projects will appear here.'}</p>
            {!loading && !query && <p>Create a project, open a folder, or get one from version control.</p>}
          </div>}
        </div>
        <p className="welcome-status" role="status">{busy ? 'Opening project…' : ''}</p>
      </section>
      </div>
    </div>
  </main>;
}
