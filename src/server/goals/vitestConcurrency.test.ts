import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../../vitest.config.js';
import type { Db } from '../db.js';
import { expectProductionGoalCompositionEnabled } from './productionCompositionKit.js';

const root = join(import.meta.dirname, '..', '..', '..');

describe('repository test concurrency', () => {
  it('caps workers in vitest.config.ts so plain `npm test` uses the repository cap', () => {
    expect(config.test?.maxWorkers).toBe(1);
    const scripts = (
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    // The cap lives in the config, not in a command-line flag, and no timeout is raised to compensate.
    expect(scripts.test).not.toMatch(/maxWorkers|max-workers/);
    expect(config.test?.testTimeout).toBeUndefined();
  });

  it('composes production on the resolved-route executor without touching the test concurrency cap', async () => {
    // No database access is needed to observe the composed executor; its persisted-run fast path reads nothing here.
    const emptyDb = { prepare: () => ({ get: () => undefined }) } as unknown as Db;
    await expectProductionGoalCompositionEnabled(emptyDb);
    expect(config.test?.maxWorkers).toBe(1);
  });
});
