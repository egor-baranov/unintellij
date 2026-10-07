import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], testTimeout: 20000,
    // Integration suites launch real Git subprocesses. Unbounded file workers
    // contend for process creation and turn successful checks into timeouts.
    maxWorkers: 1,
  },
});
