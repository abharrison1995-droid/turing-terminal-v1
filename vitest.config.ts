import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Serialize files to keep SQLite/Git integration tests within their existing 5s budgets under load.
    maxWorkers: 1,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-server/**',
      '**/.git/**',
      '**/.codex-*/**',
      'e2e/**',
    ],
  },
});
