import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import { defaultNodeFacts, defaultTreePreferences, withinProjectPath } from '../../shared/project/semantics';
import type { DirectoryMarking, FactReason, ProjectRole, ProjectTreePreferences, TreeNodeFacts } from '../../shared/project/semantics';
import { goTestFileScope } from '../../shared/project/fileClassification';

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_OBSERVED_DIRECTORIES = 2048;
const MAX_MARKINGS = 4096;
const markings = new Set<DirectoryMarking>(['sources', 'test-sources', 'resources', 'test-resources', 'generated-sources', 'generated-test-sources', 'excluded', 'included', 'ordinary']);
type Classification = Pick<TreeNodeFacts, 'role' | 'library' | 'generated' | 'inclusion' | 'scopes'>;
interface Rule {
  rootPath: string; priority: number; reason: FactReason;
  role?: ProjectRole; generated?: boolean; excluded?: boolean;
}
export interface ProjectMetadataIO {
  /** Callbacks must authorize paths, reject symlinks, and bound filesystem reads/listings. */
  readText(relativePath: string): Promise<string | null>;
  listDirectory(relativePath: string): Promise<Array<{ name: string; kind: 'file' | 'directory' | 'symlink' }>>;
}
interface Settings { preferences: ProjectTreePreferences; markings: Record<string, DirectoryMarking> }
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && !value.includes('\\') && !value.startsWith('/') && (value === '' || value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'));
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function preferences(value: unknown, base = defaultTreePreferences): ProjectTreePreferences {
  const result = { ...base };
  if (object(value)) for (const key of Object.keys(result) as Array<keyof ProjectTreePreferences>) if (typeof value[key] === 'boolean') result[key] = value[key];
  return result;
}
/** JSONC without evaluating project configuration. Strings remain byte-for-byte intact. */
function jsonc(text: string): unknown {
  let clean = '', string = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (string) {
      clean += char;
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') string = false;
    } else if (char === '"') { string = true; clean += char; }
    else if (char === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; clean += '\n'; }
    else if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i >= text.length) return null;
      i++; clean += ' ';
    }
    else clean += char;
  }
  let result = ''; string = false; escape = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (!string && char === ',' && /^\s*[}\]]/.test(clean.slice(i + 1))) continue;
    result += char;
    if (string) { if (escape) escape = false; else if (char === '\\') escape = true; else if (char === '"') string = false; }
    else if (char === '"') string = true;
  }
  try { return JSON.parse(result); } catch { return null; }
}

/** Project classification is separate from Git ignore/status and diagnostics. Only
 * known metadata files are read; directory expansion never recursively scans dependencies. */
export class ProjectMetadata {
  private settings: Settings = { preferences: { ...defaultTreePreferences }, markings: {} };
  private readonly directories = new Set<string>(['']);
  private readonly detected = new Map<string, Rule[]>();
  private readonly detectedHashes = new Map<string, string>();
  private readonly importedCache = new Map<string, { hash: string; rules: Rule[] }>();
  private imported: Rule[] = [];
  private metadataPaths = new Set<string>();
  private observed = new Map<string, Promise<void>>();
  private mutation: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void> | undefined;
  private epoch = 0;
  constructor(private readonly root: string, private readonly settingsDirectory?: string) {}

  private get settingsPath(): string | undefined {
    return this.settingsDirectory ? path.join(this.settingsDirectory, 'project-trees', `${createHash('sha256').update(this.root).digest('hex')}.json`) : undefined;
  }
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const file = this.settingsPath;
      if (!file) return;
      try {
        const handle = await open(file, 'r');
        let data: unknown;
        try { if ((await handle.stat()).size > MAX_SETTINGS_BYTES) return; data = JSON.parse(await handle.readFile('utf8')); }
        finally { await handle.close(); }
        if (!object(data) || data.version !== 1 || data.root !== this.root) return;
        const saved: Record<string, DirectoryMarking> = {};
        if (object(data.markings)) for (const [key, value] of Object.entries(data.markings).slice(0, MAX_MARKINGS)) {
          if (validPath(key) && typeof value === 'string' && markings.has(value as DirectoryMarking)) Object.defineProperty(saved, key, { value, enumerable: true, configurable: true, writable: true });
        }
        this.settings = { preferences: preferences(data.preferences), markings: saved };
      } catch { /* Missing, malformed, or unreadable preferences use safe defaults. */ }
    })();
    return this.loaded;
  }
  getPreferences(): ProjectTreePreferences { return { ...this.settings.preferences }; }
  getMetadataPaths(): string[] { return [...this.metadataPaths]; }
  private async persist(next: Settings): Promise<void> {
    const file = this.settingsPath;
    if (!file) { this.settings = next; return; }
    const content = JSON.stringify({ version: 1, root: this.root, ...next });
    if (Buffer.byteLength(content, 'utf8') > MAX_SETTINGS_BYTES) throw new Error('Project preferences exceed the storage limit.');
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, file); }
    catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
    this.settings = next;
  }
  setPreferences(patch: Partial<ProjectTreePreferences>): Promise<ProjectTreePreferences> {
    const work = this.mutation.catch(() => {}).then(async () => {
      await this.load();
      const next = preferences(patch, this.settings.preferences);
      await this.persist({ ...this.settings, preferences: next });
      return { ...next };
    });
    this.mutation = work;
    return work;
  }
  mark(relativePath: string, marking: DirectoryMarking | null): Promise<void> {
    if (!validPath(relativePath) || (marking !== null && !markings.has(marking))) return Promise.reject(new Error('Invalid directory marking.'));
    const work = this.mutation.catch(() => {}).then(async () => {
      await this.load();
      const next = { ...this.settings.markings };
      if (marking === null) delete next[relativePath];
      else Object.defineProperty(next, relativePath, { value: marking, enumerable: true, configurable: true, writable: true });
      if (Object.keys(next).length > MAX_MARKINGS) throw new Error('Too many directory markings.');
      await this.persist({ ...this.settings, markings: next });
    });
    this.mutation = work;
    return work;
  }
  private resolveMetadataPath(value: unknown, directory: string): string | null {
    if (typeof value !== 'string' || !value || value.includes('\0') || /[*?]|\$\{|\$[A-Z_]+\$/.test(value)) return null;
    const absolute = path.resolve(this.root, directory, value);
    const relative = path.relative(this.root, absolute).split(path.sep).join('/');
    return validPath(relative) ? relative : null;
  }
  private async read(relativePath: string, io: ProjectMetadataIO): Promise<string | null> {
    this.metadataPaths.add(relativePath);
    try { const value = await io.readText(relativePath); return value !== null && Buffer.byteLength(value, 'utf8') <= MAX_METADATA_BYTES ? value : null; }
    catch { return null; }
  }
  async refresh(io: ProjectMetadataIO): Promise<void> {
    await this.load();
    const epoch = ++this.epoch;
    this.metadataPaths = new Set(); this.observed = new Map();
    // Retain only directories already visited. There is no recursive traversal.
    await Promise.all([...this.directories].map(directory => this.observeDirectory(directory, io)));
    const files: string[] = [];
    for (const directory of ['', '.idea']) {
      this.metadataPaths.add(directory);
      let entries: Awaited<ReturnType<ProjectMetadataIO['listDirectory']>> = [];
      try { entries = await io.listDirectory(directory); } catch { continue; }
      for (const entry of entries.slice(0, 4096)) {
        if (entry.kind === 'file' && !entry.name.includes('/') && entry.name.endsWith('.iml')) {
          const relative = directory ? `${directory}/${entry.name}` : entry.name;
          if (validPath(relative) && files.length < 64) files.push(relative);
        }
      }
    }
    const imported = (await Promise.all(files.map(async file => {
      const text = await this.read(file, io);
      if (text === null) { this.importedCache.delete(file); return []; }
      const hash = createHash('sha256').update(text).digest('hex');
      const previous = this.importedCache.get(file);
      if (previous?.hash === hash) return previous.rules;
      const rules = this.importModule(text, file);
      if (epoch === this.epoch) this.importedCache.set(file, { hash, rules });
      return rules;
    }))).flat();
    if (epoch === this.epoch) {
      this.imported = imported;
      for (const file of this.importedCache.keys()) if (!files.includes(file)) this.importedCache.delete(file);
    }
  }
  observeDirectory(directory: string, io: ProjectMetadataIO): Promise<void> {
    if (!validPath(directory)) return Promise.resolve();
    const existing = this.observed.get(directory);
    if (existing) return existing;
    if (!this.directories.has(directory) && this.directories.size >= MAX_OBSERVED_DIRECTORIES) return Promise.resolve();
    // A caller may list a dependency root, but we never inspect its descendants' manifests.
    if (this.classify(directory, 'directory').library) return Promise.resolve();
    this.directories.add(directory);
    const epoch = this.epoch;
    const work = (async () => {
      const prefix = directory ? `${directory}/` : '';
      const [packageText, tsconfigText] = await Promise.all([this.read(`${prefix}package.json`, io), this.read(`${prefix}tsconfig.json`, io)]);
      const hash = createHash('sha256').update(JSON.stringify([packageText, tsconfigText])).digest('hex');
      if (this.detectedHashes.get(directory) === hash) return;
      const rules: Rule[] = [];
      if (packageText !== null) {
        let value: unknown;
        try { value = JSON.parse(packageText); } catch { value = null; }
        if (object(value)) rules.push({ rootPath: `${prefix}node_modules`, priority: 1, role: 'library', excluded: true, reason: { source: 'detection', description: 'Dependencies of a JavaScript package', path: `${prefix}package.json` } });
      }
      const config = tsconfigText === null ? null : jsonc(tsconfigText);
      if (object(config) && object(config.compilerOptions)) {
        const rootDir = this.resolveMetadataPath(config.compilerOptions.rootDir, directory);
        const outDir = this.resolveMetadataPath(config.compilerOptions.outDir, directory);
        if (rootDir !== null) rules.push({ rootPath: rootDir, priority: 2, role: 'sources', reason: { source: 'project-metadata', description: 'TypeScript compilerOptions.rootDir', path: `${prefix}tsconfig.json` } });
        // A malformed outDir pointing at the whole project must not exclude it.
        if (outDir !== null && outDir !== '') rules.push({ rootPath: outDir, priority: 2, generated: true, excluded: true, reason: { source: 'project-metadata', description: 'TypeScript compilerOptions.outDir', path: `${prefix}tsconfig.json` } });
      }
      if (epoch === this.epoch) { this.detected.set(directory, rules); this.detectedHashes.set(directory, hash); }
    })();
    this.observed.set(directory, work);
    return work;
  }
  private importModule(text: string, file: string): Rule[] {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) return [];
    let invalid = false;
    const fail = () => { invalid = true; };
    let document: ReturnType<DOMParser['parseFromString']>;
    try { document = new DOMParser({ locator: {}, errorHandler: { warning: fail, error: fail, fatalError: fail } }).parseFromString(text, 'application/xml'); }
    catch { return []; }
    if (invalid || document.documentElement.tagName !== 'module') return [];
    const moduleDirectory = path.dirname(path.join(this.root, file));
    const resolve = (url: string): string | null => {
      if (!url.startsWith('file://') || /\$[^$]+\$/.test(url.replaceAll('$PROJECT_DIR$', '').replaceAll('$MODULE_DIR$', ''))) return null;
      let absolute: string;
      try { absolute = fileURLToPath(url.replace('file://$PROJECT_DIR$', pathToFileURL(this.root).href).replace('file://$MODULE_DIR$', pathToFileURL(moduleDirectory).href)); } catch { return null; }
      return this.resolveMetadataPath(absolute, '');
    };
    const rules: Rule[] = [];
    for (const name of ['content', 'sourceFolder', 'excludeFolder'] as const) {
      const nodes = document.getElementsByTagName(name);
      for (let i = 0; i < Math.min(nodes.length, 2048); i++) {
        const node = nodes.item(i)! as NonNullable<ReturnType<typeof nodes.item>> & { lineNumber?: number };
        const rootPath = resolve(node.getAttribute('url') ?? '');
        if (rootPath === null) continue;
        const reason: FactReason = { source: 'project-metadata', description: `IntelliJ module ${name}`, path: file, ...(node.lineNumber ? { line: node.lineNumber } : {}) };
        if (name === 'excludeFolder') rules.push({ rootPath, priority: 2, excluded: true, reason });
        else if (name === 'content') rules.push({ rootPath, priority: 2, role: 'content', reason });
        else {
          const type = node.getAttribute('type');
          const test = node.getAttribute('isTestSource') === 'true' || type === 'java-test-resource';
          const resource = type === 'java-resource' || type === 'java-test-resource';
          rules.push({ rootPath, priority: 2, role: resource ? test ? 'test-resources' : 'resources' : test ? 'test-sources' : 'sources', generated: node.getAttribute('generated') === 'true', excluded: false, reason });
        }
      }
    }
    return rules;
  }
  /** Explicit inclusions can be reached without crawling an excluded parent. */
  includedRootsBelow(relativePath: string): string[] {
    const roots = Object.entries(this.settings.markings).filter(([, mark]) => mark !== 'excluded' && mark !== 'ordinary').map(([root]) => root);
    roots.push(...this.imported.filter(rule => rule.excluded === false).map(rule => rule.rootPath));
    return [...new Set(roots)].filter(root => root !== relativePath && withinProjectPath(root, relativePath) && this.classify(root, 'directory').inclusion.state === 'included');
  }
  classify(relativePath: string, kind: TreeNodeFacts['identity']['kind']): Classification {
    const fallback = defaultNodeFacts('', relativePath, kind);
    const result: Classification = { role: fallback.role, generated: fallback.generated, inclusion: fallback.inclusion, scopes: [] };
    if (!validPath(relativePath)) return result;
    const userRules: Rule[] = Object.entries(this.settings.markings).map(([rootPath, marking]) => {
      const base: Rule = { rootPath, priority: 3, reason: { source: 'user', description: `Marked as ${marking.replaceAll('-', ' ')}` } };
      if (marking === 'excluded' || marking === 'included') return { ...base, excluded: marking === 'excluded' };
      const generated = marking.startsWith('generated-');
      return { ...base, role: generated ? marking === 'generated-test-sources' ? 'test-sources' : 'sources' : marking as ProjectRole, generated, ...(marking === 'ordinary' ? {} : { excluded: false }) };
    });
    const rules = [...this.detected.values()].flat().concat(this.imported, userRules)
      .filter(rule => withinProjectPath(relativePath, rule.rootPath) && (relativePath !== rule.rootPath || kind === 'directory') && (rule.role !== 'content' || relativePath === rule.rootPath))
      .sort((a, b) => a.priority - b.priority || a.rootPath.length - b.rootPath.length);
    for (const rule of rules) {
      if (rule.role === 'library') result.library = { rootPath: rule.rootPath, reason: rule.reason };
      if (rule.role !== undefined) result.role = { kind: rule.role, declared: relativePath === rule.rootPath, rootPath: rule.rootPath, reason: rule.reason };
      if (rule.generated !== undefined) result.generated = { value: rule.generated, reason: rule.reason };
      if (rule.excluded !== undefined) result.inclusion = { state: rule.excluded ? relativePath === rule.rootPath ? 'excluded' : 'inherited-exclusion' : 'included', rootPath: rule.rootPath, reason: rule.reason };
    }
    if (result.library || result.inclusion.state !== 'included') {
      const rootPath = result.library?.rootPath ?? result.inclusion.rootPath ?? '';
      result.scopes.push({ id: `non-project:${rootPath}`, kind: 'non-project', rootPath, reason: result.library?.reason ?? result.inclusion.reason });
    }
    if (result.role.kind === 'test-sources' || result.role.kind === 'test-resources') {
      const rootPath = result.role.rootPath ?? '';
      result.scopes.push({ id: `test:${rootPath}`, kind: 'test', rootPath, reason: result.role.reason });
    }
    const fileScope = goTestFileScope(relativePath, kind);
    if (fileScope && !result.scopes.some(scope => scope.kind === 'test')) result.scopes.push(fileScope);
    return result;
  }
}
