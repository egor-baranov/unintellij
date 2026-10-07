import { readdir, readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

/** Keep license texts with browser distributions as well as the Electron archive. */
export function bundleNotices(): Plugin {
  return {
    name: 'bundle-third-party-notices',
    apply: 'build',
    async generateBundle() {
      const root = new URL('../', import.meta.url);
      const files = ['LICENSE', 'THIRD_PARTY_NOTICES.md', ...(await readdir(new URL('licenses/', root))).map(name => `licenses/${name}`)];
      for (const fileName of files) this.emitFile({ type: 'asset', fileName, source: await readFile(new URL(fileName, root)) });
      for (const [fileName, source] of [['licenses/jetbrains-icons-manifest.json', 'apps/shared/icons/manifest.json'], ['licenses/jetbrains-icons-sources.md', 'apps/shared/icons/README.md']]) {
        this.emitFile({ type: 'asset', fileName, source: await readFile(new URL(source, root)) });
      }
    },
  };
}
