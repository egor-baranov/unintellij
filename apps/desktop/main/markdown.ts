import path from 'node:path';

export const MAX_MARKDOWN_IMAGE_BYTES = 8 * 1024 * 1024;

/** Resolve a document reference inside its project; never accept OS paths or URL schemes. */
export function markdownProjectPath(sourcePath: string, href: unknown): string {
  if (typeof href !== 'string' || !href || href.length > 8192 || /[\u0000-\u001f\u007f\\]/.test(href)) throw new Error('Invalid Markdown resource path.');
  let reference: string;
  try { reference = decodeURIComponent(href.split(/[?#]/, 1)[0]); }
  catch { throw new Error('Invalid Markdown resource encoding.'); }
  if (!reference || /[\u0000-\u001f\u007f\\]/.test(reference) || reference.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(reference)) throw new Error('Markdown resources must use project-relative paths.');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), reference));
  if (resolved === '.' || resolved === '..' || resolved.startsWith('../') || resolved.split('/').some(part => part.toLowerCase() === '.git')) throw new Error('Markdown resources must stay inside the selected project.');
  return resolved;
}

/** An explicit preview link click may open only normal web or email URLs. */
export function markdownExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Invalid Markdown link.');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Invalid Markdown link.'); }
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) throw new Error('Only web and email links can be opened from Markdown previews.');
  return url.href;
}
