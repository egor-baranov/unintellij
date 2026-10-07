import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { runGit } from './git';

/** Display only; all project operations retain their absolute, authorized path. */
export function projectDisplayPath(projectPath: string, home = homedir()): string {
  const within = relative(home, projectPath);
  if (!within) return '~';
  return within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within) ? `~/${within.split(sep).join('/')}` : projectPath;
}

export function validateCloneUrl(value: unknown): { url: string; name: string } {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value.trim())) throw new Error('Enter an HTTPS or SSH repository URL.');
  const url = value.trim();
  let repositoryPath: string;
  if (/^(https|ssh|git):\/\//i.test(url)) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('Enter a valid repository URL.'); }
    if (!parsed.hostname || parsed.hostname.startsWith('-') || parsed.password || parsed.search || parsed.hash || parsed.username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(parsed.username)) throw new Error('Repository URLs must not contain passwords, options, queries, or fragments.');
    repositoryPath = parsed.pathname;
  } else {
    // The conventional git@host:owner/repository.git SSH form. Local paths,
    // remote-helper syntax (ext::), and option-like host names are not accepted.
    const match = /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?([a-zA-Z0-9][a-zA-Z0-9.-]*):([^/:].*)$/.exec(url);
    if (!match || /[?#]/.test(match[2])) throw new Error('Use an HTTPS, SSH, or git:// repository URL. Local paths and custom Git transports are not supported.');
    repositoryPath = match[2];
  }
  const name = repositoryPath.replace(/\/+$/, '').split('/').at(-1)?.replace(/\.git$/i, '') ?? '';
  if (!name || name === '.' || name === '..' || /[\\<>:"|?*]/.test(name)) throw new Error('The repository URL must include a valid repository name.');
  return { url, name };
}

/** The native location dialog is the sole authority for this destination. */
export async function createProjectDirectory(destination: string): Promise<string> {
  if (!isAbsolute(destination) || !basename(destination) || destination.includes('\0')) throw new Error('Choose a valid project location.');
  const parent = await realpath(dirname(destination));
  const target = join(parent, basename(destination));
  try {
    await lstat(target);
    throw new Error('That location already exists. Choose a new folder name.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Exclusive mkdir protects an existing directory (including empty folders and
  // symlinks) if the destination changes while the native dialog is open.
  try { await mkdir(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('That location already exists. Choose a new folder name.');
    throw error;
  }
  return target;
}

export async function cloneProjectDirectory(value: unknown, destination: string, signal?: AbortSignal): Promise<string> {
  const { url } = validateCloneUrl(value);
  if (signal?.aborted) throw new Error('Cloning canceled.');
  const target = await createProjectDirectory(destination);
  const isolated = await mkdtemp(join(tmpdir(), 'smart-diff-clone-'));
  try {
    const config = join(isolated, 'config');
    const empty = join(isolated, 'empty');
    await Promise.all([writeFile(config, '', { mode: 0o600 }), mkdir(empty)]);
    // Reuse the application's Git executable/process bounds. A clone must not
    // import global URL rewrites, credential commands, templates, checkout hooks,
    // filters, submodule transports, or repository-controlled helper programs.
    await runGit(dirname(target), [
      '-c', `core.hooksPath=${empty}`, '-c', 'core.sshCommand=ssh -oBatchMode=yes',
      '-c', 'credential.helper=', '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=always',
      '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
      '-c', 'fetch.fsckObjects=true', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
      'clone', '--no-recurse-submodules', `--template=${empty}`, '--', url, target,
    ], 1024 * 1024, {
      timeoutMs: 10 * 60 * 1000, signal,
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: config, GIT_CONFIG_GLOBAL: config, GIT_ASKPASS: 'true', SSH_ASKPASS: 'true' },
    });
    return target;
  } catch (error) {
    // Do not recursively remove the destination on failure: the user may have
    // added files while cloning. The existing project is never overwritten.
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nClone destination: ${target}`);
  } finally { await rm(isolated, { recursive: true, force: true }); }
}
