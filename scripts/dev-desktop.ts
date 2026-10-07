import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import './build-desktop';
const server = await createServer({ configFile: 'apps/desktop/vite.config.ts' });
await server.listen();
const child = spawn(electron as unknown as string, ['apps/desktop/dist/index.cjs'], { stdio: 'inherit', env: { ...process.env, SMART_DIFF_DEV_URL: 'http://127.0.0.1:5174/' } });
async function close() { child.kill(); await server.close(); }
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
child.once('exit', async code => { await server.close(); process.exitCode = code ?? 0; });
