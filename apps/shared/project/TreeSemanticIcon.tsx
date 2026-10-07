import { FileTypeIcon } from '../icons';
import type { TreePresentation } from './presentation';
import type { TreeTheme } from './theme';

/** Small local SVG variants, sharing the existing licensed folder silhouette. */
export function TreeSemanticIcon({ path, presentation, theme }: { path: string; presentation: TreePresentation; theme: TreeTheme }) {
  const { icon, overlays } = presentation;
  const source = icon === 'sources' || icon === 'resources';
  const test = icon === 'test-sources' || icon === 'test-resources';
  const warm = icon === 'library' || icon === 'excluded';
  const stroke = warm ? theme.warmFolderStroke : source ? theme.sourceStroke : test ? theme.testStroke : theme.folderStroke;
  const fill = warm ? theme.warmFolderFill : source ? theme.sourceFill : test ? theme.testFill : theme.folderFill;
  return <span className="project-icon project-semantic-icon" data-icon={icon} aria-hidden="true" style={{ position: 'relative', display: 'inline-flex' }}>
    {icon === 'file' ? <FileTypeIcon path={path} /> : <svg viewBox="0 0 16 16" width="16" height="16" fill="none">
      {/* Folder geometry derived from the bundled JetBrains Apache-2.0 folder asset. */}
      <path d="M8.106 4.346 8.253 4.5H13A1.5 1.5 0 0 1 14.5 6v6.133c0 .82-.568 1.367-1.133 1.367H2.633c-.565 0-1.133-.547-1.133-1.367V3.867c0-.82.568-1.367 1.133-1.367h3.489c.136 0 .266.056.36.154Z" fill={fill} stroke={stroke} />
      {icon === 'content' && <rect x="10" y="9.5" width="5.2" height="5.2" rx="1" fill={theme.background} stroke={theme.rootMarker} />}
      {(icon === 'resources' || icon === 'test-resources') && <path d="m8.8 7.2 1.1 2.1 2.3.3-1.7 1.6.4 2.3-2.1-1.1-2.1 1.1.4-2.3-1.7-1.6 2.3-.3Z" stroke={stroke} strokeWidth=".8" fill={fill} />}
      {icon === 'library' && <path d="M8.5 7v4.5m2-4.5v4.5m2-4.5v4.5M8 12.5h5" stroke={stroke} />}
      {icon === 'excluded' && <path d="m9 8 3.5 3.5m0-3.5L9 11.5" stroke={stroke} />}
      {icon === 'repository' && <path d="M8 7v5m0-3h3V7" stroke={theme.rootMarker} strokeWidth="1.2" />}
      {icon === 'unavailable' && <path d="M8 6.5v3.5m0 1.5v1" stroke={theme.unavailable} />}
    </svg>}
    {!!overlays.length && <svg viewBox="0 0 16 16" width="16" height="16" style={{ position: 'absolute', inset: 0 }}>
      {overlays.includes('generated') && <g><circle cx="3" cy="12" r="2.7" fill={theme.background} /><path d="m3 9.7-1.2 2.6h1.5l-.5 2 1.8-3H3.2l.6-1.6Z" fill={theme.annotation} /></g>}
      {(overlays.includes('link') || overlays.includes('broken-link')) && <g fill="none" stroke={overlays.includes('broken-link') ? theme.diagnosticError : theme.folderStroke} strokeWidth="1.1"><path d="M11.5 11H10a2 2 0 0 0 0 4h1.5m1-4H14a2 2 0 0 1 0 4h-1.5m-2-2h3" /></g>}
      {overlays.includes('repository') && <rect x="10" y="10" width="5" height="5" rx="1" fill={theme.background} stroke={theme.rootMarker} />}
    </svg>}
  </span>;
}
