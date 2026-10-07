import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveUserDataDirectory } from './user-data-directory';

describe('renamed application profiles', () => {
  let appDataDirectory: string;
  beforeEach(async () => { appDataDirectory = await mkdtemp(join(tmpdir(), 'unintellij-profile-')); });
  afterEach(async () => { await rm(appDataDirectory, { recursive: true, force: true }); });
  const options = () => ({ appDataDirectory, currentName: 'unintellij', currentDirectory: join(appDataDirectory, 'unintellij') });

  it('keeps an explicit absolute profile even when installed profiles exist', async () => {
    await mkdir(join(appDataDirectory, 'unintellij'));
    await mkdir(join(appDataDirectory, 'Smart Diff'));
    const explicitDirectory = join(appDataDirectory, 'isolated-smoke-test');
    expect(resolveUserDataDirectory({ ...options(), explicitDirectory })).toBe(explicitDirectory);
    expect(await readdir(appDataDirectory)).not.toContain('isolated-smoke-test');
  });

  it('prefers an existing new profile over a legacy profile', async () => {
    await mkdir(join(appDataDirectory, 'unintellij'));
    await mkdir(join(appDataDirectory, 'Smart Diff'));
    expect(resolveUserDataDirectory({ ...options(), currentName: 'Smart Diff', currentDirectory: join(appDataDirectory, 'Smart Diff') })).toBe(join(appDataDirectory, 'unintellij'));
  });

  it.each(['Smart Diff', 'smart-diff'])('reuses the %s profile in place, retaining session and browser data', async legacyName => {
    const legacyDirectory = join(appDataDirectory, legacyName);
    await mkdir(join(legacyDirectory, 'Local Storage'), { recursive: true });
    await writeFile(join(legacyDirectory, 'repositories.json'), 'saved-projects');
    await writeFile(join(legacyDirectory, 'Local Storage', 'settings'), 'saved-settings');
    expect(resolveUserDataDirectory(options())).toBe(legacyDirectory);
    expect(await readFile(join(legacyDirectory, 'repositories.json'), 'utf8')).toBe('saved-projects');
    expect(await readFile(join(legacyDirectory, 'Local Storage', 'settings'), 'utf8')).toBe('saved-settings');
    expect(await readdir(appDataDirectory)).toEqual([legacyName]);
  });

  it('retains an older build’s current legacy profile when both legacy spellings exist', async () => {
    await mkdir(join(appDataDirectory, 'Smart Diff'));
    const currentDirectory = join(appDataDirectory, 'smart-diff');
    await mkdir(currentDirectory);
    expect(resolveUserDataDirectory({ ...options(), currentName: 'smart-diff', currentDirectory })).toBe(currentDirectory);
  });

  it('starts fresh installs at unintellij without creating or copying directories', async () => {
    expect(resolveUserDataDirectory(options())).toBe(join(appDataDirectory, 'unintellij'));
    expect(await readdir(appDataDirectory)).toEqual([]);
  });

  it('preserves the inherited profile for direct Electron development launches', async () => {
    await mkdir(join(appDataDirectory, 'unintellij'));
    const currentDirectory = join(appDataDirectory, 'Electron');
    const development = { ...options(), currentName: 'Electron', currentDirectory };
    expect(resolveUserDataDirectory(development)).toBe(currentDirectory);
    const explicitDirectory = join(appDataDirectory, 'test');
    expect(resolveUserDataDirectory({ ...development, explicitDirectory })).toBe(explicitDirectory);
  });

  it('ignores relative overrides and regular files when looking for reusable profiles', async () => {
    await writeFile(join(appDataDirectory, 'unintellij'), 'not a directory');
    await writeFile(join(appDataDirectory, 'Smart Diff'), 'not a directory');
    await mkdir(join(appDataDirectory, 'smart-diff'));
    expect(resolveUserDataDirectory({ ...options(), explicitDirectory: 'relative/path' })).toBe(join(appDataDirectory, 'smart-diff'));
  });
});
