import { afterEach, describe, expect, it } from 'vitest';
import type { EvidenceVerdict, GoalDefinition } from '../../shared/goals.js';
import { approveDefinition, beginAmendment } from './definitions.js';
import { GoalEvidenceError, recordEvidence, recordUserConfirmationEvidence } from './evidence.js';
import { listGoalEvents } from './events.js';
import { evaluateCriteria } from './freshness.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  milestone,
  simpleDefinition,
  type GoalRepoFixture,
} from './repoKit.js';
import { createRepositoryReader, resolveGoalRepository } from './repository.js';

afterEach(cleanupRepoFixtures);

async function evaluate(fx: GoalRepoFixture, version = 1) {
  const resolved = await resolveGoalRepository(fx.db, fx.goalId);
  if (!resolved.ok) throw new Error(resolved.detail);
  const row = fx.db
    .prepare('SELECT * FROM goal_definition_versions WHERE goal_id = ? AND version = ?')
    .get(fx.goalId, version) as Record<string, string>;
  const definition: GoalDefinition = {
    contract: JSON.parse(row.contract_json!),
    milestones: JSON.parse(row.milestones_json!),
    routing: JSON.parse(row.routing_json!),
    review: JSON.parse(row.review_json!),
    limits: JSON.parse(row.limits_json!),
  };
  return evaluateCriteria(fx.db, fx.goalId, definition, createRepositoryReader(resolved.state));
}
const state = async (fx: GoalRepoFixture, key: string, version = 1) =>
  (await evaluate(fx, version)).find((criterion) => criterion.key === key)!.state;

let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

const build = (fx: GoalRepoFixture, tree: string, verdict: EvidenceVerdict = 'satisfies') =>
  recordEvidence(fx.db, {
    goalId: fx.goalId,
    definitionVersion: 1,
    criterionKey: 'build',
    verifierDigest: fx.digest('build'),
    kind: 'build_result',
    verdict,
    subjectTree: tree,
    now: at(),
  });

describe('recordEvidence validation', () => {
  it('records build evidence with the verifier digest, tree and an event', async () => {
    const fx = goalRepoFixture();
    const { id } = await build(fx, fx.tree());
    expect(
      fx.db
        .prepare('SELECT kind, verdict, subject_tree, verifier_digest FROM goal_evidence WHERE id = ?')
        .get(id),
    ).toEqual({
      kind: 'build_result',
      verdict: 'satisfies',
      subject_tree: fx.tree(),
      verifier_digest: fx.digest('build'),
    });
    expect(listGoalEvents(fx.db, fx.goalId).at(-1)).toMatchObject({
      type: 'evidence_recorded',
      payload: { evidenceId: id, criterionKey: 'build', kind: 'build_result', verdict: 'satisfies' },
    });
  });

  const base = (fx: GoalRepoFixture) => ({
    goalId: fx.goalId,
    definitionVersion: 1,
    criterionKey: 'build',
    verifierDigest: fx.digest('build'),
    kind: 'build_result' as const,
    verdict: 'satisfies' as const,
    subjectTree: fx.tree(),
  });
  const refused = async (fx: GoalRepoFixture, over: Record<string, unknown>, code: string) => {
    const before = fx.db.prepare('SELECT COUNT(*) AS n FROM goal_evidence').get();
    await expect(recordEvidence(fx.db, { ...base(fx), ...over } as never)).rejects.toMatchObject({ code });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_evidence').get()).toEqual(before);
  };

  it('refuses a caller-made verifier digest, wrong criterion, unknown version and unknown Goal', async () => {
    const fx = goalRepoFixture();
    await refused(fx, { verifierDigest: 'f'.repeat(64) }, 'verifier_unknown');
    await refused(fx, { verifierDigest: fx.digest('tests') }, 'verifier_unknown');
    await refused(fx, { criterionKey: 'ghost' }, 'criterion_unknown');
    await refused(fx, { definitionVersion: 9 }, 'definition_not_found');
    await refused(fx, { goalId: 'ghost' }, 'goal_not_found');
  });

  it('refuses evidence of the wrong kind for the verifier, run_result, and generated user confirmation', async () => {
    const fx = goalRepoFixture();
    await refused(fx, { kind: 'test_result' }, 'evidence_kind_mismatch');
    await refused(fx, { kind: 'run_result' }, 'run_result_not_verifier');
    await refused(fx, { kind: 'user_confirmation' }, 'user_authority_required');
  });

  it('refuses a subject tree or commit that is not a real object, and a proposed definition', async () => {
    const fx = goalRepoFixture();
    await refused(fx, { subjectTree: 'a'.repeat(40) }, 'subject_invalid');
    await refused(fx, { subjectTree: 'not-a-sha' }, 'subject_invalid');
    await refused(fx, { subjectTree: fx.head() }, 'subject_invalid'); // a commit is not a tree
    await refused(fx, { subjectCommit: fx.tree() }, 'subject_invalid'); // a tree is not a commit
    const { version } = beginAmendment(fx.db, { goalId: fx.goalId, actor: 'user' });
    await refused(fx, { definitionVersion: version }, 'definition_not_decided');
  });

  it('checks cycle, run, stage and milestone ownership', async () => {
    const fx = goalRepoFixture();
    const other = goalRepoFixture();
    other.db
      .prepare(
        "INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, created_at) VALUES ('oc', ?, 1, 1, 'execution', 't', 'planned', '2026-01-01T00:00:00Z')",
      )
      .run(other.goalId);
    fx.db
      .prepare(
        "INSERT INTO goal_cycles (id, goal_id, definition_version, sequence, kind, trigger_code, status, created_at) VALUES ('c1', ?, 1, 1, 'execution', 't', 'planned', '2026-01-01T00:00:00Z')",
      )
      .run(fx.goalId);
    await refused(fx, { cycleId: 'oc' }, 'cycle_not_found');
    await refused(fx, { cycleId: 'nope' }, 'cycle_not_found');
    await refused(fx, { milestoneId: other.milestoneId('m1') }, 'milestone_not_found');
    await refused(fx, { runId: 'ghost' }, 'run_not_in_goal');
    await refused(fx, { stageId: 'ghost' }, 'stage_not_in_run');
    const { id } = await recordEvidence(fx.db, {
      ...base(fx),
      cycleId: 'c1',
      milestoneId: fx.milestoneId('m1'),
    });
    expect(fx.db.prepare('SELECT cycle_id, milestone_id FROM goal_evidence WHERE id = ?').get(id)).toEqual({
      cycle_id: 'c1',
      milestone_id: fx.milestoneId('m1'),
    });
  });

  it('keeps recorded evidence immutable', async () => {
    const fx = goalRepoFixture();
    const { id } = await build(fx, fx.tree());
    expect(() =>
      fx.db.prepare("UPDATE goal_evidence SET verdict = 'contradicts' WHERE id = ?").run(id),
    ).toThrow(/immutable/);
    expect(() => fx.db.prepare('DELETE FROM goal_evidence WHERE id = ?').run(id)).toThrow(
      /cannot be deleted/,
    );
  });
});

describe('build, test and lint evidence freshness', () => {
  it('counts at the tree it was produced for and goes stale when the Goal advances', async () => {
    const fx = goalRepoFixture();
    const treeA = fx.tree();
    await build(fx, treeA);
    expect(await state(fx, 'build')).toBe('satisfied');
    const b = fx.advance({ 'src/b.ts': 'export const b = 1;\n' });
    expect(b.tree).not.toBe(treeA);
    expect(await state(fx, 'build')).toBe('stale');
    const evaluated = (await evaluate(fx)).find((criterion) => criterion.key === 'build')!;
    expect(evaluated.verifiers[0]!.evidence[0]).toMatchObject({ standing: 'stale', reason: 'tree_changed' });
    expect(evaluated.satisfiedBy).toEqual([]);
    await build(fx, b.tree);
    expect(await state(fx, 'build')).toBe('satisfied');
  });

  it('is missing before any evidence exists', async () => {
    const fx = goalRepoFixture();
    expect(await state(fx, 'build')).toBe('missing');
    expect(await state(fx, 'tests')).toBe('missing');
  });

  it('lets a newer contradiction override an older pass and a later fresh pass repair it', async () => {
    const fx = goalRepoFixture();
    const tree = fx.tree();
    await build(fx, tree, 'satisfies');
    expect(await state(fx, 'build')).toBe('satisfied');
    await build(fx, tree, 'contradicts');
    expect(await state(fx, 'build')).toBe('contradicted');
    await build(fx, tree, 'satisfies');
    expect(await state(fx, 'build')).toBe('satisfied');
    await build(fx, tree, 'inconclusive');
    expect(await state(fx, 'build')).toBe('inconclusive');
  });

  it('breaks recorded_at ties by insertion order', async () => {
    const fx = goalRepoFixture();
    const tree = fx.tree();
    const now = '2026-02-02T00:00:00.000Z';
    for (const verdict of ['satisfies', 'contradicts'] as const)
      await recordEvidence(fx.db, {
        goalId: fx.goalId,
        definitionVersion: 1,
        criterionKey: 'build',
        verifierDigest: fx.digest('build'),
        kind: 'build_result',
        verdict,
        subjectTree: tree,
        now,
      });
    expect(await state(fx, 'build')).toBe('contradicted');
  });

  it('does not treat a failure at an older tree as a contradiction at a newer one', async () => {
    const fx = goalRepoFixture();
    await build(fx, fx.tree(), 'contradicts');
    fx.advance({ 'src/c.ts': 'c' });
    expect(await state(fx, 'build')).toBe('stale');
  });

  it('is unaffected by uncommitted changes in the user checkout', async () => {
    const fx = goalRepoFixture();
    await build(fx, fx.tree());
    await import('node:fs').then((fs) => fs.writeFileSync(`${fx.repo}/src/parser.ts`, 'dirty\n'));
    expect(await state(fx, 'build')).toBe('satisfied');
  });

  it('requires every verifier of a criterion and reports the worst state', async () => {
    const fx = goalRepoFixture({
      definition: simpleDefinition({
        criteria: [
          {
            key: 'both',
            statement: 's',
            required: true,
            verification: [{ kind: 'build', command: ['npm', 'run', 'build'] }, { kind: 'test' }],
          },
        ],
        milestones: [milestone('m1', ['both'])],
      }),
    });
    const tree = fx.tree();
    await recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: 'both',
      verifierDigest: fx.digest('both', 0),
      kind: 'build_result',
      verdict: 'satisfies',
      subjectTree: tree,
      now: at(),
    });
    expect(await state(fx, 'both')).toBe('missing');
    await recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: 'both',
      verifierDigest: fx.digest('both', 1),
      kind: 'test_result',
      verdict: 'contradicts',
      subjectTree: tree,
      now: at(),
    });
    expect(await state(fx, 'both')).toBe('contradicted');
    await recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: 'both',
      verifierDigest: fx.digest('both', 1),
      kind: 'test_result',
      verdict: 'satisfies',
      subjectTree: tree,
      now: at(),
    });
    expect(await state(fx, 'both')).toBe('satisfied');
    const evaluated = (await evaluate(fx))[0]!;
    expect(evaluated.satisfiedBy).toHaveLength(2);
  });
});

describe('definition amendments and verifier digests', () => {
  it('stales old evidence when the verifier changes and keeps it when the verifier is unchanged', async () => {
    const fx = goalRepoFixture();
    await build(fx, fx.tree());
    await recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: 'tests',
      verifierDigest: fx.digest('tests'),
      kind: 'test_result',
      verdict: 'satisfies',
      subjectTree: fx.tree(),
      now: at(),
    });

    const amended = structuredClone(fx.definition);
    amended.contract.successCriteria[1]!.verification = [{ kind: 'test', command: ['pnpm', 'run', 'test'] }];
    amended.limits.maxExecutionCycles = 30;
    fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
    const { version } = beginAmendment(fx.db, { goalId: fx.goalId, actor: 'user', definition: amended });
    approveDefinition(fx.db, { goalId: fx.goalId, version, actor: 'user' });

    // The build verifier is unchanged, so its version-1 evidence still counts; the test verifier changed, so it does not.
    expect(await state(fx, 'build', 2)).toBe('satisfied');
    expect(await state(fx, 'tests', 2)).toBe('missing');
    expect(fx.digest('tests', 0, 2)).not.toBe(fx.digest('tests', 0, 1));
    expect(fx.digest('build', 0, 2)).toBe(fx.digest('build', 0, 1));
    // Old evidence is not mutated.
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_evidence').get()).toEqual({ n: 2 });
  });
});

describe('artifact evidence', () => {
  const docDefinition = () =>
    simpleDefinition({
      criteria: [
        {
          key: 'doc',
          statement: 'README exists',
          required: true,
          verification: [{ kind: 'file_exists', path: 'docs/README.md' }],
        },
      ],
      milestones: [milestone('m1', ['doc'])],
    });
  const record = (fx: GoalRepoFixture) =>
    recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: 'doc',
      verifierDigest: fx.digest('doc'),
      kind: 'artifact',
      now: at(),
    });

  it('persists path, blob id and sha256 from Git at the integration head, and stays fresh while unchanged', async () => {
    const fx = goalRepoFixture({ definition: docDefinition() });
    const { id } = await record(fx);
    const row = fx.db.prepare('SELECT * FROM goal_evidence WHERE id = ?').get(id) as Record<string, string>;
    expect(row).toMatchObject({
      kind: 'artifact',
      verdict: 'satisfies',
      subject_path: 'docs/README.md',
      subject_blob: fx.git('rev-parse', 'HEAD:docs/README.md'),
      subject_commit: fx.head(),
      subject_tree: fx.tree(),
    });
    expect(row.subject_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await state(fx, 'doc')).toBe('satisfied');
    fx.advance({ 'src/other.ts': 'o' });
    expect(await state(fx, 'doc')).toBe('satisfied'); // same content at the new head
  });

  it('reads the Goal commit, not the dirty working copy', async () => {
    const fx = goalRepoFixture({ definition: docDefinition() });
    await import('node:fs').then((fs) => fs.writeFileSync(`${fx.repo}/docs/README.md`, 'uncommitted\n'));
    const { id } = await record(fx);
    expect(fx.db.prepare('SELECT subject_blob FROM goal_evidence WHERE id = ?').get(id)).toEqual({
      subject_blob: fx.git('rev-parse', 'HEAD:docs/README.md'),
    });
  });

  it('goes stale when the blob changes or the file is deleted', async () => {
    const fx = goalRepoFixture({ definition: docDefinition() });
    await record(fx);
    fx.advance({ 'docs/README.md': '# changed\n' });
    expect(await state(fx, 'doc')).toBe('stale');
    expect((await evaluate(fx))[0]!.verifiers[0]!.evidence[0]).toMatchObject({ reason: 'path_changed' });
    const fx2 = goalRepoFixture({ definition: docDefinition() });
    await record(fx2);
    fx2.advance({ 'docs/README.md': null });
    expect((await evaluate(fx2))[0]!.verifiers[0]!.evidence[0]).toMatchObject({
      standing: 'stale',
      reason: 'path_missing',
    });
  });

  it('records a missing file as a contradiction that holds only while the file stays absent', async () => {
    const fx = goalRepoFixture({ definition: docDefinition() });
    fx.advance({ 'docs/README.md': null });
    const { id } = await record(fx);
    expect(fx.db.prepare('SELECT verdict, subject_blob FROM goal_evidence WHERE id = ?').get(id)).toEqual({
      verdict: 'contradicts',
      subject_blob: null,
    });
    expect(await state(fx, 'doc')).toBe('contradicted');
    fx.advance({ 'docs/README.md': 'back\n' });
    expect(await state(fx, 'doc')).toBe('stale');
  });

  it('refuses a verifier path outside the project and never follows symlinks', async () => {
    const fx = goalRepoFixture({ definition: docDefinition() });
    // A tampered stored verifier cannot be recorded against: the digest must match the stored definition.
    await expect(
      recordEvidence(fx.db, {
        goalId: fx.goalId,
        definitionVersion: 1,
        criterionKey: 'doc',
        verifierDigest: 'x'.repeat(64),
        kind: 'artifact',
      }),
    ).rejects.toMatchObject({ code: 'verifier_unknown' });
    fx.git('config', 'core.symlinks', 'true');
    await import('node:fs').then((fs) => {
      fs.rmSync(`${fx.repo}/docs/README.md`);
      fs.symlinkSync('/etc/hostname', `${fx.repo}/docs/README.md`);
    });
    fx.git('add', '-A');
    fx.git('commit', '-q', '-m', 'symlink');
    const commit = fx.git('rev-parse', 'HEAD');
    fx.git('update-ref', `refs/heads/turing/goal/${fx.goalId}`, commit);
    fx.db.prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?').run(commit, fx.goalId);
    const { id } = await record(fx);
    expect(fx.db.prepare('SELECT verdict FROM goal_evidence WHERE id = ?').get(id)).toEqual({
      verdict: 'contradicts',
    });
  });

  it('refuses a verifier path that escapes the project when the stored definition is corrupt', async () => {
    const def = docDefinition();
    const fx = goalRepoFixture({ definition: def });
    expect(await state(fx, 'doc')).toBe('missing');
  });

  it('resolves paths relative to a project subfolder of the repository', async () => {
    const fx = goalRepoFixture({ definition: docDefinition(), subdir: 'packages/app' });
    expect(fx.git('ls-tree', '-r', '--name-only', 'HEAD')).toContain('packages/app/docs/README.md');
    const { id } = await record(fx);
    expect(fx.db.prepare('SELECT subject_blob FROM goal_evidence WHERE id = ?').get(id)).toEqual({
      subject_blob: fx.git('rev-parse', 'HEAD:packages/app/docs/README.md'),
    });
    expect(await state(fx, 'doc')).toBe('satisfied');
  });
});

describe('commit evidence', () => {
  const definition = () =>
    simpleDefinition({
      criteria: [
        {
          key: 'landed',
          statement: 'Commit landed',
          required: true,
          verification: [{ kind: 'commit_on_branch' }],
        },
      ],
      milestones: [milestone('m1', ['landed'])],
    });
  const record = (fx: GoalRepoFixture, commit: string) =>
    recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: 'landed',
      verifierDigest: fx.digest('landed'),
      kind: 'commit',
      verdict: 'satisfies',
      subjectCommit: commit,
      now: at(),
    });

  it('counts while the commit is an ancestor of, or equal to, the integration head', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    const a = fx.advance({ 'src/a.ts': 'a' });
    await record(fx, a.commit);
    expect(await state(fx, 'landed')).toBe('satisfied');
    fx.advance({ 'src/b.ts': 'b' });
    expect(await state(fx, 'landed')).toBe('satisfied');
  });

  it('does not count a commit that is not in the Goal history', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    const side = fx.sideCommit({ 'src/side.ts': 's' });
    await record(fx, side);
    expect(await state(fx, 'landed')).toBe('stale');
    expect((await evaluate(fx))[0]!.verifiers[0]!.evidence[0]).toMatchObject({ reason: 'not_ancestor' });
    const orphan = fx.orphanCommit();
    await record(fx, orphan);
    expect(await state(fx, 'landed')).toBe('stale');
  });

  it('stops counting when the Goal ref is rewound past the commit', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    const initial = fx.head();
    const a = fx.advance({ 'src/a.ts': 'a' });
    await record(fx, a.commit);
    fx.git('update-ref', `refs/heads/turing/goal/${fx.goalId}`, initial);
    fx.db.prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?').run(initial, fx.goalId);
    expect(await state(fx, 'landed')).toBe('stale');
  });
});

describe('user confirmation evidence', () => {
  const definition = () =>
    simpleDefinition({
      criteria: [
        {
          key: 'ux-any',
          statement: 's',
          required: true,
          verification: [{ kind: 'user_confirmation', prompt: 'Looks right?', freshness: 'any' }],
        },
        {
          key: 'ux-head',
          statement: 's',
          required: true,
          verification: [{ kind: 'user_confirmation', prompt: 'Still right?', freshness: 'head-bound' }],
        },
      ],
      milestones: [milestone('m1', ['ux-any', 'ux-head'])],
    });
  const detail = (fx: GoalRepoFixture, key: string, extra: Record<string, unknown> = {}) => ({
    criterionKey: key,
    verifierDigest: fx.digest(key),
    definitionVersion: 1,
    definitionHash: fx.currentHash(),
    ...extra,
  });
  const confirm = (fx: GoalRepoFixture, key: string, approvalId: string) =>
    recordUserConfirmationEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: key,
      verifierDigest: fx.digest(key),
      approvalId,
      actor: 'user',
      now: at(),
    });

  it('stays current across repository changes when freshness is any', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    const { id, reused } = await confirm(
      fx,
      'ux-any',
      fx.approval('user_confirmation', detail(fx, 'ux-any')),
    );
    expect(reused).toBe(false);
    expect(
      fx.db.prepare('SELECT kind, verdict, subject_tree, ref_json FROM goal_evidence WHERE id = ?').get(id),
    ).toMatchObject({
      kind: 'user_confirmation',
      verdict: 'satisfies',
      subject_tree: null,
    });
    expect(await state(fx, 'ux-any')).toBe('satisfied');
    fx.advance({ 'src/x.ts': 'x' });
    expect(await state(fx, 'ux-any')).toBe('satisfied');
  });

  it('binds a head-bound confirmation to the tree and stales it after a change', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    const approval = fx.approval('user_confirmation', detail(fx, 'ux-head', { integrationTree: fx.tree() }));
    const { id } = await confirm(fx, 'ux-head', approval);
    expect(fx.db.prepare('SELECT subject_tree FROM goal_evidence WHERE id = ?').get(id)).toEqual({
      subject_tree: fx.tree(),
    });
    expect(await state(fx, 'ux-head')).toBe('satisfied');
    fx.advance({ 'src/x.ts': 'x' });
    expect(await state(fx, 'ux-head')).toBe('stale');
  });

  it('refuses a head-bound approval for a tree other than the current one', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    const old = fx.tree();
    fx.advance({ 'src/x.ts': 'x' });
    await expect(
      confirm(
        fx,
        'ux-head',
        fx.approval('user_confirmation', detail(fx, 'ux-head', { integrationTree: old })),
      ),
    ).rejects.toMatchObject({ code: 'approval_invalid' });
  });

  it('is idempotent per approval', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    const approval = fx.approval('user_confirmation', detail(fx, 'ux-any'));
    const first = await confirm(fx, 'ux-any', approval);
    const second = await confirm(fx, 'ux-any', approval);
    expect(second).toEqual({ id: first.id, reused: true });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_evidence').get()).toEqual({ n: 1 });
  });

  it('records a user denial as a contradiction', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    await confirm(fx, 'ux-any', fx.approval('user_confirmation', detail(fx, 'ux-any'), 'denied'));
    expect(await state(fx, 'ux-any')).toBe('contradicted');
  });

  it('cannot be created by a model, the supervisor or the system, or without a bound user approval', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    const good = fx.approval('user_confirmation', detail(fx, 'ux-any'));
    for (const actor of ['model', 'supervisor', 'system'])
      await expect(
        recordUserConfirmationEvidence(fx.db, {
          goalId: fx.goalId,
          definitionVersion: 1,
          criterionKey: 'ux-any',
          verifierDigest: fx.digest('ux-any'),
          approvalId: good,
          actor: actor as never,
        }),
      ).rejects.toMatchObject({ code: 'user_authority_required' });
    const bad: Array<[string, string]> = [
      ['wrong gate', fx.approval('start', detail(fx, 'ux-any'))],
      ['other criterion', fx.approval('user_confirmation', detail(fx, 'ux-head'))],
      ['other hash', fx.approval('user_confirmation', { ...detail(fx, 'ux-any'), definitionHash: 'h' })],
      ['other version', fx.approval('user_confirmation', { ...detail(fx, 'ux-any'), definitionVersion: 2 })],
      ['other digest', fx.approval('user_confirmation', { ...detail(fx, 'ux-any'), verifierDigest: 'd' })],
      ['unknown approval', 'ghost'],
    ];
    for (const [name, approvalId] of bad)
      await expect(confirm(fx, 'ux-any', approvalId), name).rejects.toBeInstanceOf(GoalEvidenceError);
    // A pending approval and a system denial are not user decisions either.
    const pending = (await import('./approvals.js')).requestGoalApproval(fx.db, {
      goalId: fx.goalId,
      gate: 'user_confirmation',
      risk: 'low',
      reason: 'r',
      requestedBy: 'supervisor',
      detail: detail(fx, 'ux-any'),
    });
    await expect(confirm(fx, 'ux-any', pending.id)).rejects.toMatchObject({ code: 'approval_invalid' });
    (await import('./approvals.js')).decideGoalApproval(fx.db, {
      goalId: fx.goalId,
      approvalId: pending.id,
      decision: 'denied',
      decidedBy: 'system',
    });
    await expect(confirm(fx, 'ux-any', pending.id)).rejects.toMatchObject({ code: 'approval_invalid' });
    expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_evidence').get()).toEqual({ n: 0 });
  });

  it('does not count forged confirmation evidence that has no user approval behind it', async () => {
    const fx = goalRepoFixture({ definition: definition() });
    fx.db
      .prepare(
        `INSERT INTO goal_evidence (id, goal_id, definition_version, criterion_key, verifier_digest, kind, verdict, ref_json, recorded_at)
       VALUES ('forged', ?, 1, 'ux-any', ?, 'user_confirmation', 'satisfies', '{}', '2026-03-03T00:00:00Z')`,
      )
      .run(fx.goalId, fx.digest('ux-any'));
    expect(await state(fx, 'ux-any')).toBe('stale');
    expect((await evaluate(fx))[0]!.verifiers[0]!.evidence[0]).toMatchObject({ reason: 'approval_missing' });
  });

  it('keeps run_result evidence from satisfying anything', async () => {
    const fx = goalRepoFixture();
    fx.db
      .prepare(
        `INSERT INTO goal_evidence (id, goal_id, definition_version, criterion_key, verifier_digest, kind, verdict, ref_json, recorded_at)
       VALUES ('rr', ?, 1, 'build', ?, 'run_result', 'satisfies', '{}', '2026-03-03T00:00:00Z')`,
      )
      .run(fx.goalId, fx.digest('build'));
    expect(await state(fx, 'build')).toBe('missing');
    expect((await evaluate(fx))[0]!.verifiers[0]!.evidence[0]).toMatchObject({
      standing: 'ineligible',
      reason: 'kind_mismatch',
    });
  });
});

describe('Goal ref consistency', () => {
  it('makes repository evidence unusable when the Goal ref no longer equals the recorded head', async () => {
    const fx = goalRepoFixture();
    await build(fx, fx.tree());
    fx.git('commit', '-q', '--allow-empty', '-m', 'outside');
    fx.git('update-ref', `refs/heads/turing/goal/${fx.goalId}`, fx.git('rev-parse', 'HEAD'));
    const resolved = await resolveGoalRepository(fx.db, fx.goalId);
    expect(resolved).toMatchObject({ ok: false, code: 'goal_ref_changed' });
  });
});
