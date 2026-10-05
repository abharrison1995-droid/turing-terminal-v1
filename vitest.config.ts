import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The repository's proven concurrency cap: the default (one worker per core) times out DB/git-heavy tests under load.
    maxWorkers: 6,
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-server/**', '**/.git/**'],
  },
});
