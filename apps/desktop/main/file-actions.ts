import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FileActionTarget, FileActionsInfo, OpenApplication, TreeActionTarget } from '../src/bridge';
import { safeRepositoryPath, type GitService } from './git';

const execute = promisify(execFile);
const finderPath = '/System/Library/CoreServices/Finder.app';

export interface NativeOpenApplication {
  name: string;
  kind: 'application' | 'default' | 'file-manager';
  applicationPath?: string;
  isDefault?: boolean;
  /** Bounded PNG rendered by the native application registry, when available. */
  icon?: string;
}

export interface FileActionsPlatform {
  applications(filePath: string): Promise<NativeOpenApplication[]>;
  icon(filePath: string): Promise<string | undefined>;
  open(filePath: string, application: NativeOpenApplication): Promise<void>;
}

// Static read-only NSWorkspace calls. The file is an argv element, never script
// source. These discovery APIs do not activate or launch any application.
const applicationScript = `
ObjC.import('AppKit');
function iconPNG(filePath) {
  try {
    var icon = $.NSWorkspace.sharedWorkspace.iconForFile(filePath);
    var bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null,32,32,8,4,true,false,$.NSCalibratedRGBColorSpace,0,0);
    $.NSGraphicsContext.saveGraphicsState;
    try {
      $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap));
      icon.drawInRectFromRectOperationFraction($.NSMakeRect(0,0,32,32),$.NSZeroRect,$.NSCompositingOperationSourceOver,1);
    } finally { $.NSGraphicsContext.restoreGraphicsState; }
    var data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$({}));
    if (Number(data.length) <= 16384) return 'data:image/png;base64,' + ObjC.unwrap(data.base64EncodedStringWithOptions(0));
  } catch (_) {}
  return null;
}
function run(argv) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var file = $.NSURL.fileURLWithPath(argv[0]);
  var urls = workspace.URLsForApplicationsToOpenURL(file);
  var defaultURL = workspace.URLForApplicationToOpenURL(file);
  var result = [];
  var seen = [];
  function append(url) {
    var appPath = ObjC.unwrap(url.path);
    if (seen.indexOf(appPath) !== -1) return;
    seen.push(appPath);
    result.push({path:appPath, name:ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(url.path)), icon:iconPNG(appPath)});
  }
  for (var i = 0; i < Math.min(Number(urls.count), 64); i++) {
    append(urls.objectAtIndex(i));
  }
  if (!defaultURL.isNil()) append(defaultURL);
  return JSON.stringify({applications:result, defaultPath:defaultURL.isNil()?null:ObjC.unwrap(defaultURL.path), finderIcon:iconPNG('/System/Library/CoreServices/Finder.app')});
}`;

function nativeIcon(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 22000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)) return;
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  if (bytes.length < 24 || bytes.length > 16384 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(16) !== 32 || bytes.readUInt32BE(20) !== 32) return;
  return value;
}

/** Finder followed by actual Launch Services handlers, with native bundle icons. */
export async function discoverMacApplications(filePath: string): Promise<NativeOpenApplication[]> {
  const result = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', applicationScript, '--', filePath], { shell: false, timeout: 4000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true });
  const parsed: unknown = JSON.parse(result.stdout);
  if (!parsed || typeof parsed !== 'object' || !('applications' in parsed) || !Array.isArray(parsed.applications)) throw new Error('macOS returned an invalid application list.');
  const defaultPath = 'defaultPath' in parsed && typeof parsed.defaultPath === 'string' ? await realpath(parsed.defaultPath).catch(() => undefined) : undefined;
  const applications = new Map<string, NativeOpenApplication>();
  for (const item of parsed.applications.slice(0, 65)) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || typeof item.name !== 'string' || !path.isAbsolute(item.path)) continue;
    try {
      const canonical = await realpath(item.path);
      if (canonical === finderPath || !/\.app$/i.test(canonical) || !(await lstat(canonical)).isDirectory()) continue;
      applications.set(canonical, { kind: 'application', name: item.name.replace(/\.app$/i, '').slice(0, 200), applicationPath: canonical, icon: nativeIcon(item.icon), ...(canonical === defaultPath ? { isDefault: true } : {}) });
    } catch { /* Removed applications are not offered. */ }
  }
  return [
    { kind: 'file-manager', name: 'Finder', applicationPath: finderPath, icon: nativeIcon('finderIcon' in parsed ? parsed.finderIcon : undefined) },
    ...[...applications.values()].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || a.name.localeCompare(b.name)),
  ];
}

/** Electron supplies only its narrowly scoped OS integration methods here. */
export function createNativeFileActionsPlatform(dependencies: {
  platform?: NodeJS.Platform;
  getFileIcon: (filePath: string) => Promise<string | undefined>;
  openDefault: (filePath: string) => Promise<string>;
  reveal: (filePath: string) => void;
}): FileActionsPlatform {
  const platform = dependencies.platform ?? process.platform;
  return {
    async applications(filePath) {
      if (platform === 'darwin') {
        const handlers = await discoverMacApplications(filePath).catch((): NativeOpenApplication[] => [{ kind: 'file-manager', name: 'Finder', applicationPath: finderPath }]);
        if (!handlers.some(handler => handler.kind === 'application')) handlers.push({ kind: 'default', name: 'Default application', isDefault: true });
        return handlers;
      }
      return [{ kind: 'default', name: 'Default application', isDefault: true }, { kind: 'file-manager', name: platform === 'win32' ? 'File Explorer' : 'File manager' }];
    },
    icon: dependencies.getFileIcon,
    async open(filePath, application) {
      if (application.kind === 'file-manager') { dependencies.reveal(filePath); return; }
      if (application.kind === 'default') {
        const error = await dependencies.openDefault(filePath);
        if (error) throw new Error(error);
        return;
      }
      if (platform !== 'darwin' || !application.applicationPath) throw new Error('This application is not available on this platform.');
      const canonical = await realpath(application.applicationPath);
      if (canonical !== application.applicationPath || !/\.app$/i.test(canonical) || !(await lstat(canonical)).isDirectory()) throw new Error('The application changed or was removed. Open the menu again.');
      // Paths only come from NSWorkspace and validated working-file capabilities.
      await execute('/usr/bin/open', ['-a', canonical, '--', filePath], { shell: false, timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true });
    },
  };
}

interface ApplicationCapability {
  repositoryId: string;
  target: FileActionTarget;
  fingerprint: string;
  absolutePath: string;
  application: NativeOpenApplication;
}

/** The UI supplies opaque choices; OS identifiers, executables, and paths stay here. */
export class FileActionsService {
  private readonly capabilities = new Map<string, ApplicationCapability>();
  constructor(private readonly git: Pick<GitService, 'resolveFileActionTarget' | 'resolveTreeActionPath' | 'getRepositoryRoot'>, private readonly platform: FileActionsPlatform, private readonly writeClipboard?: (text: string) => void) {}

  async getFileActions(repositoryId: string, target: FileActionTarget): Promise<FileActionsInfo> {
    const resolved = await this.git.resolveFileActionTarget(repositoryId, target);
    const { path: filePath, absolutePath, source, unavailableReason } = resolved;
    if (!source || !resolved.fingerprint) return { path: filePath, absolutePath, applications: [], ...(unavailableReason ? { unavailableReason } : {}) };
    const handlers = await this.platform.applications(absolutePath);
    const rendered = await Promise.all(handlers.slice(0, 66).map(async application => {
      const icon = application.icon ?? await this.platform.icon(application.applicationPath ?? absolutePath).catch(() => undefined);
      return { application, icon };
    }));
    // Discovery/icon retrieval can take time. Do not issue a launch permission
    // for a file that changed, disappeared, or escaped while the menu was loading.
    const current = await this.git.resolveFileActionTarget(repositoryId, target);
    if (current.fingerprint !== resolved.fingerprint || !current.source) return { path: filePath, absolutePath, applications: [], unavailableReason: current.unavailableReason ?? 'The file changed while its menu was loading. Open the menu again.' };
    const applications: OpenApplication[] = rendered.map(({ application, icon }) => {
      const id = randomUUID();
      this.capabilities.set(id, { repositoryId, target: { ...target }, fingerprint: resolved.fingerprint!, absolutePath, application });
      return { id, name: application.name, ...(icon ? { icon } : {}), ...(application.isDefault ? { isDefault: true } : {}) };
    });
    while (this.capabilities.size > 4096) this.capabilities.delete(this.capabilities.keys().next().value!);
    return { path: filePath, absolutePath, source: current.source, applications };
  }

  async openFileIn(repositoryId: string, target: FileActionTarget, applicationId: string): Promise<void> {
    const capability = typeof applicationId === 'string' ? this.capabilities.get(applicationId) : undefined;
    if (!capability || capability.repositoryId !== repositoryId || capability.target.kind !== target?.kind || capability.target.id !== target?.id) throw new Error('This application choice is no longer available. Open the file menu again.');
    const current = await this.git.resolveFileActionTarget(repositoryId, target);
    if (!current.source || current.absolutePath !== capability.absolutePath || current.fingerprint !== capability.fingerprint) throw new Error(current.unavailableReason ?? 'The file changed after opening its menu. Open the menu again.');
    await this.platform.open(current.absolutePath, capability.application);
  }

  async copyFilePath(repositoryId: string, target: TreeActionTarget, format: 'absolute' | 'relative'): Promise<void> {
    if (format !== 'absolute' && format !== 'relative') throw new Error('Invalid file path format.');
    if (!this.writeClipboard) throw new Error('Clipboard access is unavailable.');
    // Deleted files retain their known path. Nothing supplied by the renderer
    // becomes clipboard text: both forms come from a validated tree capability.
    const filePath = await this.git.resolveTreeActionPath(repositoryId, target);
    const root = this.git.getRepositoryRoot(repositoryId);
    const absolutePath = filePath ? safeRepositoryPath(root, filePath) : root;
    this.writeClipboard(format === 'absolute' ? absolutePath : filePath || '.');
  }

  releaseRepository(repositoryId: string): void {
    for (const [id, capability] of this.capabilities) if (capability.repositoryId === repositoryId) this.capabilities.delete(id);
  }

  dispose(): void { this.capabilities.clear(); }
}
