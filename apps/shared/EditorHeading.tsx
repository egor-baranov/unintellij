import { FileIcon } from './commit/icons';

/** A single open-file title, with its containing path as a breadcrumb. */
export function EditorHeading({ path, comparison = false, suffix }: { path: string; comparison?: boolean; suffix?: string }) {
  const parts = path.split('/');
  const name = parts.pop();
  return <div className="editor-heading">
    <div className="editor-file-title" title={path}><FileIcon path={path} /><span>{comparison ? 'Commit: ' : ''}{name}</span></div>
    <span className="editor-breadcrumb" title={parts.join('/')}>{parts.join(' / ')}</span>
    {suffix && <span className="editor-heading-suffix" title={suffix}>{suffix}</span>}
  </div>;
}
