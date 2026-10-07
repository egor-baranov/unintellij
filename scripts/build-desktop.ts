import { build } from 'esbuild';
import { mkdir, writeFile, cp } from 'node:fs/promises';
await build({ entryPoints: ['apps/desktop/main/index.ts', 'apps/desktop/main/preload.ts'], outdir: 'apps/desktop/dist', outExtension: { '.js': '.cjs' }, entryNames: '[name]', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: true });
await mkdir('apps/desktop/dist', { recursive: true });
await cp('licenses', 'apps/desktop/dist/licenses', { recursive: true });
await cp('THIRD_PARTY_NOTICES.md', 'apps/desktop/dist/THIRD_PARTY_NOTICES.md');
await cp('LICENSE', 'apps/desktop/dist/LICENSE');
await writeFile('apps/desktop/dist/package.json', JSON.stringify({ name: 'unintellij', productName: 'unintellij', version: '0.1.0', description: 'A compact local Git diff browser', author: 'Smart Diff contributors', main: 'index.cjs', private: true }));
