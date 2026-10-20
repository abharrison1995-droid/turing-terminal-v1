import { describe, expect, it } from 'vitest';
import { defaultJevConfig } from './stageFactory';
import { describeAssignment, stageIssues, workflowProblems } from './stageIssues';
import { makeConnection, makeProvider, makeStage, makeWorkflow } from './testFixtures';

const go = makeProvider('opencode', [{ id: 'opencode-go/coder', name: 'Coder', providerId: 'opencode-go' }]);
const openrouter = makeProvider('openrouter', [
  { id: 'typesafe/jev-1.13', name: 'Jev 1.13', providerId: 'openrouter', family: 'decision' },
]);
const connection = makeConnection();
const orConnection = makeConnection({
  id: 'conn-or',
  name: 'OpenRouter decisions',
  backendId: 'openrouter',
  providerId: 'openrouter',
  billingLane: 'openrouter-metered',
  credentials: { inference: true, management: false },
});

const context = (workflow = makeWorkflow(), connections = [connection]) => ({
  workflow,
  providers: [go, openrouter],
  connections,
});

describe('stage configuration issues', () => {
  it('reports a missing connection and model without expanding anything', () => {
    const workflow = makeWorkflow();
    const issues = stageIssues(workflow.stages[0]!, 0, context(workflow));
    expect(issues.map((issue) => [issue.severity, issue.message, issue.fix])).toEqual([
      ['blocking', 'Choose a connection.', 'connection'],
      ['blocking', 'Choose a model.', 'model'],
    ]);
  });

  it('is clean when a saved connection and a listed model are assigned', () => {
    const stage = makeStage({
      connectionProfileId: 'conn-go',
      backendId: 'opencode',
      providerId: 'opencode-go',
      billingLane: 'opencode-go-subscription',
      modelId: 'opencode-go/coder',
    });
    expect(stageIssues(stage, 0, context(makeWorkflow({ stages: [stage] })))).toEqual([]);
  });

  it('counts inherited workflow defaults as an assignment', () => {
    const workflow = makeWorkflow({
      defaultModelConfiguration: {
        connectionProfileId: 'conn-go',
        backendId: 'opencode',
        providerId: 'opencode-go',
        billingLane: 'opencode-go-subscription',
        modelId: 'opencode-go/coder',
      },
    });
    expect(stageIssues(workflow.stages[0]!, 0, context(workflow))).toEqual([]);
  });

  it('flags a connection that was deleted and a model the catalogue no longer lists', () => {
    const stage = makeStage({
      connectionProfileId: 'gone',
      backendId: 'opencode',
      providerId: 'opencode-go',
      billingLane: 'opencode-go-subscription',
      modelId: 'opencode-go/retired',
    });
    const messages = stageIssues(stage, 0, context(makeWorkflow({ stages: [stage] }))).map(
      (issue) => issue.message,
    );
    expect(messages[0]).toMatch(/no longer exists/);
    expect(messages.some((message) => /not in the current catalogue/.test(message))).toBe(true);
  });

  it('applies the billing gate: a metered lane is blocked in Subscriptions Only', () => {
    const stage = makeStage({
      backendId: 'openrouter',
      providerId: 'openrouter',
      billingLane: 'openrouter-metered',
      modelId: 'vendor/model',
    });
    const issues = stageIssues(stage, 0, context(makeWorkflow({ stages: [stage] })));
    expect(issues[0]).toMatchObject({ severity: 'blocking' });
    expect(issues[0]!.message).toMatch(/blocked by Subscriptions Only/);
  });

  it('reports nothing for a disabled stage and for stages that need no model', () => {
    expect(stageIssues(makeStage({ enabled: false }), 0, context())).toEqual([]);
    expect(stageIssues(makeStage({ kind: 'build', role: undefined }), 0, context())).toEqual([]);
  });

  it('summarises a JEV gate’s missing setup as one blocking line', () => {
    const stage = makeStage({ kind: 'decisionGate', role: undefined, decision: defaultJevConfig() });
    const issues = stageIssues(stage, 0, context(makeWorkflow({ stages: [stage] })));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toMatch(/2 setup items missing: openrouter connection, billing mode/i);
    expect(issues[0]!.fix).toBe('decision');
  });

  it('is clean once the JEV prerequisites are all met', () => {
    const stage = makeStage({
      kind: 'decisionGate',
      role: undefined,
      decision: { ...defaultJevConfig(), connectionProfileId: 'conn-or' },
    });
    const workflow = makeWorkflow({
      stages: [stage],
      billingMode: 'subscriptions-plus-decision-budget',
      subscriptionOnly: true,
      meteredBudget: { perRunUsd: 0.05, unknownCostPolicy: 'block' },
    });
    expect(stageIssues(stage, 0, context(workflow, [connection, orConnection]))).toEqual([]);
  });
});

describe('assignment summaries', () => {
  it('names a saved connection, or a route with no saved connection, or nothing', () => {
    const workflow = makeWorkflow();
    expect(
      describeAssignment(makeStage({ connectionProfileId: 'conn-go', modelId: 'm' }), workflow, [connection]),
    ).toEqual({ connection: 'OpenCode Go', model: 'm' });
    expect(
      describeAssignment(
        makeStage({
          backendId: 'cline',
          providerId: 'cline-pass',
          billingLane: 'clinepass-subscription',
          modelDisplayName: 'Cline model',
        }),
        workflow,
        [],
      ),
    ).toEqual({ connection: 'ClinePass · no saved connection', model: 'Cline model' });
    expect(describeAssignment(makeStage(), workflow, [])).toEqual({
      connection: 'No connection',
      model: 'No model',
    });
  });
});

describe('workflow-level problems', () => {
  it('reports git stages without worktree isolation and misplaced prompt refinement', () => {
    const problems = workflowProblems(
      makeWorkflow({
        isolatedWorktree: false,
        stages: [
          makeStage({ id: 'a' }),
          makeStage({ id: 'b', kind: 'promptRefinement', role: 'prompt-refinement' }),
          makeStage({ id: 'c', kind: 'gitCommit', role: undefined }),
        ],
      }),
    ).map((problem) => problem.message);
    expect(problems).toEqual([
      'Prompt refinement must be the first enabled stage.',
      'Git stages need worktree isolation. Turn it on under Safety and billing.',
    ]);
  });

  it('reports an empty workflow', () => {
    expect(workflowProblems(makeWorkflow({ stages: [] }))[0]!.message).toMatch(/at least one stage/);
  });
});
