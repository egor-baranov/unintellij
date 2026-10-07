import type { CSSProperties } from 'react';
import { iconUrls, type JetBrainsIconName } from './assetUrls';
import { iconNameForPath } from './fileTypes';
import './icons.css';

export type { JetBrainsIconName } from './assetUrls';
export { iconNameForPath } from './fileTypes';

interface IconProps { size?: number; className?: string; style?: CSSProperties }

/** Trusted, vendored SVGs only; never load artwork from repository contents or a CDN. */
export function JetBrainsIcon({ name, size = 16, className = '', style }: IconProps & { name: JetBrainsIconName }) {
  return <img className={`jb-icon ${className}`} data-icon={name} src={iconUrls[name]}
    width={size} height={size} style={{ '--jb-icon-size': `${size}px`, ...style } as CSSProperties} alt="" aria-hidden="true" draggable={false} />;
}

export function FileTypeIcon({ path, ...props }: IconProps & { path: string }) {
  return <JetBrainsIcon name={iconNameForPath(path)} {...props} />;
}
