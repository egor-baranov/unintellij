import { ProjectIcon } from './icons';
import './project.css';

export type WorkspaceMode = 'project' | 'commit';
export interface WorkspaceSwitchProps { value: WorkspaceMode | null; onChange: (value: WorkspaceMode) => void }

export function WorkspaceSwitch({ value, onChange }: WorkspaceSwitchProps) {
  return <div className="workspace-switch" role="group" aria-label="Workspace view">
    <button type="button" aria-label="Project" title={value === 'project' ? 'Hide Project panel (⌘/Ctrl+B)' : 'Show Project panel'}
      aria-pressed={value === 'project'} aria-expanded={value === 'project'} aria-keyshortcuts={value === 'project' ? 'Meta+B Control+B' : undefined}
      onClick={() => onChange('project')}><ProjectIcon name="project" /></button>
    <button type="button" aria-label="Commit" title={value === 'commit' ? 'Hide Commit panel (⌘/Ctrl+B)' : 'Show Commit panel'}
      aria-pressed={value === 'commit'} aria-expanded={value === 'commit'} aria-keyshortcuts={value === 'commit' ? 'Meta+B Control+B' : undefined}
      onClick={() => onChange('commit')}><ProjectIcon name="commit" /></button>
  </div>;
}
