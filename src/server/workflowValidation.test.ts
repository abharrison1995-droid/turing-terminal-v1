import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOWS } from '../shared/workflows.js';
import { applyExecutionProfile, validateWorkflow } from './workflowValidation.js';

describe('workflow validation', () => {
  it('accepts every shipped default workflow', () => {
    for (const workflow of DEFAULT_WORKFLOWS) {
      expect(validateWorkflow(workflow)).toEqual([]);
    }
  });

  it('keeps prompt refinement optional, unique, and before other enabled stages', () => {
    const common = { maxParallelAgents: 1, maxRemediationRounds: 0, isolatedWorktree: false };
    const refinement = { id: 'refine', label: 'Refine task', kind: 'promptRefinement' as const };
    expect(
      validateWorkflow({
        ...common,
        promptRefinementDefault: true,
        stages: [refinement, { id: 'work', label: 'Work', kind: 'implementer' }],
      }),
    ).toEqual([]);
    expect(
      validateWorkflow({
        ...common,
        promptRefinementDefault: true,
        stages: [{ ...refinement, enabled: false }],
      }).join(' '),
    ).toContain('Enable a configured prompt refinement stage');
    expect(
      validateWorkflow({
        ...common,
        stages: [{ id: 'work', label: 'Work', kind: 'implementer' }, refinement],
      }).join(' '),
    ).toContain('must be the first enabled workflow stage');
    expect(
      validateWorkflow({
        ...common,
        stages: [refinement, { ...refinement, id: 'refine-again' }],
      }).join(' '),
    ).toContain('at most one prompt refinement stage');
  });

  it('requires remediation to be bounded and followed by a reviewer', () => {
    const workflow = {
      maxParallelAgents: 2,
      maxRemediationRounds: 1,
      stages: [{ id: 'fix', label: 'Fix', kind: 'remediation' as const, enabled: true }],
    };
    expect(validateWorkflow(workflow).join(' ')).toContain('enabled reviewer stage');
    expect(validateWorkflow({ ...workflow, maxRemediationRounds: 0 }).join(' ')).toContain(
      'at least one remediation round',
    );
  });

  it('caps parallel review according to the selected profile and workflow limit', () => {
    const stages = [{ id: 'review', label: 'Review', kind: 'parallelReview' as const, parallelism: 7 }];
    expect(applyExecutionProfile(stages, 'economy', 6)[0]?.parallelism).toBe(1);
    expect(applyExecutionProfile(stages, 'balanced', 6)[0]?.parallelism).toBe(2);
    expect(applyExecutionProfile(stages, 'maximum', 3)[0]?.parallelism).toBe(3);
  });

  it('requires forward-only targets and a typed condition for conditional stages', () => {
    const workflow = {
      maxParallelAgents: 1,
      maxRemediationRounds: 0,
      stages: [
        { id: 'branch', label: 'Branch', kind: 'conditionalBranch' as const, skipStageIds: ['missing'] },
        { id: 'work', label: 'Work', kind: 'implementer' as const },
      ],
    };
    const errors = validateWorkflow(workflow).join(' ');
    expect(errors).toContain('needs a structured condition');
    expect(errors).toContain('unknown stage');
    expect(
      validateWorkflow({
        ...workflow,
        stages: [
          {
            id: 'branch',
            label: 'Branch',
            kind: 'conditionalBranch' as const,
            condition: { path: 'build.success' as const, operator: 'equals' as const, value: true },
            skipStageIds: ['branch'],
          },
        ],
      }).join(' '),
    ).toContain('only skip later stages');
  });

  it('limits shell command workflow stages to the project script allowlist', () => {
    const workflow = {
      maxParallelAgents: 1,
      maxRemediationRounds: 0,
      stages: [
        { id: 'shell', label: 'Run', kind: 'shellCommand' as const, command: ['bash', '-c', 'rm -rf /'] },
      ],
    };
    expect(validateWorkflow(workflow).join(' ')).toContain('allowed package build, test, or lint script');
  });

  it('requires isolated worktrees and ordered commit/checkpoint prerequisites for Git operations', () => {
    const common = { maxParallelAgents: 1, maxRemediationRounds: 0 };
    const stages = [
      { id: 'merge', label: 'Merge', kind: 'gitMerge' as const },
      {
        id: 'restore',
        label: 'Restore',
        kind: 'gitRollback' as const,
        rollbackTarget: 'latestCheckpoint' as const,
      },
    ];
    const errors = validateWorkflow({ ...common, isolatedWorktree: false, stages }).join(' ');
    expect(errors).toContain('require isolated worktree execution');
    expect(errors).toContain('needs an earlier enabled commit stage');
    expect(errors).toContain('needs an earlier enabled Git checkpoint');

    expect(
      validateWorkflow({
        ...common,
        isolatedWorktree: true,
        stages: [
          { id: 'checkpoint', label: 'Checkpoint', kind: 'gitCheckpoint' as const },
          { id: 'commit', label: 'Commit', kind: 'gitCommit' as const },
          { id: 'merge', label: 'Merge', kind: 'gitMerge' as const },
        ],
      }),
    ).toEqual([]);
  });

  it('rejects unsafe push destinations and commit messages', () => {
    const errors = validateWorkflow({
      maxParallelAgents: 1,
      maxRemediationRounds: 0,
      isolatedWorktree: true,
      stages: [
        { id: 'commit', label: 'Commit', kind: 'gitCommit', commitMessage: 'x'.repeat(121) },
        { id: 'push', label: 'Push', kind: 'gitPush', pushRemote: '-origin', pushBranch: '../main' },
      ],
    }).join(' ');
    expect(errors).toContain('commit message must be at most 120 characters');
    expect(errors).toContain('invalid remote name');
    expect(errors).toContain('invalid destination branch');
  });
});
