// @vitest-environment node

// UI.6 A6 (UI6_SCOPE section 2 and 5; UI0 section 5 and 13.4): pure selectors built only from existing signals.
// ./mascotState.ts does not exist yet, so each test loads it first.
//
// Contract assumed for the implementer:
// - mascotForLoading(loading, hasSnapshot): 'loading' when loading && !hasSnapshot, otherwise null.
// - mascotForPreview(pending): 'thinking' when pending, otherwise null.
// - mascotForRunStatus(status): 'thinking' for 'running'. Every other status, including completed, failed and cancelled,
//   gives null. Completion never produces art (UI0 D-4).
// - The module imports nothing from a goals path (the Goal Engine stays out of the mascot).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RunStatus } from '../../../shared/types';

const here = dirname(fileURLToPath(import.meta.url));

const RUN_STATUSES: RunStatus[] = [
  'queued',
  'preparing',
  'waiting_for_approval',
  'running',
  'waiting_for_user',
  'retrying',
  'paused',
  'paused_limit_reached',
  'cancelling',
  'cancelled',
  'failed',
  'completed',
];

describe('mascot state selectors (UI6 A6)', () => {
  // [RED] loading shows only while the first load is pending, that is loading with no snapshot yet.
  it('mascotForLoading shows loading only while loading with no snapshot', async () => {
    const { mascotForLoading } = await import('./mascotState');
    expect(mascotForLoading(true, false)).toBe('loading');
    expect(mascotForLoading(true, true)).toBeNull();
    expect(mascotForLoading(false, false)).toBeNull();
    expect(mascotForLoading(false, true)).toBeNull();
  });

  // [RED] the preview request maps to thinking while pending and to nothing once it settles.
  it('mascotForPreview is thinking while the preview request is pending', async () => {
    const { mascotForPreview } = await import('./mascotState');
    expect(mascotForPreview(true)).toBe('thinking');
    expect(mascotForPreview(false)).toBeNull();
  });

  // [RED] a running run maps to thinking.
  it('mascotForRunStatus maps running to thinking', async () => {
    const { mascotForRunStatus } = await import('./mascotState');
    expect(mascotForRunStatus('running')).toBe('thinking');
  });

  // [RED] every other run status, terminal ones included, maps to null: no art for completed, failed or cancelled.
  it('mascotForRunStatus gives null for every status other than running', async () => {
    const { mascotForRunStatus } = await import('./mascotState');
    for (const status of RUN_STATUSES.filter((value) => value !== 'running')) {
      expect(mascotForRunStatus(status), status).toBeNull();
    }
  });

  // [RED] the selector module imports nothing from a goals path (scans its import and from specifiers).
  it('mascotState.ts imports nothing from a goals path', () => {
    const path = join(here, 'mascotState.ts');
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, 'utf8');
    const specifiers = [
      ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g),
    ].map((match) => match[1]!);
    expect(specifiers.filter((specifier) => /goals/i.test(specifier))).toEqual([]);
  });
});
