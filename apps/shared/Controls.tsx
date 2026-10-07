import type { ViewerPreferences, ViewerState } from './DiffSurface';
import { MenuButton, UiIcon } from './ui';

export function Controls({ preferences, onChange, state, previous, next, expandAll, collapseAll }: {
  preferences: ViewerPreferences; onChange: (next: ViewerPreferences) => void; state: ViewerState;
  previous: () => void; next: () => void;
  expandAll: () => void; collapseAll: () => void;
}) {
  const inline = preferences.viewMode === 'inline';
  return <div className="diff-controls" role="toolbar" aria-label="Diff controls">
    <button className="ui-toolbar-icon" aria-label="Previous change" title="Previous change (Alt+Up)" onClick={previous} disabled={!state.changeCount}><UiIcon name="up" /></button>
    <span className="change-count" aria-live="polite" data-testid="change-count">{state.changeCount ? `${Math.max(0, state.currentChange + 1)} / ${state.changeCount}` : '0 changes'}</span>
    <button className="ui-toolbar-icon" aria-label="Next change" title="Next change (Alt+Down)" onClick={next} disabled={!state.changeCount}><UiIcon name="down" /></button>
    <span className="toolbar-divider" />
    <button className="ui-toolbar-icon" aria-label="Expand all unchanged regions" title="Expand all unchanged regions" disabled={!state.changeCount} onClick={() => { onChange({ ...preferences, collapse: true }); expandAll(); }}><UiIcon name="expand" /></button>
    <button className="ui-toolbar-icon" aria-label="Collapse all unchanged regions" title="Collapse all unchanged regions" disabled={!state.changeCount} onClick={() => { onChange({ ...preferences, collapse: true }); collapseAll(); }}><UiIcon name="collapse" /></button>
    <span className="diff-controls-spacer" />
    <span className="toolbar-divider" />
    <MenuButton label="Diff view" items={[
      { id: 'side-by-side', kind: 'radio', label: 'Side by side', checked: !inline, onSelect: () => onChange({ ...preferences, viewMode: 'side-by-side' }) },
      { id: 'inline', kind: 'radio', label: 'Inline', checked: inline, onSelect: () => onChange({ ...preferences, viewMode: 'inline' }) },
    ]}><span>{inline ? 'Inline' : 'Side by side'}</span></MenuButton>
    {!inline && <MenuButton label="Layout" className="ui-layout-trigger" items={[
      { id: 'layout-label', kind: 'label', label: 'Diff layout' },
      { id: 'compact', kind: 'radio', label: 'Compact', description: 'Connect corresponding changes without spacer lines.', checked: preferences.layout === 'compact', onSelect: () => onChange({ ...preferences, layout: 'compact' }) },
      { id: 'aligned', kind: 'radio', label: 'Aligned', description: 'Align corresponding blocks with spacer lines.', checked: preferences.layout === 'aligned', onSelect: () => onChange({ ...preferences, layout: 'aligned' }) },
    ]}><UiIcon name={preferences.layout === 'compact' ? 'compact' : 'split'} /><span>{preferences.layout === 'compact' ? 'Compact' : 'Aligned'}</span></MenuButton>}
    {!inline && <button className="ui-toolbar-toggle" aria-label="Synchronize scrolling" title="Synchronize corresponding code while scrolling" aria-pressed={preferences.sync} onClick={() => onChange({ ...preferences, sync: !preferences.sync })}><UiIcon name="sync" /><span>Sync</span></button>}
    <MenuButton label="Diff options" title="Diff options" className="ui-settings-trigger" showChevron={false} items={[
      { id: 'presentation', kind: 'label', label: 'Presentation' },
      { id: 'collapse', kind: 'checkbox', label: 'Collapse unchanged', checked: preferences.collapse, onSelect: () => onChange({ ...preferences, collapse: !preferences.collapse }) },
      { id: 'wrap', kind: 'checkbox', label: 'Wrap long lines', checked: preferences.wrap, onSelect: () => onChange({ ...preferences, wrap: !preferences.wrap }) },
      { id: 'separator', kind: 'separator' },
      { id: 'comparison', kind: 'label', label: 'Comparison' },
      { id: 'whitespace', kind: 'checkbox', label: 'Ignore trim whitespace', checked: preferences.whitespace, onSelect: () => onChange({ ...preferences, whitespace: !preferences.whitespace }) },
    ]}><UiIcon name="settings" /></MenuButton>
  </div>;
}
