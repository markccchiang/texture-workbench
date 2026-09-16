import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Separate processes: the native addon is loaded once per test file
    pool: 'forks',
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/api/test/**/*.test.ts', 'packages/client/test/**/*.test.ts', 'bindings/node/test/**/*.test.ts', 'server/test/**/*.test.ts', 'cli/test/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'web',
          include: ['web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
