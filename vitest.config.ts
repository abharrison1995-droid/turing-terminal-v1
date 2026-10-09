import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // DB/Git integration tests exceed their 5s budgets when CI runs six workers at once.
    maxWorkers: 2,
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-server/**', '**/.git/**'],
  },
});
