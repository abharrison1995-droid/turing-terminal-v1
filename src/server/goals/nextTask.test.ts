import { describe, expect, it } from 'vitest';
import { milestone, simpleDefinition } from './repoKit.js';
import { NEXT_TASK_LIMITS, validateNextTask } from './nextTask.js';

const definition = simpleDefinition({
  milestones: [
    milestone('m1', ['build'], { allowedScope: { includeGlobs: ['src/**'], excludeGlobs: ['src/gen/**'] } }),
    milestone('m2', ['tests']),
  ],
});
const context = { definition, activeMilestone: definition.milestones[0]!, cycleKind: 'execution' as const };
const good = () => ({
  milestoneKey: 'm1',
  title: 'Add the parser',
  instructions: 'Implement the parser in src/parser.ts.',
  targetCriteria: ['build'],
  expectedPaths: ['src/parser.ts'],
  rationale: 'The build criterion needs a parser.',
});
const issuesOf = (input: unknown) => {
  const result = validateNextTask(input, context);
  return result.ok ? [] : result.issues.map((issue) => `${issue.code}:${issue.path}`);
};

describe('NextTask validation', () => {
  it('accepts a proposal for the active milestone and defaults the workflow to the approved execution workflow', () => {
    const result = validateNextTask(good(), context);
    expect(result).toMatchObject({ ok: true, task: { workflowId: definition.routing.workflows.execution } });
  });

  it('rejects unknown fields, non-objects and every authority-bearing field by name', () => {
    expect(issuesOf('text')).toEqual(['not_an_object:']);
    expect(issuesOf([])).toEqual(['not_an_object:']);
    expect(issuesOf({ ...good(), surprise: 1 })).toEqual(['unknown_field:']);
    for (const field of [
      'provider',
      'model',
      'route',
      'billingLane',
      'permissionMode',
      'limits',
      'definition',
      'ref',
      'shell',
      'command',
      'reviewPolicy',
    ])
      expect(issuesOf({ ...good(), [field]: 'x' })).toEqual([`forbidden_field:${field}`]);
  });

  it('bounds every text field and the lists', () => {
    expect(issuesOf({ ...good(), title: '' })).toContain('malformed:title');
    expect(issuesOf({ ...good(), title: 'x'.repeat(NEXT_TASK_LIMITS.title + 1) })).toContain(
      'malformed:title',
    );
    expect(issuesOf({ ...good(), instructions: 'x'.repeat(NEXT_TASK_LIMITS.instructions + 1) })).toContain(
      'malformed:instructions',
    );
    expect(issuesOf({ ...good(), targetCriteria: [] })).toContain('malformed:targetCriteria');
    expect(
      issuesOf({
        ...good(),
        expectedPaths: Array.from({ length: NEXT_TASK_LIMITS.maxPaths + 1 }, (_, i) => `src/${i}.ts`),
      }),
    ).toContain('malformed:expectedPaths');
  });

  it('requires the active milestone, its own criteria, no duplicates and a permitted workflow', () => {
    expect(issuesOf({ ...good(), milestoneKey: 'm2' })).toEqual(['milestone_not_active:milestoneKey']);
    expect(issuesOf({ ...good(), targetCriteria: ['tests'] })).toEqual([
      'criterion_not_owned:targetCriteria.0',
    ]);
    expect(issuesOf({ ...good(), targetCriteria: ['build', 'build'] })).toContain(
      'duplicate_criterion:targetCriteria.1',
    );
    expect(issuesOf({ ...good(), workflowId: 'wf-review' })).toEqual(['workflow_not_permitted:workflowId']);
    expect(
      validateNextTask({ ...good(), workflowId: definition.routing.workflows.execution }, context).ok,
    ).toBe(true);
  });

  it('requires safe project-relative paths inside the milestone scope', () => {
    expect(issuesOf({ ...good(), expectedPaths: ['../outside.ts'] })).toEqual([
      'path_unsafe:expectedPaths.0',
    ]);
    expect(issuesOf({ ...good(), expectedPaths: ['/etc/passwd'] })).toEqual(['path_unsafe:expectedPaths.0']);
    expect(issuesOf({ ...good(), expectedPaths: ['.git/config'] })).toEqual(['path_unsafe:expectedPaths.0']);
    expect(issuesOf({ ...good(), expectedPaths: ['docs/readme.md'] })).toEqual([
      'path_out_of_scope:expectedPaths.0',
    ]);
    expect(issuesOf({ ...good(), expectedPaths: ['src/gen/a.ts'] })).toEqual([
      'path_out_of_scope:expectedPaths.0',
    ]);
  });

  it('refuses secrets in any text field without echoing them', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
    const result = validateNextTask({ ...good(), instructions: `use ${secret}` }, context);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(issuesOf({ ...good(), rationale: `token ${secret}` })).toContain('secret_detected:rationale');
  });
});
