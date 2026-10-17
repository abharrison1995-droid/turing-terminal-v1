import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus, WorkflowDefinition } from '../../shared/types.js';

vi.mock('../providers.js', () => ({
  discoverProviders: vi.fn(async () => []),
  executeProvider: vi.fn(async () => {
    throw new Error('Provider calls are disabled in Goal executor tests.');
  }),
  invalidateProviderCache: vi.fn(),
}));

import { discoverProviders, executeProvider } from '../providers.js';
import type { ProposalRequest } from './executor.js';
import { openFinding } from './remediationKit.js';
import { cleanupRepoFixtures, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';
import { TuringGoalExecutor } from './turingExecutor.js';
import { realRunHarness, type RealRunHarness } from './turingRunKit.js';

const caps: ProviderCapabilities = {
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
const provider = (id: string, name: string, extra: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  name,
  cli: id,
  detected: true,
  version: '1',
  authentication: 'connected',
  subscriptionAuthenticated: true,
  authMechanism: 'test',
  note: 'test',
  checkedAt: new Date().toISOString(),
  capabilities: caps,
  models: [],
  ...extra,
});

let h: RealRunHarness | undefined;
const mutate = { current: (_workflow: WorkflowDefinition): void => undefined };

beforeEach(() => {
  mutate.current = () => undefined;
  vi.mocked(discoverProviders).mockResolvedValue([provider('claude-code', 'Claude Code')]);
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  cleanupRepoFixtures();
  vi.mocked(executeProvider).mockReset();
});

const open = async (options: Parameters<typeof realRunHarness>[0] = {}) => {
  h = await realRunHarness({ ...options, mutate: (workflow) => mutate.current(workflow) });
  await h.supervisor.startGoal(h.fx.goalId);
  await h.until('cycle_created');
  return h;
};
const request = (harness: RealRunHarness): ProposalRequest => ({
  goalId: harness.fx.goalId,
  cycleId: harness.cycleId(),
  definitionVersion: 1,
  milestone: harness.fx.definition.milestones[0]!,
  baseCommit: harness.baseCommit,
  memory: {} as ProposalRequest['memory'],
});

const promptOf = async (harness: RealRunHarness): Promise<string> => {
  const { runId } = await new TuringGoalExecutor(harness.fx.db, harness.plans).queueProposalRun(
    request(harness),
  );
  return (harness.fx.db.prepare('SELECT prompt FROM runs WHERE id = ?').get(runId) as { prompt: string })
    .prompt;
};

describe('real proposal prompt for remediation cycles', () => {
  it(
    'derives the remediation planning text from the persisted cycle kind',
    async () => {
      const ordinaryHarness = await open();
      expect(await promptOf(ordinaryHarness)).not.toContain('remediation planning cycle');
      await ordinaryHarness.close();
      h = undefined;
      cleanupRepoFixtures();

      h = await realRunHarness({ mutate: (workflow) => mutate.current(workflow) });
      await openFinding(h.fx, 'high', { kind: 'milestone', milestone: 'm1' });
      await h.supervisor.startGoal(h.fx.goalId);
      await h.until('cycle_created');
      const cycle = h.fx.db.prepare('SELECT kind FROM goal_cycles WHERE id = ?').get(h.cycleId()) as {
        kind: string;
      };
      expect(cycle.kind).toBe('remediation');
      expect(await promptOf(h)).toContain('remediation planning cycle');
      expect(vi.mocked(executeProvider)).not.toHaveBeenCalled();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
