import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

interface UserDataDirectoryOptions {
  appDataDirectory: string;
  currentName: string;
  currentDirectory: string;
  explicitDirectory?: string;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Select an existing profile without moving data or changing its web origins. */
export function resolveUserDataDirectory(options: UserDataDirectoryOptions): string {
  const { appDataDirectory, currentDirectory, currentName, explicitDirectory } = options;
  if (explicitDirectory && isAbsolute(explicitDirectory)) return explicitDirectory;
  // Running the main .cjs directly uses Electron's development profile. Keep
  // that separate from both installed app profiles, as it was before renaming.
  if (currentName === 'Electron') return currentDirectory;
  const preferredDirectory = join(appDataDirectory, 'unintellij');
  if (isDirectory(preferredDirectory)) return preferredDirectory;
  const legacyDirectories = ['Smart Diff', 'smart-diff'].map(name => join(appDataDirectory, name));
  // An older build can already be using either legacy spelling. Preserve its
  // current choice when both exist instead of switching between profiles.
  if (legacyDirectories.includes(currentDirectory) && isDirectory(currentDirectory)) return currentDirectory;
  return legacyDirectories.find(isDirectory) ?? preferredDirectory;
}
