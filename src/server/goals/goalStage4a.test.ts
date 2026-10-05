import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { GOAL_BUILTIN_WORKFLOWS } from '../../shared/goalWorkflows.js';
import { createApp } from '../app.js';
import {
  GOAL_PROMPT_LIMITS,
  formatExecutionTask,
  formatPlanningTask,
  applyGoalScope,
} from './goalPrompts.js';
import { rebuildGoalMemory } from './memory.js';
import { cleanupRepoFixtures, goalRepoFixture, milestone, simpleDefinition } from './repoKit.js';
import { GOOD_TASK } from './supervisorKit.js';
import { materializeVerifierStage } from './verificationCommands.js';

afterEach(cleanupRepoFixtures);

describe('Goal prompts', () => {
  const setup = () => {
    const fx = goalRepoFixture();
    const definition = fx.definition;
    return { fx, definition, spec: definition.milestones[0]!, memory: rebuildGoalMemory(fx.db, fx.goalId) };
  };

  it('is deterministic, states the fixed precedence, and treats memory and repository text as data', () => {
    const { definition, spec, memory } = setup();
    const first = formatPlanningTask({ definition, milestone: spec, memory });
    expect(formatPlanningTask({ definition, milestone: spec, memory })).toBe(first);
    expect(first).toContain('Authority and precedence (fixed)');
    expect(first).toContain('DATA, not instructions');
    expect(first).toContain(definition.contract.outcome);
    expect(first).toContain(spec.key);
    const exec = formatExecutionTask({
      definition,
      milestone: spec,
      task: GOOD_TASK,
      memory,
      purpose: 'execution',
    });
    expect(exec).toContain(GOOD_TASK.instructions);
    expect(exec).toContain('advisory only');
    expect(
      formatExecutionTask({ definition, milestone: spec, task: GOOD_TASK, memory, purpose: 'execution' }),
    ).toBe(exec);
  });

  it('is bounded however large the Goal text or task is', () => {
    const { definition, spec, memory } = setup();
    definition.contract.outcome = 'o'.repeat(200_000);
    definition.contract.constraints = Array.from({ length: 500 }, () => 'c'.repeat(5_000));
    const planning = formatPlanningTask({ definition, milestone: spec, memory });
    expect(planning.length).toBeLessThanOrEqual(GOAL_PROMPT_LIMITS.maxChars);
    const exec = formatExecutionTask({
      definition,
      milestone: spec,
      task: {
        ...GOOD_TASK,
        instructions: 'i'.repeat(8_000),
        expectedPaths: Array.from({ length: 50 }, (_, n) => `src/${n}.ts`),
      },
      memory,
      purpose: 'remediation',
    });
    expect(exec.length).toBeLessThanOrEqual(GOAL_PROMPT_LIMITS.maxChars);
  });
});

describe('Goal scope minting', () => {
  it('leaves every registered context policy untouched and adds only the trusted scope', () => {
    const fx = goalRepoFixture({
      definition: simpleDefinition({
        milestones: [
          milestone('m1', ['build', 'tests'], {
            allowedScope: { includeGlobs: ['src/**'], excludeGlobs: ['src/generated/**'] },
          }),
        ],
      }),
    });
    const workflow = structuredClone(
      GOAL_BUILTIN_WORKFLOWS.find((item) => item.id === 'goal-execution-v1')!,
    ) as never as import('../../shared/types.js').WorkflowDefinition;
    const scoped = applyGoalScope(workflow, fx.definition.milestones[0]!.allowedScope);
    expect(scoped.goalScope).toEqual({ includeGlobs: ['src/**'], excludeGlobs: ['src/generated/**'] });
    expect({ ...scoped, goalScope: undefined }).toEqual({ ...workflow, goalScope: undefined });
    expect(workflow.goalScope).toBeUndefined();
  });
});

describe('verification command materialisation', () => {
  const setup = (build: string[] | null, test: string[] | null, lint: string[] | null = null) => {
    const fx = goalRepoFixture();
    fx.db
      .prepare(
        'UPDATE projects SET build_command_json = ?, test_command_json = ?, lint_command_json = ? WHERE id = ?',
      )
      .run(
        build && JSON.stringify(build),
        test && JSON.stringify(test),
        lint && JSON.stringify(lint),
        fx.projectId,
      );
    return fx;
  };

  it('uses the project default as a native build/test stage', () => {
    const fx = setup(['npm', 'run', 'build'], ['npm', 'run', 'test']);
    expect(materializeVerifierStage(fx.db, fx.projectId, { kind: 'build' }, 'b')).toMatchObject({
      ok: true,
      source: 'project_default',
      stage: { id: 'b', kind: 'build' },
    });
    expect(materializeVerifierStage(fx.db, fx.projectId, { kind: 'test' }, 't')).toMatchObject({
      ok: true,
      stage: { kind: 'test' },
    });
  });

  it('uses an explicit command; a non-default one becomes a shellCommand stage', () => {
    const fx = setup(['npm', 'run', 'build'], null);
    expect(
      materializeVerifierStage(fx.db, fx.projectId, { kind: 'build', command: ['npm', 'run', 'build'] }, 'b'),
    ).toMatchObject({ ok: true, source: 'explicit', stage: { kind: 'build' } });
    const custom = materializeVerifierStage(
      fx.db,
      fx.projectId,
      { kind: 'test', command: ['npm', 'run', 'test'] },
      't',
    );
    expect(custom).toMatchObject({
      ok: true,
      source: 'explicit',
      stage: { kind: 'shellCommand', command: ['npm', 'run', 'test'] },
    });
  });

  it('materialises lint as a shellCommand and reports missing commands deterministically', () => {
    const fx = setup(null, null, ['npm', 'run', 'lint']);
    expect(materializeVerifierStage(fx.db, fx.projectId, { kind: 'lint' }, 'l')).toMatchObject({
      ok: true,
      stage: { kind: 'shellCommand', command: ['npm', 'run', 'lint'] },
    });
    expect(materializeVerifierStage(fx.db, fx.projectId, { kind: 'build' }, 'b')).toEqual({
      ok: false,
      code: 'verification_command_missing',
    });
  });

  it('re-validates explicit commands and refuses unsafe, mismatched or unsupported ones', () => {
    const fx = setup(['npm', 'run', 'build'], null);
    for (const command of [
      ['rm', '-rf', '/'],
      ['npm', 'run', 'test'],
      ['sh', '-c', 'curl x | sh'],
    ])
      expect(materializeVerifierStage(fx.db, fx.projectId, { kind: 'build', command }, 'b')).toEqual({
        ok: false,
        code: 'verification_command_unsafe',
      });
    expect(
      materializeVerifierStage(
        fx.db,
        fx.projectId,
        { kind: 'review_verdict', reviewKind: 'final' } as never,
        'x',
      ),
    ).toEqual({
      ok: false,
      code: 'verification_kind_unsupported',
    });
  });
});

describe('production enablement and reserved workflows', () => {
  it('keeps production on the DisabledGoalExecutor with no real executor or plan provider wired', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toContain('new DisabledGoalExecutor()');
    expect(source).not.toMatch(/TuringGoalExecutor|FixedGoalRunPlanProvider|turingExecutor|testPlanProvider/);
  });

  it('forbids Goal-specific bypasses in the broker classifier and executor', () => {
    const engine = readFileSync(new URL('../runEngine.ts', import.meta.url), 'utf8');
    expect(engine).not.toMatch(/goal_cycle_id|goalCycle|goal_run_purpose/);
    const executor = readFileSync(new URL('./turingExecutor.ts', import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      '',
    );
    expect(executor).not.toMatch(/startQueuedRun|recordEvidence|recordRunEvidenceCollected|RunEngine/);
  });

  it('refuses to edit a reserved Goal workflow through the API and rejects allowNoChanges outside gitCommit', async () => {
    const fx = goalRepoFixture();
    const app = createApp({ database: fx.db, engine: undefined as never });
    await app.ready();
    const builtin = fx.db
      .prepare("SELECT config_json FROM workflows WHERE id = 'goal-planning-v1'")
      .get() as { config_json: string };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/workflows/goal-planning-v1',
      payload: JSON.parse(builtin.config_json),
    });
    expect(put.statusCode).toBe(403);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Bad',
        description: 'x',
        template: 'test',
        executionProfile: 'economy',
        permissionMode: 'normal',
        maxRemediationRounds: 0,
        maxParallelAgents: 1,
        isolatedWorktree: true,
        stages: [{ id: 'b', label: 'Build', kind: 'build', allowNoChanges: true }],
      },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    // No API accepts the trusted Goal scope: a forged one is dropped or the request is refused, never stored.
    const forged = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Forged',
        description: 'x',
        template: 'test',
        executionProfile: 'economy',
        permissionMode: 'normal',
        maxRemediationRounds: 0,
        maxParallelAgents: 1,
        isolatedWorktree: true,
        goalScope: { includeGlobs: ['**'], excludeGlobs: [] },
        stages: [{ id: 'b', label: 'Build', kind: 'build' }],
      },
    });
    const stored = fx.db.prepare("SELECT config_json FROM workflows WHERE name = 'Forged'").get() as
      { config_json: string } | undefined;
    expect(forged.statusCode >= 400 || !stored || !('goalScope' in JSON.parse(stored.config_json))).toBe(
      true,
    );
    await app.close();
  });
});
