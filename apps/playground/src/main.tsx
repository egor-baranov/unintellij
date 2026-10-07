import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SmartDiff } from 'monaco-smart-diff';
import { DiffSurface, defaultPreferences, type ViewerPreferences, type ViewerState } from '../../shared/DiffSurface';
import { Controls } from '../../shared/Controls';
import { AddedFileSurface } from '../../shared/AddedFileSurface';
import { FixtureMenu } from '../../shared/FixtureMenu';
import { EditorHeading } from '../../shared/EditorHeading';
import { MenuButton, UiIcon } from '../../shared/ui';
import { monaco } from '../../shared/monaco';
import { fixtures } from './fixtures';
import { CommitPreview } from './CommitPreview';
import { WorkspaceSwitch } from '../../shared/project/WorkspaceSwitch';
import { SettingsButton } from '../../shared/settings/SettingsButton';
import '../../shared/app.css';

declare global { interface Window { playground: { viewer: SmartDiff | null; editor: monaco.editor.IStandaloneCodeEditor | null; monaco: typeof monaco; selectFixture: (id: string) => void; setPreferences: (preferences: Partial<ViewerPreferences>) => void; setMounted: (mounted: boolean) => void; setSecondary: (enabled: boolean) => void; setContents: (original: string, modified: string) => void; getState: () => ViewerState } } }
const initialState: ViewerState = { status: 'loading', changeCount: 0, currentChange: -1 };
function App() {
  const [fixtureId, selectFixture] = useState(new URLSearchParams(location.search).get('fixture') ?? 'reference');
  const fixture = fixtures.find(item => item.id === fixtureId) ?? fixtures[0];
  const [contents, setContents] = useState<{ original: string; modified: string; custom: boolean } | null>(null);
  const added = fixture.id === 'added' && !contents?.custom;
  // Keep the read-only added-file presentation available for compatibility checks.
  const readOnlyAdded = new URLSearchParams(location.search).get('readOnly') === '1';
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [state, setState] = useState(initialState);
  const [mounted, setMounted] = useState(true);
  const [secondary, setSecondary] = useState(false);
  const [secondaryModified, setSecondaryModified] = useState(fixtures[0].modified);
  const [secondarySplit, setSecondarySplit] = useState(0.5);
  const viewer = useRef<SmartDiff | null>(null);
  const addedEditor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const stateRef = useRef(state); stateRef.current = state;
  useEffect(() => {
    window.playground = { viewer: viewer.current, editor: addedEditor.current, monaco,
      selectFixture: id => { setContents(null); selectFixture(id); },
      setPreferences: next => setPreferences(previous => ({ ...previous, ...next })), setMounted, setSecondary,
      setContents: (original, modified) => setContents({ original, modified, custom: true }), getState: () => stateRef.current,
    };
  }, []);
  const registerViewer = (instance: SmartDiff | null) => { viewer.current = instance; if (window.playground) window.playground.viewer = instance; };
  const registerAdded = (instance: monaco.editor.IStandaloneCodeEditor | null) => {
    addedEditor.current = instance;
    if (window.playground) window.playground.editor = instance;
    if (instance) setState({ status: 'ready', changeCount: 0, currentChange: -1 });
  };
  const resizeDiff = (splitRatio: number) => setPreferences(previous => previous.splitRatio === splitRatio ? previous : { ...previous, splitRatio });
  const editModified = (modified: string) => setContents(previous => ({ original: previous?.original ?? fixture.original, modified, custom: previous?.custom ?? false }));
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.altKey && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); if (event.key === 'ArrowDown') viewer.current?.nextChange(); else viewer.current?.previousChange(); }
    };
    window.addEventListener('keydown', navigate); return () => window.removeEventListener('keydown', navigate);
  }, []);
  const notice = added ? null : state.message ?? (state.featureUnavailable?.length ? state.featureUnavailable.join(' · ') : null);
  return <div className="application playground-application">
    <header className="topbar"><WorkspaceSwitch value={null} onChange={mode => { const url = new URL(location.href); url.searchParams.set('view', mode); url.searchParams.delete('fixture'); location.assign(url); }} /><span className="toolbar-divider" />
      <FixtureMenu fixtures={fixtures} selectedId={fixtureId} onSelect={id => { setContents(null); selectFixture(id); }} />
      <span className="preview-indicator">Playground</span><span className="topbar-spacer"/>
      <MenuButton label="Playground tools" showChevron={false} items={[{ id: 'heading', kind: 'label', label: 'Development' }, { id: 'secondary', kind: 'checkbox', label: 'Second viewer', checked: secondary, onSelect: () => setSecondary(value => !value) }, { id: 'mounted', kind: 'checkbox', label: 'Mount viewer', checked: mounted, onSelect: () => setMounted(value => !value) }]}><UiIcon name="more" /></MenuButton><SettingsButton />
    </header>
    {notice && <div className="notice" role="status">{notice}</div>}
    <div className="viewer-stage"><section className="viewer-section"><EditorHeading path={fixture.path} suffix={added ? 'Added file' : 'Diff fixture'} />{!added && <div className="editor-toolbar"><Controls preferences={preferences} onChange={setPreferences} state={state} previous={() => viewer.current?.previousChange()} next={() => viewer.current?.nextChange()} expandAll={() => viewer.current?.expandAllRegions()} collapseAll={() => viewer.current?.collapseAllRegions()} /></div>}
      {mounted && (added ? <AddedFileSurface path={fixture.path} text={contents?.modified ?? fixture.modified} editable={!readOnlyAdded} onChange={editModified} wrap={preferences.wrap} onWrapChange={wrap => setPreferences(previous => ({ ...previous, wrap }))} stateKey={`fixture-added:${fixture.id}`} onEditor={registerAdded} /> : <DiffSurface original={contents?.original ?? fixture.original} modified={contents?.modified ?? fixture.modified} editable onChange={editModified} path={fixture.path} preferences={preferences} onState={setState} onViewer={registerViewer} onSplitRatioChange={resizeDiff} />)}
      {!added && state.status === 'empty' && <div className="empty-diff-banner">No differences</div>}
    </section>{secondary && <section className="viewer-section"><DiffSurface original={fixtures[0].original} modified={secondaryModified} editable onChange={setSecondaryModified} path={fixtures[0].path} preferences={{ ...preferences, splitRatio: secondarySplit }} onState={() => undefined} onSplitRatioChange={setSecondarySplit} /></section>}</div>
    <span className="sr-only" data-testid="viewer-status" role="status">{state.status}</span>
  </div>;
}
createRoot(document.getElementById('root')!).render(['project', 'commit'].includes(new URLSearchParams(location.search).get('view') ?? '') ? <CommitPreview /> : <App />);
