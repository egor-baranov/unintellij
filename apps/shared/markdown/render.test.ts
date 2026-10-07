import { describe, expect, it } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { isMarkdownPath, renderMarkdown } from './render';

describe('Markdown preview rendering', () => {
  it('renders headings, emphasis, lists, task lists, tables, quotes and fenced code', () => {
    const html = renderMarkdown([
      '# **Review** notes', '', '*Italic* and ~~obsolete~~ with `inline()`.', '',
      '> A quoted paragraph.', '', '- [x] Complete', '- [ ] Pending', '',
      '| Name | Value |', '| :--- | ---: |', '| **first** | 12 |', '',
      '```TypeScript title="demo"', 'const value = "<safe>";', '```',
    ].join('\n'));
    expect(html).toContain('<h1 data-source-line="1" id="review-notes"><strong>Review</strong> notes</h1>');
    expect(html).toContain('<em>Italic</em> and <del>obsolete</del> with <code>inline()</code>');
    expect(html).toContain('<blockquote data-source-line="5">');
    expect(html).toContain('<input checked="" disabled="" type="checkbox">');
    expect(html).toContain('<input disabled="" type="checkbox">');
    expect(html).toContain('<table data-source-line="10">');
    expect(html).toContain('<th align="right">Value</th>');
    expect(html).toContain('<pre data-source-line="14"><code data-markdown-language="typescript">const value = &quot;&lt;safe&gt;&quot;;\n</code></pre>');
  });

  it('gives repeated and nested headings unique deterministic anchors without leaking state', () => {
    const markdown = '# Same\n\n## Same\n\n# Same-1\n\n> ## Same\n\n# Crème &amp; café\n';
    const html = renderMarkdown(markdown);
    expect([...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]))
      .toEqual(['same', 'same-1', 'same-1-1', 'same-2', 'crème-café']);
    expect(renderMarkdown(markdown)).toEqual(html);
  });

  it('keeps exact source lines across CRLFs, repeated paragraphs, definitions and blank lines', () => {
    const html = renderMarkdown('[link]: ./guide.md\r\n\r\n# Heading\r\n\r\nRepeat\r\n\r\nRepeat\r\n\r\n[guide][link]\r\n');
    expect(html).toContain('<h1 data-source-line="3"');
    expect(html).toContain('<p data-source-line="5">Repeat</p>');
    expect(html).toContain('<p data-source-line="7">Repeat</p>');
    expect(html).toContain('<p data-source-line="9"><a role="link"');
  });

  it('keeps links and images inert for the project resource handler', () => {
    const html = renderMarkdown('[Guide](../guide.md#setup) [Section](#section) [Site](https://example.com?a=1&amp;b=2) [Email](mailto:hello@example.com)\n\n![Diagram *one*](./images/diagram.png "Diagram")');
    expect(html).toContain('data-markdown-href="../guide.md#setup"');
    expect(html).toContain('data-markdown-href="#section"');
    expect(html).toContain('data-markdown-href="https://example.com?a=1&amp;b=2"');
    expect(html).toContain('data-markdown-href="mailto:hello@example.com"');
    expect(html).toContain('data-markdown-src="./images/diagram.png" alt="Diagram one" title="Diagram"');
    expect(html).not.toMatch(/\s(?:href|src|srcset)=/);
  });

  it.each([
    'javascript:alert%281%29', 'JaVaScRiPt:alert%281%29', 'javascript&#58;alert%281%29',
    '&#106;avascript:alert%281%29', 'java&#x09;script:alert%281%29', 'vbscript:msgbox%281%29',
    'data:text/html;base64,PHNjcmlwdD4=', 'file:///etc/passwd', 'command:workbench.action', '//example.com/private.png',
  ])('does not expose unsafe link/image destination %s', address => {
    const html = renderMarkdown(`[Label](${address}) ![Image](${address})`);
    expect(html).not.toContain('data-markdown-href');
    expect(html).not.toContain('data-markdown-src');
    expect(html).toContain('Label');
    expect(html).toContain('Image');
  });

  it('escapes raw HTML and attribute injection instead of mounting active elements', () => {
    const html = renderMarkdown([
      '<script>alert(1)</script>', '', '<img src="http://tracker.invalid" onerror="alert(1)">', '',
      '<style>body { background: url(https://tracker.invalid) }</style>', '',
      '<form><input autofocus onfocus="alert(1)"></form>', '',
      '<svg><a href="javascript:alert(1)">bad</a></svg>', '',
      '[<img src=x onerror=alert(1)>](./guide.md "&quot; onmouseover=&quot;alert(1)")', '',
      '![&quot; onerror=&quot;alert(1)](./image.png)', '',
      '```x" onmouseover="alert(1)', '<iframe srcdoc="bad">', '```',
    ].join('\n'));
    expect(html).not.toMatch(/<(?:script|style|form|svg|iframe)\b/);
    const document = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    for (const element of Array.from(document.getElementsByTagName('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name).not.toMatch(/^(?:on\w+|src|srcdoc|href)$/);
      }
    }
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('title="&quot; onmouseover=&quot;alert(1)"');
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"');
    expect(html).not.toContain('data-markdown-language');
  });

  it('does not decode an autolink destination as an HTML attribute', () => {
    const html = renderMarkdown('<https://example.com?a=&copy;>');
    expect(html).toContain('data-markdown-href="https://example.com?a=&amp;copy;"');
  });

  it('recognizes Markdown filenames without treating code or directory names as Markdown', () => {
    expect(['README.md', 'docs/Notes.MARKDOWN', 'notes.mdown', 'C:\\docs\\guide.mkd'].every(isMarkdownPath)).toBe(true);
    expect(['docs.md/file.ts', 'guide.md.png', 'Readme', 'component.mdx'].some(isMarkdownPath)).toBe(false);
  });
});
