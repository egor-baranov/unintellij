import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', timeout: 40_000, fullyParallel: false, workers: 1,
  expect: { timeout: 10_000 }, reporter: 'list',
  // Monaco derives keybindings from the browser UA; Playwright's ControlOrMeta
  // follows the host OS. Keep the native UA so these agree on macOS and Windows.
  use: { ...devices['Desktop Chrome'], userAgent: undefined, baseURL: 'http://127.0.0.1:4181', viewport: { width: 1400, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run build:playground && npx vite preview --config apps/playground/vite.config.ts --port 4181', url: 'http://127.0.0.1:4181', reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
