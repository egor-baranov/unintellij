import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { bundleNotices } from '../../scripts/vite-notices';
export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)), base: './', plugins: [react(), bundleNotices(), { name: 'development-csp', transformIndexHtml: html => command === 'serve' ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:*") : html }],
  resolve: { alias: { 'monaco-smart-diff': fileURLToPath(new URL(command === 'build' ? '../../packages/monaco-smart-diff/dist/index.js' : '../../packages/monaco-smart-diff/src/index.ts', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5174, strictPort: true }, optimizeDeps: { include: ['vscode-diff'] }, worker: { format: 'es' },
  build: { target: 'es2022', outDir: 'dist/renderer', emptyOutDir: true },
}));
