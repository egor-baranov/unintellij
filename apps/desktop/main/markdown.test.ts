import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitService } from './git';
import { markdownExternalUrl, markdownProjectPath, MAX_MARKDOWN_IMAGE_BYTES } from './markdown';

const roots: string[] = [];
const services: GitService[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-markdown-'));
  roots.push(root);
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'README.md'), '# Project\n');
  const service = new GitService();
  services.push(service);
  const { repository } = await service.registerRepository(root);
  const top = await service.listProjectDirectory(repository.id, null);
  const docs = await service.listProjectDirectory(repository.id, top.entries.find(entry => entry.name === 'docs')!.id);
  return { service, root, id: repository.id, sourceId: docs.entries[0].id };
}

afterEach(async () => {
  services.splice(0).forEach(service => service.dispose());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Markdown resource references', () => {
  it('resolves document-relative URLs while preserving encoded filename characters', () => {
    expect(markdownProjectPath('docs/README.md', '../images/my%20image%23one.png?v=2#image')).toBe('images/my image#one.png');
    expect(markdownProjectPath('README.md', './docs/../guide.md#intro')).toBe('guide.md');
  });

  it.each(['../../outside.png', '../.git/config', '../%2egit/config', '/etc/passwd', '//host/file', 'file:///secret', 'https://host/file', 'data:image/png;base64,x', 'C:/secret', '..\\secret', '..%5csecret', '%00image.png', '%0Aimage.png', '%ff', '#heading', ''])('rejects unsafe reference %j', reference => {
    expect(() => markdownProjectPath('docs/README.md', reference)).toThrow();
  });

  it('opens only explicit HTTP(S) and email links', () => {
    expect(markdownExternalUrl('https://example.test/guide#intro')).toBe('https://example.test/guide#intro');
    expect(markdownExternalUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(markdownExternalUrl('mailto:author@example.test?subject=Hi')).toBe('mailto:author@example.test?subject=Hi');
    for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'vscode://open', '//example.test', 'https://user:password@example.test', ' https://example.test', 'https://example.test\n']) expect(() => markdownExternalUrl(value)).toThrow();
  });
});

describe('project Markdown preview resources', () => {
  it('reads actual image bytes and issues ordinary capabilities for linked files', async () => {
    const { service, root, id, sourceId } = await project();
    await mkdir(path.join(root, 'images'));
    await writeFile(path.join(root, 'images', 'sample image.bin'), png);
    await writeFile(path.join(root, 'guide #1.md'), '# Linked guide\n');
    const image = await service.readMarkdownImage(id, sourceId, '../images/sample%20image.bin?v=1');
    expect(image).toEqual({ mimeType: 'image/png', base64: png.toString('base64'), bytes: png.length });
    const target = await service.resolveMarkdownLink(id, sourceId, '../guide%20%231.md#linked-guide');
    expect(target).toMatchObject({ name: 'guide #1.md', path: 'guide #1.md', kind: 'file' });
    expect((await service.resolveMarkdownLink(id, sourceId, '../guide%20%231.md')).id).toBe(target.id);
    expect((await service.readProjectFile(id, target.id)).content?.text).toBe('# Linked guide\n');
  });

  it('allows static SVG images but rejects HTML, active SVG, audio, huge images and oversized resources', async () => {
    const { service, root, id, sourceId } = await project();
    const staticSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>';
    await writeFile(path.join(root, 'safe.svg'), staticSvg);
    expect((await service.readMarkdownImage(id, sourceId, '../safe.svg')).mimeType).toBe('image/svg+xml');
    const huge = Buffer.from(png);
    huge.writeUInt32BE(40000, 16);
    const invalid: Record<string, Buffer | string> = {
      'page.png': '<html><script>alert(1)</script></html>',
      'script.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'external.svg': '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.test/tracker"/></svg>',
      'audio.png': 'fLaC\u0000\u0000\u0000\u0000',
      'huge.png': huge,
      'oversized.png': Buffer.alloc(MAX_MARKDOWN_IMAGE_BYTES + 1),
    };
    for (const [name, content] of Object.entries(invalid)) {
      await writeFile(path.join(root, name), content);
      await expect(service.readMarkdownImage(id, sourceId, `../${name}`)).rejects.toThrow();
    }
  });

  it('requires a current capability from the same project and revalidates both source and target paths', async () => {
    const { service, root, id, sourceId } = await project();
    await writeFile(path.join(root, 'sample.png'), png);
    const foreign = await project();
    for (const source of ['docs/README.md', foreign.sourceId]) {
      await expect(service.readMarkdownImage(id, source, '../sample.png')).rejects.toThrow('Unknown project entry');
    }
    await expect(service.resolveMarkdownLink(id, sourceId, '../missing.md')).rejects.toThrow();
    await expect(service.resolveMarkdownLink(id, sourceId, '../docs')).rejects.toThrow();
    await symlink(path.join(root, 'sample.png'), path.join(root, 'linked.png'));
    await symlink(root, path.join(root, 'linked-dir'));
    for (const reference of ['../linked.png', '../linked-dir/sample.png']) {
      await expect(service.readMarkdownImage(id, sourceId, reference)).rejects.toThrow();
      await expect(service.resolveMarkdownLink(id, sourceId, reference)).rejects.toThrow();
    }
    await rm(path.join(root, 'docs', 'README.md'));
    await symlink(path.join(root, 'sample.png'), path.join(root, 'docs', 'README.md'));
    await expect(service.readMarkdownImage(id, sourceId, '../sample.png')).rejects.toThrow('source file is no longer available');
  });

  it('rejects metadata and nested repository resources even when their image content is valid', async () => {
    const { service, root, id, sourceId } = await project();
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'private.png'), png);
    await mkdir(path.join(root, 'nested', '.git'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'sample.png'), png);
    for (const reference of ['../.git/private.png', '../nested/sample.png']) {
      await expect(service.readMarkdownImage(id, sourceId, reference)).rejects.toThrow();
      await expect(service.resolveMarkdownLink(id, sourceId, reference)).rejects.toThrow();
    }
  });
});
