import { FileTypeIcon, JetBrainsIcon } from '../icons';

export type IconName = 'refresh' | 'expand' | 'collapse' | 'up' | 'down' | 'eye' | 'folder' | 'chevron' | 'copy' | 'more' | 'warning';

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <JetBrainsIcon name={name === 'chevron' ? 'chevron-right' : name} className={`commit-icon ${className}`} />;
}

export function FileIcon({ path }: { path: string }) {
  return <FileTypeIcon path={path} className="commit-icon commit-file-icon" />;
}
