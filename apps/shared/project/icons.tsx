import { FileTypeIcon, JetBrainsIcon } from '../icons';

export type ProjectIconName = 'folder' | 'root' | 'project' | 'chevron' | 'refresh' | 'locate' | 'expand' | 'collapse' | 'commit' | 'link' | 'module';
export function ProjectIcon({ name, className = '' }: { name: ProjectIconName; className?: string }) {
  // Upstream symlink artwork is an overlay, not a complete file silhouette.
  // A link target is deliberately not followed, so use a generic file beneath it.
  if (name === 'link') return <span className={`project-icon project-link-icon ${className}`} aria-hidden="true"><JetBrainsIcon name="file-unknown" /><JetBrainsIcon name="link" /></span>;
  return <JetBrainsIcon name={name === 'chevron' ? 'chevron-right' : name} className={`project-icon ${className}`} />;
}

export function ProjectFileIcon({ path }: { path: string }) {
  return <FileTypeIcon path={path} className="project-icon project-file-icon" />;
}
