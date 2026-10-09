import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '../../shared/types.js';
import { createApp } from '../app.js';
import { openDatabase, type Db } from '../db.js';
import { RunEngine } from '../runEngine.js';
import { startQueuedRun } from '../runLauncher.js';
import { RouteProbeReconciler, type RouteProbeRequest } from './routeProbe.js';
import { SUBSCRIPTION_TEST_ROUTE } from './testPlanProvider.js';
import type { ProviderRunRequest } from '../providers.js';

/**
 * Shared harness for the Stage 5B probe tests: real SQLite, real temporary Git (the fixture repository is built under a
 * temporary TT_DATA_DIR), the real RunEngine and Fastify app. Only the provider process boundary is faked by the calling
 * test (`vi.mock('../providers.js')`); no test ever reaches a real provider or the network.
 */

export const caps: ProviderCapabilities = {
  authentication: true,
  subscriptionAuth: true,
  modelDiscovery: false,
  execution: true,
  streaming: true,
  cancellation: true,
  usageTelemetry: true,
  remainingAllowance: false,
  resetTelemetry: false,
  structuredOutput: false,
  sessionResume: false,
  toolMediation: true,
};

export const claude = (overrides: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id: 'claude-code',
  name: 'Claude Code',
  cli: 'claude',
  detected: true,
  version: '2.1.300',
  authentication: 'connected',
  subscriptionAuthenticated: true,
  authMechanism: 'test',
  note: 'test',
  checkedAt: new Date().toISOString(),
  capabilities: caps,
  models: [],
  ...overrides,
});

export const ROUTE = { ...SUBSCRIPTION_TEST_ROUTE };

export const probeBody = (
  roles: RouteProbeRequest['roles'] = ['orchestrator', 'implementer'],
  configuration: Record<string, unknown> = ROUTE,
  freshnessClass: 'stable-subscription' | 'opportunity' = 'stable-subscription',
) => ({ member: { configuration, freshnessClass }, roles });

export const done = (text: string) => ({
  text,
  inputTokens: 10,
  outputTokens: 5,
  usageProvenance: 'provider_reported' as const,
  exitCode: 0,
  stdout: 'ok',
});

export type ProbeProfileName =
  'structured-readonly' | 'orchestrator-json' | 'review-json' | 'broker-read' | 'broker-edit';

export const profileOf = (request: ProviderRunRequest): ProbeProfileName | null =>
  (/Route-validation task \(([a-z-]+)\)/.exec(request.prompt)?.[1] as ProbeProfileName | undefined) ?? null;

export const GOOD_ANSWERS = {
  'structured-readonly': JSON.stringify({
    profile: 'structured-readonly',
    items: ['alpha', 'bravo', 'charlie', 'delta'],
  }),
  'orchestrator-json': JSON.stringify({
    milestoneKey: 'probe-m1',
    title: 'Add a greeting helper',
    instructions: 'Add a greeting helper under src.',
    targetCriteria: ['probe-c1'],
    expectedPaths: ['src/greeting.ts'],
    rationale: 'The milestone asks for a greeting helper.',
  }),
  'review-json': JSON.stringify({
    verdict: 'block',
    criterionProgress: [],
    existingFindings: [],
    newFindings: [
      {
        severity: 'high',
        category: 'correctness',
        description: 'Off-by-one: the loop condition uses <= and reads one element past count.',
        evidence: 'for (let i = 0; i <= count; i++)',
        affectedFiles: ['src/range.ts'],
        remediation: 'Use < count.',
      },
    ],
    regressions: [],
    scopeDrift: false,
    architectureDrift: false,
    furtherWorkJustified: true,
  }),
} as const;

export interface ProbeHarness {
  root: string;
  db: Db;
  engine: RunEngine;
  app: ReturnType<typeof createApp>;
  broker(
    token: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ error?: string; result?: string }>;
  startRun(runId: string): unknown;
  reconciler(): RouteProbeReconciler;
  /** A new engine on the same database, as after a master restart. */
  restart(): void;
  post(payload: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }>;
  waitRun(runId: string, status: string): Promise<void>;
  close(): Promise<void>;
}

export async function probeHarness(): Promise<ProbeHarness> {
  const root = mkdtempSync(join(tmpdir(), 'turing-route-probe-'));
  const previous = process.env.TT_DATA_DIR;
  process.env.TT_DATA_DIR = join(root, 'data');
  // Probe runs commit in their worktree; a CI runner has no global Git identity, so supply one for this process.
  const identity = {
    GIT_AUTHOR_NAME: 'Turing Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Turing Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const priorIdentity = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(identity)) process.env[key] ??= value;
  const db = openDatabase(process.env.TT_DATA_DIR);
  const harness = {
    root,
    db,
    engine: new RunEngine(db, () => undefined),
  } as ProbeHarness;
  const bind = () => {
    harness.app = createApp({ database: db, engine: harness.engine });
  };
  bind();
  await harness.app.ready();
  Object.assign(harness, {
    async broker(token: string, toolName: string, input: Record<string, unknown>) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/internal/provider-tools',
        headers: { authorization: `Bearer ${token}` },
        payload: { toolName, input },
      });
      return response.json() as { error?: string; result?: string };
    },
    startRun: (runId: string) => startQueuedRun(db, harness.engine, runId),
    reconciler: () => new RouteProbeReconciler(db, (runId) => startQueuedRun(db, harness.engine, runId)),
    restart() {
      harness.engine = new RunEngine(db, () => undefined);
    },
    async post(payload: unknown) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/route-validations',
        payload: payload as never,
      });
      return { statusCode: response.statusCode, json: response.json() as Record<string, unknown> };
    },
    async waitRun(runId: string, status: string) {
      const actual = await vi.waitFor(
        () => {
          const current = (
            db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }
          ).status;
          if (current === status || ['completed', 'failed', 'cancelled'].includes(current)) return current;
          expectStatus(current, status);
          return current;
        },
        { timeout: 20_000, interval: 25 },
      );
      if (actual !== status) {
        const stages = db
          .prepare(
            'SELECT stage_key, kind, status, output_json FROM stages WHERE run_id = ? ORDER BY sequence',
          )
          .all(runId);
        throw new Error(
          `run status ${actual}, expected ${status}; stages: ${JSON.stringify(stages).slice(0, 4_000)}`,
        );
      }
    },
    async close() {
      await harness.app.close();
      if (db.open) db.close();
      if (previous === undefined) delete process.env.TT_DATA_DIR;
      else process.env.TT_DATA_DIR = previous;
      for (const [key, value] of Object.entries(priorIdentity)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  });
  return harness;
}

function expectStatus(actual: string, expected: string) {
  if (actual !== expected) throw new Error(`run status ${actual}, expected ${expected}`);
}
