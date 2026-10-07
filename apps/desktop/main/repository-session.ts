import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { RecentProject } from '../src/bridge';

export const MAX_REPOSITORY_WINDOWS = 32;
export const MAX_RECENT_PROJECTS = 20;
const MAX_SESSION_BYTES = 1024 * 1024;

export interface RepositoryWindowSession { id: string; path: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\0') && isAbsolute(value);
}
function sessions(value: unknown): RepositoryWindowSession[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  // Duplicate paths represent independent windows, so deliberately retain them.
  return value.slice(0, MAX_REPOSITORY_WINDOWS).flatMap(item => {
    if (!item || typeof item !== 'object' || !validPath(item.path) || typeof item.id !== 'string' || !uuid.test(item.id) || ids.has(item.id)) return [];
    ids.add(item.id);
    return [{ id: item.id, path: item.path }];
  });
}

function recentProjects(value: unknown): RecentProject[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  return value.slice(0, MAX_RECENT_PROJECTS).flatMap(item => {
    if (!item || typeof item !== 'object' || !validPath(item.path) || typeof item.id !== 'string' || !uuid.test(item.id) || ids.has(item.id) || paths.has(item.path) || typeof item.lastOpenedAt !== 'number' || !Number.isFinite(item.lastOpenedAt) || item.lastOpenedAt < 0) return [];
    ids.add(item.id); paths.add(item.path);
    return [{ id: item.id, name: basename(item.path) || item.path, path: item.path, lastOpenedAt: item.lastOpenedAt }];
  }).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

async function readJson(file: string): Promise<unknown> {
  const handle = await open(file, 'r');
  try {
    if ((await handle.stat()).size > MAX_SESSION_BYTES) return null;
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

/** Persists repository locations only. Git and editing capabilities are recreated
 * by GitService on launch; renderer-supplied paths never enter this file.
 */
export class RepositorySessionStore {
  private pending: Promise<void> = Promise.resolve();
  private recent?: RecentProject[];
  private recentLoading?: Promise<RecentProject[]>;
  constructor(private readonly directory: string) {}

  async read(): Promise<RepositoryWindowSession[]> {
    let saved: unknown;
    try { saved = await readJson(join(this.directory, 'workspace.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return [];
      // Migrate the original single-repository preference only when no workspace
      // exists. An intentionally empty workspace must stay empty.
      try { saved = await readJson(join(this.directory, 'repository.json')); }
      catch { return []; }
      return saved && typeof saved === 'object' && 'path' in saved && validPath(saved.path) ? [{ id: randomUUID(), path: saved.path }] : [];
    }
    if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1 || !('windows' in saved)) return [];
    return sessions(saved.windows);
  }

  write(windows: RepositoryWindowSession[]): Promise<void> {
    const content = JSON.stringify({ version: 1, windows: sessions(windows) });
    return this.enqueue(() => this.writeJson('workspace.json', content));
  }

  async readRecent(): Promise<RecentProject[]> {
    this.recentLoading ??= (async () => {
      try {
        const saved = await readJson(join(this.directory, 'recent-projects.json'));
        this.recent = saved && typeof saved === 'object' && 'version' in saved && saved.version === 1 && 'projects' in saved ? recentProjects(saved.projects) : [];
      } catch (error) {
        this.recent = [];
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Existing workspace paths were persisted by the main process. Keep
          // their history even if the folders are now unavailable on this launch.
          this.recent = recentProjects((await this.read()).map(item => ({ ...item, lastOpenedAt: 0 })));
          if (this.recent.length) await this.enqueue(() => this.writeRecent());
        }
      }
      return this.recent;
    })();
    await this.recentLoading;
    return (this.recent ?? []).map(project => ({ ...project }));
  }

  /** Call only with a canonical path from repository registration, never an IPC path. */
  async remember(path: string): Promise<void> {
    if (!validPath(path)) throw new Error('Invalid recent project path');
    await this.readRecent();
    return this.enqueue(async () => {
      const previous = this.recent!.find(item => item.path === path);
      const project = { id: previous?.id ?? randomUUID(), name: basename(path) || path, path, lastOpenedAt: Date.now() };
      this.recent = [project, ...this.recent!.filter(item => item.path !== path)].slice(0, MAX_RECENT_PROJECTS);
      await this.writeRecent();
    });
  }

  private writeRecent(): Promise<void> {
    return this.writeJson('recent-projects.json', JSON.stringify({ version: 1, projects: this.recent }));
  }

  private async writeJson(name: string, content: string): Promise<void> {
    const target = join(this.directory, name);
    const temporary = `${target}.tmp`;
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const work = this.pending.catch(() => {}).then(action);
    this.pending = work;
    return work;
  }

  flush(): Promise<void> { return this.pending; }
}
