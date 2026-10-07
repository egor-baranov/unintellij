import { decodeHTMLStrict } from 'entities/decode';
import { Marked, Renderer, type Token, type Tokens } from 'marked';

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext)$/i.test(path);
}

/**
 * Keep resource addresses inert until the host resolves them against the open
 * project. Decoding character references before validation also catches encoded
 * protocols such as `javascript&#58;...` without changing percent-encoded paths.
 */
function resourceAddress(value: string, image: boolean, literal = false): string | undefined {
  const address = (literal ? value : decodeHTMLStrict(value)).trim();
  if (!address || /[\u0000-\u001f\u007f\\]/.test(address) || address.startsWith('//')) return;
  const protocol = /^([a-z][a-z\d+.-]*):/i.exec(address)?.[1].toLowerCase();
  if (protocol && !['https', 'http', ...(image ? [] : ['mailto'])].includes(protocol)) return;
  // A colon in the first path component is not a project-relative resource.
  if (!protocol && /^[^/?#]*:/.test(address)) return;
  return address;
}

function plainText(tokens: readonly Token[]): string {
  return tokens.map(token => {
    if ('tokens' in token && token.tokens) return plainText(token.tokens as Token[]);
    if (token.type === 'br') return ' ';
    return 'text' in token && typeof token.text === 'string' ? token.text : '';
  }).join('');
}

class MarkdownRenderer extends Renderer {
  private readonly anchors = new Set<string>();

  constructor(private readonly sourceLines: WeakMap<Token, number>) { super(); }

  private atSource(html: string, token: Token): string {
    const line = this.sourceLines.get(token);
    return line ? html.replace(/^(<[a-z][a-z\d]*)/i, `$1 data-source-line="${line}"`) : html;
  }

  override heading(token: Tokens.Heading): string {
    const base = decodeHTMLStrict(plainText(token.tokens)).toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s+/g, '-') || 'section';
    let anchor = base;
    for (let suffix = 1; this.anchors.has(anchor); suffix++) anchor = `${base}-${suffix}`;
    this.anchors.add(anchor);
    return this.atSource(`<h${token.depth} id="${escapeHtml(anchor)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`, token);
  }

  override code(token: Tokens.Code): string {
    const language = /^[a-z\d_+-]{1,40}$/i.test(token.lang?.split(/\s/, 1)[0] ?? '')
      ? token.lang!.split(/\s/, 1)[0].toLowerCase() : '';
    return this.atSource(`<pre><code${language ? ` data-markdown-language="${language}"` : ''}>${escapeHtml(token.text)}\n</code></pre>\n`, token);
  }

  override html(token: Tokens.HTML | Tokens.Tag): string {
    // Raw HTML is code in this preview, never a second route around the URL and
    // resource handlers. This also excludes scripts, forms, SVG and CSS loads.
    const escaped = escapeHtml(token.text);
    return token.block ? this.atSource(`<pre class="markdown-raw-html">${escaped}</pre>\n`, token) : escaped;
  }

  override link(token: Tokens.Link): string {
    const contents = token.autolink ? escapeHtml(token.text) : this.parser.parseInline(token.tokens);
    const address = resourceAddress(token.href, false, token.autolink);
    if (!address) return contents;
    return `<a role="link" tabindex="0" data-markdown-href="${escapeHtml(address)}"${token.title ? ` title="${escapeHtml(decodeHTMLStrict(token.title))}"` : ''}>${contents}</a>`;
  }

  override image(token: Tokens.Image): string {
    const alt = decodeHTMLStrict(plainText(token.tokens));
    const address = resourceAddress(token.href, true);
    if (!address) return escapeHtml(alt);
    return `<img data-markdown-src="${escapeHtml(address)}" alt="${escapeHtml(alt)}"${token.title ? ` title="${escapeHtml(decodeHTMLStrict(token.title))}"` : ''} loading="lazy" decoding="async">`;
  }

  override paragraph(token: Tokens.Paragraph): string { return this.atSource(super.paragraph(token), token); }
  override blockquote(token: Tokens.Blockquote): string { return this.atSource(super.blockquote(token), token); }
  override list(token: Tokens.List): string { return this.atSource(super.list(token), token); }
  override table(token: Tokens.Table): string { return this.atSource(super.table(token), token); }
  override hr(token: Tokens.Hr): string { return this.atSource(super.hr(token), token); }
}

/**
 * Render GFM with a closed set of generated elements. No input HTML, executable
 * attributes, navigable links or automatically fetched images survive rendering.
 * Top-level blocks retain their one-based source line for editor/preview sync.
 */
export function renderMarkdown(text: string): string {
  const source = text.replace(/\r\n?/g, '\n');
  const sourceLines = new WeakMap<Token, number>();
  const parser = new Marked({ gfm: true, breaks: false });
  parser.setOptions({ renderer: new MarkdownRenderer(sourceLines) });
  const tokens = parser.lexer(source);
  let offset = 0;
  let line = 1;
  for (const token of tokens) {
    // Lexer raw values retain source whitespace, including reference definitions
    // and blank lines; locating from the prior end also handles repeated blocks.
    const start = source.indexOf(token.raw, offset);
    if (start < 0) continue;
    line += source.slice(offset, start).split('\n').length - 1;
    sourceLines.set(token, line);
    line += token.raw.split('\n').length - 1;
    offset = start + token.raw.length;
  }
  return parser.parser(tokens);
}
