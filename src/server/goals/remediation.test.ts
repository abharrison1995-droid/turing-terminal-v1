import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { GoalDefinition } from '../../shared/goals.js';
import { CycleError, createCycle, getCycle, transitionCycle, finalizeCycle } from './cycles.js';
import { approveDefinition, beginAmendment, loadDefinitionVersion } from './definitions.js';
import { decideFinding } from './findings.js';
import { buildGoalMemory } from './memory.js';
import {
  MAX_REMEDIATION_FINDINGS_PER_CYCLE,
  readRemediationPlan,
  remediationEpisodeKey,
  type RemediationPlan,
} from './remediationPlan.js';
import { determineRemediationPlan } from './remediationSelector.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  milestone,
  passDeterministic,
  simpleDefinition,
  type DefinitionOptions,
  type GoalRepoFixture,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { formatPlanningTask } from './goalPrompts.js';
import { openFinding, reviewWith } from './remediationKit.js';

afterEach(cleanupRepoFixtures);

const TWO = () => [milestone('m1', ['build']), milestone('m2', ['tests'])];

function fixture(options: DefinitionOptions = {}): GoalRepoFixture {
  const fx = goalRepoFixture({ definition: simpleDefinition({ milestones: TWO(), ...options }) });
  fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
  return fx;
}

const setActive = (fx: GoalRepoFixture, key: string | null) =>
  fx.db
    .prepare('UPDATE goals SET active_milestone_id = ? WHERE id = ?')
    .run(key === null ? null : fx.milestoneId(key), fx.goalId);

const current = (fx: GoalRepoFixture) => {
  const goal = fx.db
    .prepare('SELECT current_definition_version AS v FROM goals WHERE id = ?')
    .get(fx.goalId) as {
    v: number;
  };
  return loadDefinitionVersion(fx.db, fx.goalId, goal.v)!;
};
const select = (fx: GoalRepoFixture) => {
  const version = current(fx);
  return determineRemediationPlan(fx.db, fx.goalId, {
    definition: version.definition as GoalDefinition,
    version: version.version,
    tree: fx.tree(),
  });
};
const planOf = (fx: GoalRepoFixture): RemediationPlan => {
  const selection = select(fx);
  if (!selection.ok || !selection.plan) throw new Error(`no plan: ${JSON.stringify(selection)}`);
  return selection.plan;
};
const ids = (plan: RemediationPlan) => plan.episodes.map((episode) => episode.findingId);

describe('remediation candidate selection', () => {
  it(
    'critical and high open findings are threshold candidates, critical first; low and an unlimited medium are not',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      await openFinding(fx, 'low');
      await openFinding(fx, 'medium');
      const high = await openFinding(fx, 'high');
      const critical = await openFinding(fx, 'critical');
      const plan = planOf(fx);
      expect(ids(plan)).toEqual([critical, high]);
      expect(plan.episodes.map((episode) => episode.reason)).toEqual(['threshold', 'threshold']);
      expect(plan.milestoneKey).toBe('m1');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'medium findings are candidates only for the deterministic excess over a configured limit',
    async () => {
      const fx = fixture({ policy: { maxOpenFindings: { critical: 0, high: 0, medium: 1 } } });
      setActive(fx, 'm1');
      await openFinding(fx, 'medium');
      expect(select(fx)).toEqual({ ok: true, plan: null }); // equal to the limit
      await openFinding(fx, 'medium');
      // 2 open, 1 allowed: exactly the single oldest (created_at, then id) is selected.
      const oldest = () =>
        (
          fx.db
            .prepare("SELECT id FROM goal_findings WHERE status = 'open' ORDER BY created_at ASC, id ASC")
            .all() as Array<{ id: string }>
        ).map((row) => row.id);
      expect(ids(planOf(fx))).toEqual(oldest().slice(0, 1));
      await openFinding(fx, 'medium');
      // 3 open, 1 allowed: exactly the 2 oldest are selected (ties on created_at fall back to id).
      expect(ids(planOf(fx))).toEqual(oldest().slice(0, 2));
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a low finding qualifies only through a current blocking review, and a stale tree loses that authority',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      await openFinding(fx, 'low'); // non-blocking periodic review: not a candidate
      expect(select(fx)).toEqual({ ok: true, plan: null });
      const blocked = await openFinding(fx, 'low', { kind: 'milestone', milestone: 'm1', verdict: 'block' });
      const plan = planOf(fx);
      expect(plan.episodes).toMatchObject([{ findingId: blocked, reason: 'blocking_review' }]);
      fx.advance({ 'src/new.ts': 'export {};\n' }); // the reviewed tree is no longer current
      expect(select(fx)).toEqual({ ok: true, plan: null });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a threshold finding in a current blocking review has reason "both"',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      const high = await openFinding(fx, 'high', { kind: 'final', verdict: 'block' });
      expect(planOf(fx).episodes).toMatchObject([{ findingId: high, reason: 'both' }]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a blocking review of an older definition version keeps no special authority',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      await openFinding(fx, 'low', { kind: 'milestone', milestone: 'm1', verdict: 'block' });
      expect(planOf(fx).episodes).toHaveLength(1);
      fx.db.prepare("UPDATE goals SET status = 'running' WHERE id = ?").run(fx.goalId);
      const { version } = beginAmendment(fx.db, {
        goalId: fx.goalId,
        actor: 'user',
        definition: structuredClone(fx.definition),
      });
      approveDefinition(fx.db, { goalId: fx.goalId, version, actor: 'user' });
      expect(select(fx)).toEqual({ ok: true, plan: null });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'accepted, dismissed and resolved findings are never candidates',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      await passDeterministic(fx);
      const accepted = await openFinding(fx, 'high');
      const dismissed = await openFinding(fx, 'high');
      const resolved = await openFinding(fx, 'high');
      for (const [findingId, decision] of [
        [accepted, 'accepted_by_user'],
        [dismissed, 'dismissed_by_user'],
      ] as const)
        decideFinding(fx.db, {
          goalId: fx.goalId,
          findingId,
          decision,
          actor: 'user',
          approvalId: fx.approval('finding_decision', {
            findingId,
            decision,
            definitionVersion: 1,
            definitionHash: fx.currentHash(),
          }),
        });
      await reviewWith(fx, { existing: [{ goalFindingId: resolved, status: 'resolved' }] });
      const status = (id: string) =>
        (fx.db.prepare('SELECT status FROM goal_findings WHERE id = ?').get(id) as { status: string }).status;
      expect([status(accepted), status(dismissed), status(resolved)]).toEqual([
        'accepted_by_user',
        'dismissed_by_user',
        'resolved',
      ]);
      expect(select(fx)).toEqual({ ok: true, plan: null });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'selection is read-only',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      await openFinding(fx, 'high');
      const snapshot = () =>
        JSON.stringify([
          fx.db.prepare('SELECT COUNT(*) AS n FROM goal_cycles').get(),
          fx.db.prepare('SELECT COUNT(*) AS n FROM goal_events').get(),
          fx.db.prepare('SELECT COUNT(*) AS n FROM runs').get(),
          fx.db.prepare('SELECT COUNT(*) AS n FROM goal_approvals').get(),
          fx.db.prepare('SELECT status, updated_at FROM goal_findings').all(),
          fx.db.prepare('SELECT status, active_milestone_id FROM goals').all(),
        ]);
      const before = snapshot();
      expect(select(fx)).toEqual(select(fx));
      expect(snapshot()).toBe(before);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('remediation milestone anchoring', () => {
  it(
    'a milestone review anchors to its own milestone even when the active milestone is another',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      await openFinding(fx, 'high', { kind: 'milestone', milestone: 'm2', verdict: 'pass_with_findings' });
      expect(planOf(fx).milestoneKey).toBe('m2');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a broad review anchors to the persisted active milestone',
    async () => {
      const fx = fixture();
      setActive(fx, 'm2');
      await openFinding(fx, 'high', { kind: 'periodic' });
      expect(planOf(fx).milestoneKey).toBe('m2');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a satisfied milestone can be the anchor',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      fx.db.prepare("UPDATE goal_milestones SET status = 'satisfied' WHERE id = ?").run(fx.milestoneId('m1'));
      await openFinding(fx, 'high', { kind: 'final', verdict: 'pass_with_findings' });
      expect(planOf(fx).milestoneKey).toBe('m1');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'with no review milestone and no active milestone nothing is authorised, and no file or title is consulted',
    async () => {
      const fx = fixture();
      setActive(fx, null);
      const high = await openFinding(fx, 'high', { kind: 'final' });
      expect(select(fx)).toEqual({ ok: false, code: 'remediation_milestone_unavailable', findingId: high });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a review milestone that is no longer usable is never replaced by the active milestone',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      const high = await openFinding(fx, 'high', { kind: 'milestone', milestone: 'm2' });
      fx.db.prepare("UPDATE goal_milestones SET status = 'skipped' WHERE id = ?").run(fx.milestoneId('m2'));
      expect(select(fx)).toEqual({ ok: false, code: 'remediation_milestone_unavailable', findingId: high });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('remediation grouping and bounds of one plan', () => {
  it(
    'several candidates on one milestone form one group, capped at the per-cycle maximum, remainder stays eligible',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      for (let index = 0; index < MAX_REMEDIATION_FINDINGS_PER_CYCLE + 2; index += 1)
        await openFinding(fx, 'high');
      const ordered = (
        fx.db
          .prepare("SELECT id FROM goal_findings WHERE status = 'open' ORDER BY created_at ASC, id ASC")
          .all() as Array<{ id: string }>
      ).map((row) => row.id);
      const plan = planOf(fx);
      expect(plan.episodes).toHaveLength(MAX_REMEDIATION_FINDINGS_PER_CYCLE);
      expect(ids(plan)).toEqual(ordered.slice(0, MAX_REMEDIATION_FINDINGS_PER_CYCLE));
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'findings on different milestones are never mixed: only the highest-priority candidate milestone is scheduled',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      const onM2 = await openFinding(fx, 'critical', { kind: 'milestone', milestone: 'm2' });
      const broadHigh = await openFinding(fx, 'high', { kind: 'periodic' }); // anchors to m1
      const plan = planOf(fx);
      expect(plan.milestoneKey).toBe('m2');
      expect(ids(plan)).toEqual([onM2]);
      expect(ids(plan)).not.toContain(broadHigh);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('finding episode identity', () => {
  it(
    'is deterministic, timestamp-free, and changes with the last-seen review, definition and milestone',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      const findingId = await openFinding(fx, 'high');
      const first = planOf(fx).episodes[0]!;
      expect(planOf(fx).episodes[0]!.episodeKey).toBe(first.episodeKey);
      expect(first.episodeKey).toBe(
        remediationEpisodeKey({
          findingId,
          lastSeenReviewId: first.lastSeenReviewId,
          definitionVersion: 1,
          milestoneKey: 'm1',
        }),
      );
      const variants = [
        remediationEpisodeKey({
          findingId,
          lastSeenReviewId: 'other',
          definitionVersion: 1,
          milestoneKey: 'm1',
        }),
        remediationEpisodeKey({
          findingId,
          lastSeenReviewId: first.lastSeenReviewId,
          definitionVersion: 2,
          milestoneKey: 'm1',
        }),
        remediationEpisodeKey({
          findingId,
          lastSeenReviewId: first.lastSeenReviewId,
          definitionVersion: 1,
          milestoneKey: 'm2',
        }),
      ];
      expect(new Set([first.episodeKey, ...variants]).size).toBe(4);
      // A fresh review observation (still_open) moves the last-seen review and so creates a new episode.
      await reviewWith(fx, { existing: [{ goalFindingId: findingId, status: 'still_open' }] });
      const next = planOf(fx).episodes[0]!;
      expect(next.lastSeenReviewId).not.toBe(first.lastSeenReviewId);
      expect(next.episodeKey).not.toBe(first.episodeKey);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('write-once remediation plan on the cycle', () => {
  async function ready() {
    const fx = fixture();
    setActive(fx, 'm1');
    const findingId = await openFinding(fx, 'high');
    return { fx, findingId, plan: planOf(fx) };
  }
  const create = (
    fx: GoalRepoFixture,
    plan: RemediationPlan | undefined,
    over: Record<string, unknown> = {},
  ) =>
    createCycle(fx.db, {
      goalId: fx.goalId,
      kind: 'remediation',
      triggerCode: 'finding_remediation',
      milestoneKey: plan?.milestoneKey ?? 'm1',
      ...(plan ? { remediationPlan: plan } : {}),
      ...over,
    });

  it(
    'is persisted in the same INSERT as the cycle and recorded in the creation event',
    async () => {
      const { fx, plan } = await ready();
      const result = create(fx, plan);
      expect(result.created).toBe(true);
      const row = getCycle(fx.db, result.cycle.id)!;
      expect(row).toMatchObject({
        kind: 'remediation',
        triggerCode: 'finding_remediation',
        status: 'planned',
      });
      expect(readRemediationPlan(row.outcome)).toEqual(plan);
      const event = fx.db
        .prepare(
          "SELECT payload_json AS p FROM goal_events WHERE type = 'cycle_created' ORDER BY rowid DESC LIMIT 1",
        )
        .get() as { p: string };
      expect(JSON.parse(event.p)).toMatchObject({
        findingIds: ids(plan),
        episodeKeys: plan.episodes.map((episode) => episode.episodeKey),
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a finding_remediation cycle cannot exist without a plan, and no other cycle may carry one',
    async () => {
      const { fx, plan } = await ready();
      expect(() => create(fx, undefined)).toThrow(CycleError);
      expect(() => create(fx, plan, { triggerCode: 'next_task' })).toThrow(CycleError);
      expect(() => create(fx, plan, { kind: 'execution' })).toThrow(CycleError);
      expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_cycles').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses every corrupt plan at creation and writes nothing',
    async () => {
      const { fx, findingId, plan } = await ready();
      const first = plan.episodes[0]!;
      const rekey = (over: Partial<typeof first>, p: Partial<RemediationPlan> = {}): RemediationPlan => {
        const episode = { ...first, ...over };
        const merged = { ...plan, ...p };
        episode.episodeKey = remediationEpisodeKey({
          findingId: episode.findingId,
          lastSeenReviewId: episode.lastSeenReviewId,
          definitionVersion: merged.definitionVersion,
          milestoneKey: merged.milestoneKey,
        });
        return { ...merged, episodes: [episode] };
      };
      const corrupt: Array<[string, RemediationPlan, string?]> = [
        ['bad episode hash', { ...plan, episodes: [{ ...first, episodeKey: 'f'.repeat(64) }] }],
        ['duplicate finding', { ...plan, episodes: [first, first] }],
        ['wrong definition version', rekey({}, { definitionVersion: 2 })],
        ['wrong milestone for the cycle', rekey({}, { milestoneKey: 'm2' }), 'm1'],
        ['milestone that is not the finding anchor', rekey({}, { milestoneKey: 'm2' })],
        ['wrong lastSeenReviewId', rekey({ lastSeenReviewId: randomUUID() })],
        ['unknown finding', rekey({ findingId: randomUUID() })],
        [
          'oversized plan',
          { ...plan, episodes: Array.from({ length: MAX_REMEDIATION_FINDINGS_PER_CYCLE + 1 }, () => first) },
        ],
        ['extra key', { ...plan, extra: 1 } as never],
      ];
      for (const [name, bad, milestoneKey] of corrupt) {
        expect(() => create(fx, bad, { milestoneKey: milestoneKey ?? bad.milestoneKey }), name).toThrow(
          CycleError,
        );
      }
      // A user-decided finding cannot be remediated either.
      decideFinding(fx.db, {
        goalId: fx.goalId,
        findingId,
        decision: 'dismissed_by_user',
        actor: 'user',
        approvalId: fx.approval('finding_decision', {
          findingId,
          decision: 'dismissed_by_user',
          definitionVersion: 1,
          definitionHash: fx.currentHash(),
        }),
      });
      expect(() => create(fx, plan)).toThrow(CycleError);
      expect(fx.db.prepare('SELECT COUNT(*) AS n FROM goal_cycles').get()).toEqual({ n: 0 });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'later transitions can never replace, merge or mint a plan',
    async () => {
      const { fx, findingId, plan } = await ready();
      const other = await openFinding(fx, 'critical');
      const replacement: RemediationPlan = {
        ...plan,
        episodes: [
          {
            findingId: other,
            lastSeenReviewId: planOf(fx).episodes.find((entry) => entry.findingId === other)!
              .lastSeenReviewId,
            episodeKey: planOf(fx).episodes.find((entry) => entry.findingId === other)!.episodeKey,
            reason: 'threshold',
          },
        ],
      };
      expect(readRemediationPlan({ remediationPlan: replacement })).not.toBeNull(); // a perfectly valid, different plan
      const { cycle } = create(fx, plan) as { cycle: { id: string } };
      transitionCycle(fx.db, {
        cycleId: cycle.id,
        to: 'proposing',
        outcome: { remediationPlan: replacement, note: 1 },
      });
      const afterProposing = getCycle(fx.db, cycle.id)!;
      expect(readRemediationPlan(afterProposing.outcome)).toEqual(plan);
      expect(afterProposing.outcome).toMatchObject({ note: 1 });
      transitionCycle(fx.db, { cycleId: cycle.id, to: 'proposed', outcome: { remediationPlan: null } });
      expect(readRemediationPlan(getCycle(fx.db, cycle.id)!.outcome)).toEqual(plan);
      finalizeCycle(fx.db, {
        cycleId: cycle.id,
        to: 'failed',
        outcomeCode: 'x',
        detail: { remediationPlan: replacement },
      });
      const done = getCycle(fx.db, cycle.id)!;
      expect(readRemediationPlan(done.outcome)).toEqual(plan);
      expect(done.outcome).toMatchObject({ code: 'x' });
      expect(ids(plan)).toEqual([findingId]);
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a plan-less historical remediation cycle never gains authority from a later transition',
    async () => {
      const { fx, plan } = await ready();
      const { cycle } = createCycle(fx.db, {
        goalId: fx.goalId,
        kind: 'remediation',
        triggerCode: 'legacy_remediation',
        milestoneKey: 'm1',
      }) as { cycle: { id: string } };
      transitionCycle(fx.db, { cycleId: cycle.id, to: 'proposing', outcome: { remediationPlan: plan } });
      expect(getCycle(fx.db, cycle.id)!.outcome).toEqual({});
      expect(readRemediationPlan(getCycle(fx.db, cycle.id)!.outcome)).toBeNull();
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});

describe('remediation in Goal memory and the planner prompt', () => {
  it(
    'focused findings are listed first, before severity order and the open-finding cap, without duplicates',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      const focus = await openFinding(fx, 'low');
      for (let index = 0; index < 26; index += 1) await openFinding(fx, 'critical');
      const plain = buildGoalMemory(fx.db, fx.goalId);
      expect(plain.openFindings.map((entry) => entry.goalFindingId)).not.toContain(focus);
      const focused = buildGoalMemory(fx.db, fx.goalId, { focusFindingIds: [focus, focus] });
      expect(focused.openFindings[0]).toMatchObject({ goalFindingId: focus, severity: 'low' });
      expect(new Set(focused.openFindings.map((entry) => entry.goalFindingId)).size).toBe(
        focused.openFindings.length,
      );
      expect(focused.openFindings.length).toBeLessThanOrEqual(25);
      expect(focused.openFindings[1]!.severity).toBe('critical');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'only a remediation planning prompt says so; the ordinary execution prompt is unchanged',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      const memory = buildGoalMemory(fx.db, fx.goalId);
      const definition = current(fx).definition as GoalDefinition;
      const spec = definition.milestones[0]!;
      const ordinary = formatPlanningTask({ definition, milestone: spec, memory });
      expect(formatPlanningTask({ definition, milestone: spec, memory, purpose: 'execution' })).toBe(
        ordinary,
      );
      expect(ordinary).not.toContain('remediation planning cycle');
      expect(ordinary).toContain('Unresolved criteria for this milestone');
      const remediation = formatPlanningTask({ definition, milestone: spec, memory, purpose: 'remediation' });
      expect(remediation).toContain('This is a remediation planning cycle.');
      expect(remediation).toContain('Do not propose unrelated feature work.');
      expect(remediation).toContain('already reads satisfied');
      expect(remediation).toContain('Eligible criteria for this milestone');
      expect(remediation).not.toContain('Unresolved criteria for this milestone');
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'a remediation prompt shows an already-satisfied criterion as eligible',
    async () => {
      const fx = fixture();
      setActive(fx, 'm1');
      const memory = buildGoalMemory(fx.db, fx.goalId, {
        criterionStates: new Map([['build', 'satisfied' as const]]),
      });
      expect(memory.activeMilestone!.unresolvedCriteria).toEqual([]);
      const definition = current(fx).definition as GoalDefinition;
      const spec = definition.milestones[0]!;
      expect(formatPlanningTask({ definition, milestone: spec, memory })).toContain('(none)');
      expect(formatPlanningTask({ definition, milestone: spec, memory, purpose: 'remediation' })).toContain(
        'build: ',
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
