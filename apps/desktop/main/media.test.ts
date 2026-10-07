import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ABSOLUTE_MAX_PREVIEW_BYTES, mediaContent, sniffMedia } from './media';
import { GitService } from './git';
import { BranchService } from './branches';
import type { ChangeGroup, RepositorySnapshot } from '../src/bridge';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ4kAAAAASUVORK5CYII=', 'base64');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#abcdef"/></svg>');
const wav = Buffer.alloc(44);
wav.write('RIFF'); wav.writeUInt32LE(36, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
function iso(brand: string): Buffer { const value = Buffer.alloc(20); value.writeUInt32BE(20); value.write('ftyp', 4); value.write(brand, 8); value.write(brand, 16); return value; }
function bitmap(): Buffer { const value = Buffer.alloc(54); value.write('BM'); value.writeUInt32LE(54, 10); value.writeUInt32LE(40, 14); value.writeInt32LE(20, 18); value.writeInt32LE(10, 22); return value; }
function webp(): Buffer { const value = Buffer.alloc(30); value.write('RIFF'); value.write('WEBPVP8X', 8); value.writeUIntLE(9, 24, 3); value.writeUIntLE(19, 27, 3); return value; }
function icon(): Buffer { const value = Buffer.alloc(22); value[2] = 1; value[4] = 1; value[6] = 16; value[7] = 16; return value; }
function jpeg(): Buffer { return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 10, 0, 20, 0]); }
function ogg(packet: string): Buffer { const value = Buffer.alloc(36); value.write('OggS'); value[26] = 1; value[27] = 8; value.write(packet, 28, 'binary'); return value; }

describe('bounded byte-based media classification', () => {
  it.each([
    [png, 'image', 'image/png'], [jpeg(), 'image', 'image/jpeg'],
    [Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), 'image', 'image/gif'],
    [webp(), 'image', 'image/webp'], [bitmap(), 'image', 'image/bmp'], [icon(), 'image', 'image/x-icon'],
    [iso('avif'), 'image', 'image/avif'], [svg, 'image', 'image/svg+xml'],
    [wav, 'audio', 'audio/wav'], [Buffer.from('ID3\x04\0\0\0\0\0\0', 'binary'), 'audio', 'audio/mpeg'],
    [Buffer.from([0xff, 0xfb, 0x90, 0]), 'audio', 'audio/mpeg'], [Buffer.from('fLaC\0\0\0\0', 'binary'), 'audio', 'audio/flac'],
    [ogg('OpusHead'), 'audio', 'audio/ogg'], [ogg('\x80theora\0'), 'video', 'video/ogg'],
    [iso('M4A '), 'audio', 'audio/mp4'], [iso('mp42'), 'video', 'video/mp4'],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]), 'video', 'video/webm'],
  ] as const)('recognizes supported signature case %#', (bytes, kind, mimeType) => {
    expect(sniffMedia(bytes)).toEqual({ format: { kind, mimeType } });
    expect(mediaContent(bytes, { kind, mimeType })).toEqual({ kind, mimeType, bytes: bytes.length, base64: bytes.toString('base64') });
  });

  it('does not turn text, unknown containers, or incomplete signatures into previews', () => {
    for (const value of [Buffer.alloc(0), Buffer.from('not a PNG'), Buffer.from('<html><img src="file:///secret"></html>'), Buffer.from('<root/>'), Buffer.from('GIF'), Buffer.from([137, 80, 78, 71]), Buffer.from([0xff, 0xfe, 0x61, 0]), iso('heic'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3])]) expect(sniffMedia(value)).toBeUndefined();
  });

  it('accepts static SVG shapes, gradients, local references and UTF-8 text', () => {
    const source = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- icon --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs><linearGradient id="fill"><stop offset="0" stop-color="#ffffff"/></linearGradient></defs><g transform="translate(1,2)"><path d="M0 0L10 10" fill="url(#fill)"/><text x="1" y="4">名</text></g></svg>';
    expect(sniffMedia(Buffer.from(source))).toEqual({ format: { kind: 'image', mimeType: 'image/svg+xml' } });
  });

  it('rejects active/external SVG, escaped references, foreign namespaces and malformed markup', () => {
    for (const content of ['<script>alert(1)</script>', '<foreignObject><iframe/></foreignObject>', '<style>@import "https://example.invalid/a";</style>', '<image href="https://example.invalid/a"/>', '<use href="https://example.invalid/a"/>', '<use href="&#104;ttps://example.invalid/a"/>', '<path onload="alert(1)"/>', '<animate attributeName="href"/>', '<path fill="url(https://example.invalid/a)"/>', '<path fill="u\\72l(https://example.invalid/a)"/>', '<g xmlns="http://www.w3.org/1999/xhtml"/>', '<path style="fill:red"/>', '<g><path/></svg>', '<path id="a"id="b"/>']) {
      expect(sniffMedia(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`))).toHaveProperty('unsupported');
    }
    expect(sniffMedia(Buffer.from('<!DOCTYPE svg [<!ENTITY ext SYSTEM "file:///secret">]><svg>&ext;</svg>'))).toHaveProperty('unsupported');
    expect(sniffMedia(Buffer.from('<svg>'+ '<g>'.repeat(130) + '</g>'.repeat(130) + '</svg>'))).toHaveProperty('unsupported');
  });

  it('rejects oversized advertised raster dimensions without decoding pixels', () => {
    const hugePng = Buffer.from(png); hugePng.writeUInt32BE(100_000, 16);
    const hugeGif = Buffer.from('GIF89a' + '\0'.repeat(8), 'binary'); hugeGif.writeUInt16LE(9000, 6); hugeGif.writeUInt16LE(9000, 8);
    const hugeBmp = bitmap(); hugeBmp.writeInt32LE(100_000, 18);
    const hugeWebp = webp(); hugeWebp.writeUIntLE(100_000, 24, 3);
    const hugeJpeg = jpeg(); hugeJpeg.writeUInt16BE(9000, 7); hugeJpeg.writeUInt16BE(9000, 9);
    const hugeIcon = Buffer.concat([icon(), hugePng]); hugeIcon.writeUInt32LE(22, 18);
    for (const value of [hugePng, hugeGif, hugeBmp, hugeWebp, hugeJpeg, hugeIcon]) expect(sniffMedia(value)).toHaveProperty('unsupported');
  });
});

const exec = promisify(execFile);
const roots: string[] = [];
const git = async (root: string, ...args: string[]) => (await exec('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout;
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'smart-diff-media-')); roots.push(root);
  await git(root, 'init', '-b', 'main'); await git(root, 'config', 'user.email', 'test@example.invalid'); await git(root, 'config', 'user.name', 'Test');
  return root;
}
const find = (snapshot: RepositorySnapshot, filePath: string, group: ChangeGroup) => {
  const result = snapshot.changes.find(item => item.path === filePath && item.group === group);
  if (!result) throw new Error(`Missing ${group} ${filePath}`);
  return result.id;
};
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('media endpoints in real Git repositories', () => {
  it('loads staged/unstaged images independently, untracked audio, project media and immutable branch media', async () => {
    const root = await repository();
    const name = 'image 名\t\n.dat';
    await writeFile(path.join(root, name), png); await git(root, 'add', '--', name); await git(root, 'commit', '-m', 'Base image'); await git(root, 'branch', 'before');
    await writeFile(path.join(root, name), svg); await git(root, 'add', '--', name);
    const working = Buffer.from(svg.toString().replace('#abcdef', '#123456')); await writeFile(path.join(root, name), working);
    await writeFile(path.join(root, 'audio.bin'), wav);
    const service = new GitService(); const snapshot = await service.registerRepository(root); const id = snapshot.repository.id;
    const staged = await service.readComparison(id, find(snapshot, name, 'staged'));
    expect(staged).toMatchObject({ state: 'media', changeType: 'modified', originalMedia: { label: 'HEAD', mimeType: 'image/png', base64: png.toString('base64') }, modifiedMedia: { label: 'Index', mimeType: 'image/svg+xml', base64: svg.toString('base64') } });
    expect(staged.original).toBeUndefined(); expect(staged.modified).toBeUndefined();
    expect(await service.readComparison(id, find(snapshot, name, 'unstaged'))).toMatchObject({ state: 'media', originalMedia: { base64: svg.toString('base64') }, modifiedMedia: { base64: working.toString('base64') } });
    const added = await service.readComparison(id, find(snapshot, 'audio.bin', 'untracked'));
    expect(added).toMatchObject({ state: 'media', changeType: 'added', originalLabel: 'Empty', modifiedMedia: { kind: 'audio', label: 'Working tree' } }); expect(added.originalMedia).toBeUndefined();
    const files = await service.listProjectDirectory(id, null);
    expect(await service.readProjectFile(id, files.entries.find(entry => entry.path === name)!.id)).toMatchObject({ state: 'media', media: { kind: 'image', label: 'Working tree', base64: working.toString('base64') } });
    await git(root, 'commit', '-m', 'Staged SVG');
    const branches = new BranchService(service); const comparison = await branches.compareBranches(id, 'refs/heads/before', 'head');
    const branchImage = comparison.changes.find(entry => entry.path === name)!;
    expect(await branches.readBranchComparison(id, comparison.id, branchImage.id)).toMatchObject({ state: 'media', originalMedia: { base64: png.toString('base64') }, modifiedMedia: { base64: svg.toString('base64') } });
    await writeFile(path.join(root, name), 'subsequent text');
    expect(await branches.readBranchComparison(id, comparison.id, branchImage.id)).toMatchObject({ state: 'media', modifiedMedia: { base64: svg.toString('base64') } });
    expect((await service.readComparison(id, find(snapshot, name, 'unstaged'))).state).toBe('stale');
  });

  it('preserves absent sides for staged additions/deletions and rejects incompatible existing endpoints', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'old.png'), svg); await writeFile(path.join(root, 'empty'), ''); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Base');
    await rm(path.join(root, 'old.png')); await writeFile(path.join(root, 'new.png'), png); await writeFile(path.join(root, 'empty'), png); await git(root, 'add', '-A');
    const service = new GitService(); const snapshot = await service.registerRepository(root); const id = snapshot.repository.id;
    const removed = await service.readComparison(id, find(snapshot, 'old.png', 'staged'));
    expect(removed).toMatchObject({ state: 'media', changeType: 'deleted', originalMedia: { kind: 'image' }, modifiedLabel: 'Index' }); expect(removed.modifiedMedia).toBeUndefined();
    const added = await service.readComparison(id, find(snapshot, 'new.png', 'staged'));
    expect(added).toMatchObject({ state: 'media', changeType: 'added', modifiedMedia: { kind: 'image' } }); expect(added.originalMedia).toBeUndefined();
    expect(await service.readComparison(id, find(snapshot, 'empty', 'staged'))).toMatchObject({ state: 'type-change', message: expect.stringContaining('incompatible') });
    await writeFile(path.join(root, 'new.png'), wav);
    const refreshed = await service.refreshRepository(id);
    expect((await service.readComparison(id, find(refreshed, 'new.png', 'unstaged'))).state).toBe('type-change');
  });

  it('enforces independent byte limits and refuses unsafe SVG, unknown binary and symlink previews', async () => {
    const root = await repository();
    await writeFile(path.join(root, 'image.txt'), png); await writeFile(path.join(root, 'fake.png'), 'ordinary text');
    await writeFile(path.join(root, 'big.txt'), 'x'.repeat(80));
    await writeFile(path.join(root, 'unsafe.svg'), '<svg><script>fetch("file:///secret")</script></svg>');
    await writeFile(path.join(root, 'unknown.png'), Buffer.from([0, 1, 2, 3]));
    await symlink(path.join(root, 'image.txt'), path.join(root, 'link.png'));
    const service = new GitService({ maxFileBytes: 16, maxPreviewBytes: 1024 }); const snapshot = await service.registerRepository(root); const id = snapshot.repository.id;
    expect((await service.readComparison(id, find(snapshot, 'image.txt', 'untracked'))).state).toBe('media');
    expect((await service.readComparison(id, find(snapshot, 'fake.png', 'untracked'))).state).toBe('text');
    expect(await service.readComparison(id, find(snapshot, 'big.txt', 'untracked'))).toMatchObject({ state: 'oversized', message: expect.stringContaining('text limit is 16') });
    expect(await service.readComparison(id, find(snapshot, 'unsafe.svg', 'untracked'))).toMatchObject({ state: 'binary', message: expect.stringContaining('SVG') });
    expect((await service.readComparison(id, find(snapshot, 'unknown.png', 'untracked'))).state).toBe('binary');
    expect((await service.readComparison(id, find(snapshot, 'link.png', 'untracked'))).state).toBe('symlink');
    const limited = new GitService({ maxPreviewBytes: 32 }); const limitedSnapshot = await limited.registerRepository(root);
    expect(await limited.readComparison(limitedSnapshot.repository.id, find(limitedSnapshot, 'image.txt', 'untracked'))).toMatchObject({ state: 'oversized', message: expect.stringContaining('media preview limit is 32') });
    expect(await readFile(path.join(root, 'image.txt'))).toEqual(png);
    expect(() => new GitService({ maxPreviewBytes: ABSOLUTE_MAX_PREVIEW_BYTES + 1 })).toThrow('maxPreviewBytes');
  });
});
