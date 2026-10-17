import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { expect, vi } from 'vitest';
import type {
  GoalDefinitionFull,
  GoalDetail,
  GoalEvidenceView,
  GoalListItem,
  GoalPreview,
} from '../../shared/goalApi';

expect.extend({
  toHaveAttribute(received: Element, name: string, value?: string) {
    const actual = received.getAttribute(name);
    return {
      pass: value === undefined ? actual !== null : actual === value,
      message: () => `expected attribute ${name} to be ${String(value)} but was ${String(actual)}`,
    };
  },
  toHaveTextContent(received: Element, text: string | RegExp) {
    const content = received.textContent ?? '';
    return {
      pass: typeof text === 'string' ? content.includes(text) : text.test(content),
      message: () => `expected text ${String(text)} in "${content}"`,
    };
  },
  toBeInTheDocument(received: Element | null) {
    return {
      pass: received !== null && received.isConnected,
      message: () => 'expected element in the document',
    };
  },
});
declare module 'vitest' {
  interface Assertion {
    toHaveAttribute(name: string, value?: string): void;
    toHaveTextContent(text: string | RegExp): void;
    toBeInTheDocument(): void;
  }
}

export const NOW = '2026-01-01T00:00:00.000Z';

export const item = (overrides: Partial<GoalListItem> = {}): GoalListItem => ({
  id: 'goal-1',
  projectId: 'project-1',
  projectName: 'Turing Terminal',
  title: 'Ship the importer',
  status: 'running',
  reasonCode: null,
  reasonDetail: null,
  needsUser: false,
  attention: [],
  paused: false,
  pendingApprovalCount: 0,
  currentDefinitionVersion: 1,
  activeMilestone: { key: 'm1', title: 'Parser', runtimeStatus: 'active' },
  lastCycle: {
    id: 'c1',
    sequence: 3,
    kind: 'execution',
    status: 'succeeded',
    triggerCode: 'scheduled',
    finishedAt: NOW,
  },
  nextAction: { kind: 'wait_for_turing' },
  integrationBranch: 'turing/goal-1',
  integrationHead: 'abcdef1234567890',
  openFindingCounts: { critical: 0, high: 0, medium: 1, low: 0 },
  usageSummary: { events: 4, inputTokens: 10, outputTokens: 5, meteredSpendUsd: 0 },
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

export const detail = (overrides: Partial<GoalDetail> = {}): GoalDetail => ({
  ...item(),
  approvedAt: NOW,
  startedAt: NOW,
  completedAt: null,
  baseBranch: 'main',
  baseCommit: '1111111111111',
  runtime: { cyclesExecuted: 3, consecutiveFailedCycles: 0, remediationAttempts: {}, activeMs: 120_000 },
  currentDefinition: null,
  proposedDefinition: null,
  definitions: [],
  milestones: [
    {
      key: 'm0',
      title: 'Scaffold',
      ordinal: 0,
      runtimeStatus: 'satisfied',
      satisfiedAt: NOW,
      evaluation: null,
    },
    {
      key: 'm1',
      title: 'Parser',
      ordinal: 1,
      runtimeStatus: 'active',
      satisfiedAt: null,
      evaluation: { state: 'open', blockers: ['criterion parse-ok unmet'] },
    },
    { key: 'm2', title: 'Writer', ordinal: 2, runtimeStatus: 'pending', satisfiedAt: null, evaluation: null },
  ],
  activeCycle: null,
  childRun: null,
  memory: null,
  pendingApprovals: [],
  completion: null,
  flags: { cycleActive: false, childRun: 'none', proposalRequired: false, userNeeded: false },
  ...overrides,
});

export const preview = (): GoalPreview => ({
  goalId: 'goal-1',
  status: 'running',
  reasonCode: null,
  definition: null,
  activeMilestone: null,
  runtime: detail().runtime,
  limits: null,
  integration: { branch: null, head: null, tree: null },
  currentCycle: null,
  routing: null,
  billing: null,
  proposalRequired: false,
  task: null,
  completion: null,
  blockers: [],
  pendingApprovals: [],
  openFindingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
  nextAction: { kind: 'wait_for_turing' },
});

export const evidenceRow = (overrides: Partial<GoalEvidenceView>): GoalEvidenceView => ({
  id: 'e1',
  kind: 'verifier_run',
  criterionKey: 'parse-ok',
  verifierDigest: 'd',
  verdict: 'satisfies',
  definitionVersion: 1,
  subject: {
    commit: 'aaaaaaaaaaaa',
    tree: 'bbbbbbbbbbbb',
    path: null,
    reviewedToCommit: null,
    reviewedToTree: null,
  },
  cycleId: null,
  runId: null,
  reviewId: null,
  recordedAt: NOW,
  freshness: 'current',
  ...overrides,
});

/** Keys are `/path` (any method) or `POST /path` (that method only; checked first). */
export type Routes = Record<string, (body?: unknown) => unknown>;
export let calls: Array<{
  url: string;
  method: string;
  path: string;
  body?: unknown;
  headers: Record<string, string>;
}>;
export const posts = () => calls.filter((call) => call.method !== 'GET');

export function serve(routes: Routes) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;
      const sent = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({
        url,
        method,
        path,
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        ...(sent !== undefined ? { body: sent } : {}),
      });
      const handler = routes[`${method} ${path}`] ?? routes[path];
      if (!handler) return new Response(JSON.stringify({ error: `no route ${path}` }), { status: 404 });
      const body = await handler(sent);
      return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

export const detailRoutes = (goal: GoalDetail, extra: Routes = {}): Routes => ({
  '/api/goals': () => ({ goals: [item()], total: 1, limit: 50 }),
  '/api/goals/goal-1': () => ({ goal }),
  '/api/goals/goal-1/preview': () => ({ preview: preview() }),
  '/api/approvals/unified': () => ({ approvals: [], total: 0, limit: 20 }),
  ...extra,
});

export async function openGoal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Ship the importer/ }));
}

export const refuse = (status: number, error: string, code: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error, code, ...extra }), { status });

/** A structurally complete definition document with a stored status/hash, for the definition-authority tests. */
export const definitionFull = (
  version: number,
  overrides: Partial<GoalDefinitionFull> = {},
): GoalDefinitionFull => ({
  version,
  parentVersion: version > 1 ? version - 1 : null,
  status: 'approved',
  definitionHash: `hash${version}${'0'.repeat(10)}`,
  changeSummary: `Change ${version}`,
  createdBy: 'user',
  createdAt: NOW,
  approvedAt: NOW,
  approvedBy: 'user',
  approvalId: null,
  goalId: 'goal-1',
  validation: { valid: true, errors: [], warnings: [] },
  definition: {
    contract: {
      outcome: `Outcome of version ${version}`,
      successCriteria: [],
      nonGoals: [],
      constraints: [],
      deliverables: [],
      completionPolicy: {
        requireFinalReview: true,
        requireUserAcceptance: false,
        applyToBase: 'required',
        maxOpenFindings: { critical: 0, high: 0 },
        highSeverityResolution: 'review-only',
      },
    },
    milestones: [],
    routing: {
      roles: {},
      pools: [],
      workflows: { planning: 'p', execution: 'e', review: 'r', verification: 'v' },
      independence: { finalReview: 'none', against: [], allowFloatingFinalReviewer: false },
    },
    review: {
      onMilestoneComplete: true,
      final: true,
      blocking: { periodic: false, milestone: true, final: true },
    },
    limits: {
      maxExecutionCycles: 10,
      maxConsecutiveFailedCycles: 3,
      maxRemediationAttempts: 3,
      maxActiveMinutes: 60,
      maxWallClockDays: 2,
      maxParallelAgents: 1,
      maxMeteredUsd: null,
      billingMode: 'subscriptions-only',
      humanGates: {
        eachCycle: false,
        beforeMilestoneComplete: false,
        poolRouteFirstUse: false,
        finalAcceptance: false,
      },
    },
  },
  ...overrides,
});
