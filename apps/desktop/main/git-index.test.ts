import { describe, expect, it } from 'vitest';
import { GitIndexReader } from './git-index';
import { runGit } from './git';

const entry = (name: string, mode = '100644', stage = 0, oid = 'a'.repeat(40)) => Buffer.from(`${mode} ${oid} ${stage}\t${name}\0`);

describe('streamed Git index', () => {
  it('handles every chunk boundary, including UTF-8, tabs, newlines, and conflict stages', () => {
    const validated: string[] = [];
    const reader = new GitIndexReader(filePath => { validated.push(filePath); });
    const name = 'src/名 café\tline\n.ts';
    const data = Buffer.concat([entry(name, '100644', 1), entry(name, '100644', 2), entry(name, '100755', 3), entry('linked-repo', '160000'), entry('last.ts', '100644', 0, 'b'.repeat(64))]);
    for (const byte of data) reader.write(Buffer.from([byte]));
    const result = reader.finish();
    expect([...result.tracked]).toEqual([name, 'linked-repo', 'last.ts']);
    expect([...result.submodules]).toEqual(['linked-repo']);
    expect(validated).toEqual([name, name, name, 'linked-repo', 'last.ts']);
  });

  it('handles empty indexes and many complete records in a chunk', () => {
    expect(new GitIndexReader(() => {}).finish().tracked.size).toBe(0);
    const reader = new GitIndexReader(() => {});
    reader.write(Buffer.concat([entry('first.ts'), entry('second.ts'), entry('last.ts')]));
    expect([...reader.finish().tracked]).toEqual(['first.ts', 'second.ts', 'last.ts']);
  });

  it('rejects incomplete records, invalid UTF-8 and malformed metadata instead of publishing partial indexes', () => {
    const incomplete = new GitIndexReader(() => {});
    incomplete.write(entry('truncated.ts').subarray(0, -1));
    expect(() => incomplete.finish()).toThrow('Incomplete Git index entry');
    const invalidUtf8 = Buffer.concat([entry('valid.ts').subarray(0, -1), Buffer.from([0xff, 0])]);
    expect(() => new GitIndexReader(() => {}).write(invalidUtf8)).toThrow();
    for (const data of [Buffer.from('invalid\0'), entry('bad-stage.ts', '100644', 4), entry('', '100644')]) {
      expect(() => new GitIndexReader(() => {}).write(data)).toThrow('Malformed Git index entry');
    }
  });

  it('bounds an individual record even when it arrives in small chunks', () => {
    const reader = new GitIndexReader(() => {});
    for (let i = 0; i < 64; i++) reader.write(Buffer.alloc(1024, 65));
    expect(() => reader.write(Buffer.from('a'))).toThrow('filename safety limit');
  });

  it('validates paths before adding them to the snapshot', () => {
    const reader = new GitIndexReader(filePath => { if (filePath.startsWith('../')) throw new Error('Outside the repository'); });
    expect(() => reader.write(entry('../outside.ts'))).toThrow('Outside the repository');
    expect(reader.finish().tracked.size).toBe(0);
  });

  it('consumes stdout without also returning a buffered copy', async () => {
    let output = '';
    const result = await runGit(process.cwd(), ['version'], 1024, { versionCheck: true, onStdout: data => { output += data.toString('utf8'); } });
    expect(output).toMatch(/^git version /);
    expect(result.length).toBe(0);
  });

  it('rejects consumer failures and retains the output budget for streamed commands', async () => {
    await expect(runGit(process.cwd(), ['version'], 1024, { versionCheck: true, onStdout: () => { throw new Error('Invalid index'); } })).rejects.toThrow('Invalid index');
    let consumed = false;
    await expect(runGit(process.cwd(), ['version'], 1, { versionCheck: true, onStdout: () => { consumed = true; } })).rejects.toThrow('Git output exceeds the safety limit');
    expect(consumed).toBe(false);
  });
});
