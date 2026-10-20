import { describe, expect, it } from 'vitest';
import { DEFAULT_JEV_MODEL, validateDecisionGate } from '../../../shared/decisions';
import type { WorkflowStage } from '../../../shared/types';
import {
  ADD_STAGE_GROUPS,
  defaultDecisionConfig,
  defaultJevConfig,
  kindChangePatch,
  roleForKind,
  stageForKind,
} from './stageFactory';

const optionFor = (id: string) =>
  ADD_STAGE_GROUPS.flatMap((group) => group.options).find((option) => option.id === id)!;

describe('Add stage menu', () => {
  it('groups every stage type once and offers a direct Decision gate choice for JEV', () => {
    const options = ADD_STAGE_GROUPS.flatMap((group) => group.options);
    expect(new Set(options.map((option) => option.id)).size).toBe(options.length);
    expect(ADD_STAGE_GROUPS.map((group) => group.label)).toEqual([
      'Plan and prepare',
      'Build and verify',
      'Review',
      'Decide and route',
      'Git',
    ]);
    expect(optionFor('decision-jev')).toMatchObject({ kind: 'decisionGate', preset: 'jev' });
    const kinds = new Set(options.map((option) => option.kind));
    for (const kind of [
      'planner',
      'promptRefinement',
      'implementer',
      'build',
      'test',
      'reviewer',
      'parallelReview',
      'consolidate',
      'orchestrator',
      'remediation',
      'finalGate',
      'gitCheckpoint',
      'gitCommit',
      'gitPush',
      'gitMerge',
      'gitRollback',
      'conditionalBranch',
      'shellCommand',
      'notification',
      'humanApproval',
      'decisionGate',
    ])
      expect(kinds.has(kind as never), kind).toBe(true);
  });
});

describe('new stages', () => {
  it('creates an enabled stage with a unique id and the right role', () => {
    const reviewer = stageForKind(optionFor('reviewer'));
    expect(reviewer).toMatchObject({ kind: 'reviewer', role: 'reviewer', enabled: true, label: 'Reviewer' });
    expect(stageForKind(optionFor('build')).role).toBeUndefined();
    expect(stageForKind(optionFor('promptRefinement')).role).toBe('prompt-refinement');
    const taken = [reviewer.id];
    expect(stageForKind(optionFor('reviewer'), taken).id).not.toBe(reviewer.id);
  });

  it('adds a JEV gate that names an exact model but selects no connection, cap or permission', () => {
    const stage = stageForKind(optionFor('decision-jev'));
    expect(stage.label).toBe('JEV decision');
    expect(stage.decision).toMatchObject({ engine: 'jev-openrouter', modelId: DEFAULT_JEV_MODEL });
    expect(stage.decision?.connectionProfileId).toBeUndefined();
    expect(stage.decision?.modelId).not.toMatch(/latest|auto|~/);
    expect(stage.decision?.inputs).toEqual(['tests', 'build']);
    expect(stage).not.toHaveProperty('billingLane');
    expect(stage).not.toHaveProperty('connectionProfileId');
  });

  it('keeps JEV out of the deterministic default and reports the connection as the missing setup', () => {
    expect(defaultDecisionConfig().engine).toBe('deterministic-rules');
    const errors = validateDecisionGate(defaultJevConfig(), 'JEV decision', []);
    expect(errors).toEqual(['Decision Gate “JEV decision”: select an OpenRouter connection explicitly.']);
  });

  it('keeps the UNCERTAIN route explicit and routes on probability, not confidence', () => {
    const { routing } = defaultJevConfig();
    expect(routing.field).toBe('probability');
    expect(routing.onUncertain).toEqual({ action: 'human-approval' });
  });

  it('starts conditional branches, scripts and pushes with the fields the server requires', () => {
    expect(stageForKind(optionFor('conditionalBranch')).condition).toEqual({
      path: 'build.success',
      operator: 'equals',
      value: true,
    });
    expect(stageForKind(optionFor('shellCommand')).command).toEqual(['npm', 'run', 'test']);
    expect(stageForKind(optionFor('gitPush')).pushRemote).toBe('origin');
    expect(stageForKind(optionFor('gitRollback')).rollbackTarget).toBe('runStart');
    expect(stageForKind(optionFor('parallelReview')).parallelism).toBe(1);
  });
});

describe('changing a stage type', () => {
  const base: WorkflowStage = {
    id: 's',
    label: 'Gate',
    kind: 'decisionGate',
    decision: defaultJevConfig(),
    enabled: true,
  };

  it('clears configuration the new type does not use', () => {
    const patch = kindChangePatch(base, 'reviewer');
    expect(patch.decision).toBeUndefined();
    expect(patch.role).toBe('reviewer');
    expect(kindChangePatch(base, 'gitCommit').commitMessage).toBe('');
  });

  it('keeps an existing decision when staying a decision gate', () => {
    expect(kindChangePatch(base, 'decisionGate').decision).toBe(base.decision);
  });

  it('derives roles', () => {
    expect(roleForKind('reviewer', 'custom')).toBe('custom');
    expect(roleForKind('test', 'custom')).toBeUndefined();
  });
});
