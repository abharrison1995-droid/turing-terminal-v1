import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../../vitest.config.js';

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

  it('keeps production on the disabled executor, with no resolved-plan wiring', () => {
    const index = readFileSync(join(root, 'src', 'server', 'index.ts'), 'utf8');
    expect(index).toContain('new DisabledGoalExecutor()');
    expect(index).not.toMatch(/ResolvedGoalRunPlanProvider|TuringGoalExecutor/);
  });
});
