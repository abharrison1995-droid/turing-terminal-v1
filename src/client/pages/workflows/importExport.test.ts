import { describe, expect, it } from 'vitest';
import { api } from '../../api';
import { prepareImportedWorkflow } from './importExport';
import { defaultJevConfig } from './stageFactory';
import { makeConnection, makeStage, makeWorkflow } from './testFixtures';

const go = makeConnection();
const openrouter = makeConnection({
  id: 'conn-or',
  name: 'OpenRouter',
  backendId: 'openrouter',
  providerId: 'openrouter',
  billingLane: 'openrouter-metered',
});

describe('workflow export and import', () => {
  it('round-trips a stage’s route onto the matching local connection and exports no connection ID', () => {
    const workflow = makeWorkflow({
      stages: [
        makeStage({
          connectionProfileId: 'other-machine-id',
          backendId: 'opencode',
          providerId: 'opencode-go',
          billingLane: 'opencode-go-subscription',
          modelId: 'opencode-go/coder',
        }),
      ],
    });
    const exported = api.exportWorkflows([workflow]);
    expect(JSON.stringify(exported)).not.toContain('other-machine-id');
    const imported = prepareImportedWorkflow(JSON.parse(JSON.stringify(exported)), [go]);
    expect(imported.stages[0]).toMatchObject({
      connectionProfileId: 'conn-go',
      modelId: 'opencode-go/coder',
    });
    expect(imported).toMatchObject({ id: '', version: 1, isDefault: false });
  });

  it('leaves the connection empty, and keeps the route, when no local connection matches', () => {
    const workflow = makeWorkflow({
      stages: [
        makeStage({
          connectionProfileId: 'x',
          backendId: 'cline',
          providerId: 'cline-pass',
          billingLane: 'clinepass-subscription',
          modelId: 'm',
        }),
      ],
    });
    const imported = prepareImportedWorkflow(JSON.parse(JSON.stringify(api.exportWorkflows([workflow]))), [
      go,
    ]);
    expect(imported.stages[0]!.connectionProfileId).toBeUndefined();
    expect(imported.stages[0]).toMatchObject({ backendId: 'cline', providerId: 'cline-pass' });
  });

  it('keeps a saved JEV model version exactly and never invents a connection or alias', () => {
    const gate = makeStage({
      kind: 'decisionGate',
      role: undefined,
      decision: { ...defaultJevConfig(), modelId: 'typesafe/jev-1.12', connectionProfileId: 'old' },
    });
    const exported = JSON.parse(JSON.stringify(api.exportWorkflows([makeWorkflow({ stages: [gate] })])));
    const imported = prepareImportedWorkflow(exported, [go]);
    expect(imported.stages[0]!.decision).toMatchObject({
      engine: 'jev-openrouter',
      modelId: 'typesafe/jev-1.12',
    });
    expect(imported.stages[0]!.decision!.connectionProfileId).toBeUndefined();
    const withOpenRouter = prepareImportedWorkflow(exported, [go, openrouter]);
    expect(withOpenRouter.stages[0]!.decision!.connectionProfileId).toBe('conn-or');
    expect(withOpenRouter.stages[0]!.decision!.modelId).toBe('typesafe/jev-1.12');
  });

  it('does not add a decision gate to a workflow that had none', () => {
    const imported = prepareImportedWorkflow(
      JSON.parse(JSON.stringify(api.exportWorkflows([makeWorkflow()]))),
      [go],
    );
    expect(imported.stages.some((stage) => stage.kind === 'decisionGate')).toBe(false);
  });

  it('accepts the older single-workflow shape and rejects other files', () => {
    expect(prepareImportedWorkflow({ workflow: makeWorkflow() }, []).name).toBe('Fixture delivery');
    expect(() => prepareImportedWorkflow({} as never, [])).toThrow(/does not contain a workflow/);
  });
});
