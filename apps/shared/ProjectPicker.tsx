import { MenuButton, UiIcon, type MenuEntry } from './ui';
import { ProjectBadge } from './ProjectBadge';
import './ProjectPicker.css';

export interface PickerProject { id: string; name: string; path: string; displayPath?: string }
export interface ProjectPickerProps {
  project?: PickerProject;
  projects?: PickerProject[];
  recentProjects?: PickerProject[];
  onCreate?: () => void;
  onOpen?: () => void;
  onClone?: () => void;
  onSelect?: (id: string) => void;
  onSelectRecent?: (id: string) => void;
  onOpenChange?: (open: boolean) => void;
  busy?: boolean;
  preview?: boolean;
}

/** Canonical paths come from the host. Open projects do not repeat in recents. */
export function pickerProjectGroups(projects: PickerProject[], recentProjects: PickerProject[]) {
  const seen = new Set<string>();
  const unique = (items: PickerProject[]) => items.filter(item => {
    if (seen.has(item.path)) return false;
    seen.add(item.path); return true;
  });
  return { open: unique(projects), recent: unique(recentProjects) };
}

/** Only previously opened main-process repository IDs can be selected. */
export function ProjectPicker({ project, projects = project ? [project] : [], recentProjects = [], onCreate, onOpen, onClone, onSelect, onSelectRecent, onOpenChange, busy, preview }: ProjectPickerProps) {
  const groups = pickerProjectGroups(projects.length ? projects : project ? [project] : [], recentProjects);
  const projectItem = (item: PickerProject, recent: boolean): MenuEntry => ({
    id: `${recent ? 'recent' : 'open'}:${item.id}`, label: item.name, description: item.displayPath ?? item.path, title: item.path,
    className: 'project-picker-entry', icon: <ProjectBadge project={item} />,
    onSelect: () => (recent ? onSelectRecent : onSelect)?.(item.id),
    disabled: busy || !(recent ? onSelectRecent : onSelect),
  });
  const items: MenuEntry[] = [
    { id: 'new', label: 'New Project…', icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1v14M1 8h14" stroke="currentColor" /></svg>, onSelect: () => onCreate?.(), disabled: !onCreate || busy },
    { id: 'open', label: 'Open…', icon: <UiIcon name="folder" />, onSelect: () => onOpen?.(), disabled: !onOpen || busy },
    { id: 'clone', label: 'Clone Repository…', icon: <UiIcon name="branch" />, onSelect: () => onClone?.(), disabled: !onClone || busy },
    { id: 'projects-divider', kind: 'separator' },
    { id: 'projects-label', kind: 'label', label: 'Open Projects' },
    ...groups.open.map(item => projectItem(item, false)),
    ...(!groups.open.length ? [{ id: 'empty', kind: 'label' as const, label: 'No project open' }] : []),
    ...(groups.recent.length ? [
      { id: 'recent-divider', kind: 'separator' as const },
      { id: 'recent-label', kind: 'label' as const, label: 'Recent Projects' },
      ...groups.recent.map(item => projectItem(item, true)),
    ] : []),
  ];
  return <MenuButton label="Project switcher" className="project-picker" menuClassName="project-picker-menu" align="start" items={items} onOpenChange={onOpenChange}
    title={preview ? 'Preview project — project actions are available in the desktop app' : project?.path ?? 'Open a local project'}>
    {project ? <ProjectBadge project={project} /> : <UiIcon name="folder" />}
    <span className="project-picker-name">{project?.name ?? 'Open project'}</span>
  </MenuButton>;
}
