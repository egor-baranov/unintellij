import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as git from './git';
import { cloneProjectDirectory, createProjectDirectory, projectDisplayPath, validateCloneUrl } from './project-opening';

const roots: string[] = [];
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), 'smart-diff-project-opening-'))); roots.push(root); return root; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('project opening actions', () => {
  it('abbreviates only paths inside the actual home directory', () => {
    expect(projectDisplayPath('/Users/person/Projects/demo', '/Users/person')).toBe('~/Projects/demo');
    expect(projectDisplayPath('/Users/person', '/Users/person')).toBe('~');
    expect(projectDisplayPath('/Users/person-other/demo', '/Users/person')).toBe('/Users/person-other/demo');
    expect(projectDisplayPath('/Users/other/demo', '/Users/person')).toBe('/Users/other/demo');
  });

  it('accepts common remote forms and derives the destination suggestion', () => {
    for (const url of ['https://example.com/team/demo.git', 'ssh://git@example.com:22/team/demo.git', 'git@example.com:team/demo.git', 'git://example.com/team/demo']) {
      expect(validateCloneUrl(url)).toEqual({ url, name: 'demo' });
    }
    expect(validateCloneUrl('  https://example.com/demo.git  ').url).toBe('https://example.com/demo.git');
  });

  it('rejects custom transports, local paths, passwords and option-like or malformed URLs', () => {
    for (const url of ['', '--upload-pack=evil', 'ext::sh -c command', 'file:///tmp/repo', '/tmp/repo', 'http://example.com/demo.git', 'ssh://-host/demo', '-host:demo', 'https://user:secret@example.com/demo', 'https://example.com/demo?command=x', 'https://example.com/demo#branch', 'https://example.com', 'git@example.com:../..', 'git@example.com:path\nrepo', null]) {
      expect(() => validateCloneUrl(url), String(url)).toThrow();
    }
  });

  it('creates a new directory while preserving existing folders, files and symlinks', async () => {
    const root = await directory();
    const target = await createProjectDirectory(join(root, 'new project'));
    expect(await readdir(target)).toEqual([]);
    await expect(createProjectDirectory(target)).rejects.toThrow('already exists');
    const file = join(root, 'existing.txt');
    await writeFile(file, 'keep');
    await expect(createProjectDirectory(file)).rejects.toThrow('already exists');
    const link = join(root, 'linked');
    await symlink(target, link, 'dir');
    await expect(createProjectDirectory(link)).rejects.toThrow('already exists');
    expect(await readFile(file, 'utf8')).toBe('keep');
  });

  it('runs a clone as bounded arguments with isolated configuration and no hooks or submodules', async () => {
    const root = await directory();
    const destination = join(root, 'clone with spaces');
    const controller = new AbortController();
    const run = vi.spyOn(git, 'runGit').mockImplementation(async (cwd, args, _bytes, options) => {
      expect(cwd).toBe(root);
      expect(args.slice(-3)).toEqual(['--', 'git@example.com:team/demo.git', destination]);
      expect(args).toContain('--no-recurse-submodules');
      expect(args).toContain('protocol.allow=never');
      expect(args).toContain('credential.helper=');
      expect(args.some(value => value.startsWith('core.hooksPath='))).toBe(true);
      expect(options?.env?.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(await readFile(options!.env!.GIT_CONFIG_GLOBAL!, 'utf8')).toBe('');
      expect(options?.signal).toBe(controller.signal);
      expect(options?.timeoutMs).toBe(600_000);
      expect(await readdir(destination)).toEqual([]);
      return Buffer.alloc(0);
    });
    expect(await cloneProjectDirectory('git@example.com:team/demo.git', destination, controller.signal)).toBe(destination);
    expect(run).toHaveBeenCalledOnce();
  });

  it('leaves partial clone data intact on failure and never starts for existing or canceled destinations', async () => {
    const root = await directory();
    const target = join(root, 'failed-clone');
    const run = vi.spyOn(git, 'runGit').mockImplementation(async () => {
      await writeFile(join(target, 'notes.txt'), 'user note');
      throw new Error('Authentication failed');
    });
    await expect(cloneProjectDirectory('https://example.com/repo.git', target)).rejects.toThrow(`Clone destination: ${target}`);
    expect(await readFile(join(target, 'notes.txt'), 'utf8')).toBe('user note');
    await expect(cloneProjectDirectory('https://example.com/repo.git', target)).rejects.toThrow('already exists');
    const controller = new AbortController(); controller.abort();
    await expect(cloneProjectDirectory('https://example.com/repo.git', join(root, 'canceled'), controller.signal)).rejects.toThrow('canceled');
    expect(run).toHaveBeenCalledOnce();
  });
});
