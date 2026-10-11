import { afterEach, describe, expect, it } from 'vitest';
import { hashGoalDefinition } from './definitionHash.js';
import {
  getCompletionPolicyProjection,
  parseCompletionPolicy,
  validateApprovedCompletionPolicyLineage,
} from './completionPolicy.js';
import { approveDefinition, beginAmendment, editProposedDefinition } from './definitions.js';
import {
  cleanupRepoFixtures,
  goalRepoFixture,
  passDeterministic,
  simpleDefinition,
  REAL_GIT_TEST_TIMEOUT_MS,
} from './repoKit.js';
import { validateGoalDefinition } from './definitionValidation.js';
import { validDefinition } from './testKit.js';
import { checkCompletionProof, evaluateCompletion } from './completionEvaluation.js';

afterEach(cleanupRepoFixtures);

function v2Definition() {
  const definition = simpleDefinition({
    policy: {
      completionContractVersion: 2,
      integrationMode: 'external_user_attested',
      requireFinalReview: true,
      requireUserAcceptance: true,
      applyToBase: 'required',
    },
  });
  definition.review.final = true;
  return definition;
}

function rewriteApprovedContract(
  fx: ReturnType<typeof goalRepoFixture>,
  version: number,
  mutate: (contract: Record<string, unknown>) => void,
) {
  const row = fx.db
    .prepare('SELECT contract_json FROM goal_definition_versions WHERE goal_id = ? AND version = ?')
    .get(fx.goalId, version) as { contract_json: string };
  const contract = JSON.parse(row.contract_json) as Record<string, unknown>;
  mutate(contract);
  // These explicit test-only SQL changes model storage corruption; production immutability triggers stay untouched.
  fx.db.exec('DROP TRIGGER trg_goal_definition_immutable;');
  fx.db
    .prepare('UPDATE goal_definition_versions SET contract_json = ? WHERE goal_id = ? AND version = ?')
    .run(JSON.stringify(contract), fx.goalId, version);
}

describe('versioned completion policy', () => {
  it('preserves absent-discriminator legacy policy parsing and the accepted v1 definition hash', () => {
    const original = validDefinition();
    expect(Object.hasOwn(original.contract.completionPolicy, 'completionContractVersion')).toBe(false);
    expect(Object.hasOwn(original.contract.completionPolicy, 'integrationMode')).toBe(false);
    expect(parseCompletionPolicy(original.contract.completionPolicy)).toEqual({
      kind: 'valid',
      mode: 'legacy_v1',
    });
    expect(hashGoalDefinition(original)).toBe(
      'e3df3cae46c17f1f38c1f9976fe9bd02eea14ce68323cf7d844d324f5823e2ff',
    );

    const reloaded = JSON.parse(JSON.stringify(original));
    expect(hashGoalDefinition(reloaded)).toBe(hashGoalDefinition(original));
    expect(Object.hasOwn(reloaded.contract.completionPolicy, 'completionContractVersion')).toBe(false);
    expect(Object.hasOwn(reloaded.contract.completionPolicy, 'integrationMode')).toBe(false);

    const versioned = v2Definition();
    expect(parseCompletionPolicy(versioned.contract.completionPolicy)).toEqual({
      kind: 'valid',
      mode: 'external_user_attested_v2',
    });
    expect(hashGoalDefinition(versioned)).not.toBe(hashGoalDefinition(original));
  });

  it('refuses partial, explicit-v1, unsupported, and weakened versioned policy combinations', () => {
    const cases: unknown[] = [
      { ...validDefinition().contract.completionPolicy, completionContractVersion: 2 },
      { ...validDefinition().contract.completionPolicy, integrationMode: 'external_user_attested' },
      {
        ...validDefinition().contract.completionPolicy,
        completionContractVersion: 1,
        integrationMode: 'external_user_attested',
      },
      {
        ...validDefinition().contract.completionPolicy,
        completionContractVersion: 3,
        integrationMode: 'external_user_attested',
      },
      { ...v2Definition().contract.completionPolicy, applyToBase: 'leave-on-goal-branch' },
      { ...v2Definition().contract.completionPolicy, requireFinalReview: false },
      { ...v2Definition().contract.completionPolicy, requireUserAcceptance: false },
      { ...v2Definition().contract.completionPolicy, integrationMode: 'turing_managed' },
    ];
    for (const policy of cases) {
      expect(parseCompletionPolicy(policy).kind).toBe('invalid_or_unsupported');
      const definition = validDefinition();
      definition.contract.completionPolicy = policy as typeof definition.contract.completionPolicy;
      expect(validateGoalDefinition(definition).valid).toBe(false);
    }
  });

  it(
    'fails closed on a malformed stored policy without throwing or accepting an earlier proof',
    async () => {
      const fx = goalRepoFixture();
      const earlier = await evaluateCompletion(fx.db, fx.goalId);
      fx.db.exec('DROP TRIGGER trg_goal_definition_immutable;');
      fx.db
        .prepare('UPDATE goal_definition_versions SET contract_json = ? WHERE goal_id = ? AND version = 1')
        .run(JSON.stringify({ completionPolicy: null }), fx.goalId);

      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.failures).toContainEqual(
        expect.objectContaining({ code: 'completion_policy_unsupported' }),
      );
      expect(evaluation.finalApply.reason).toBe('completion_policy_unsupported');
      expect(checkCompletionProof(fx.db, fx.goalId, earlier)).toMatchObject({
        ok: false,
        code: 'completion_policy_unsupported',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    {
      label: 'missing version discriminator',
      mutate: (policy: Record<string, unknown>) => {
        delete policy.completionContractVersion;
      },
    },
    {
      label: 'missing integration discriminator',
      mutate: (policy: Record<string, unknown>) => {
        delete policy.integrationMode;
      },
    },
    {
      label: 'unsupported version',
      mutate: (policy: Record<string, unknown>) => {
        policy.completionContractVersion = 9;
      },
    },
  ])(
    'fails closed on an approved v2 policy with $label',
    async ({ mutate }) => {
      const fx = goalRepoFixture({ definition: v2Definition() });
      const earlier = await evaluateCompletion(fx.db, fx.goalId);
      rewriteApprovedContract(fx, 1, (contract) => {
        mutate((contract.completionPolicy ?? {}) as Record<string, unknown>);
      });

      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.ok).toBe(false);
      expect(evaluation.failures).toContainEqual(
        expect.objectContaining({ code: 'completion_policy_unsupported' }),
      );
      expect(checkCompletionProof(fx.db, fx.goalId, earlier)).toMatchObject({
        ok: false,
        code: 'completion_policy_unsupported',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'rejects a v2 child when its approved v2 ancestor has been corrupted to resemble v1',
    async () => {
      const fx = goalRepoFixture();
      const second = beginAmendment(fx.db, {
        goalId: fx.goalId,
        actor: 'user',
        definition: v2Definition(),
      });
      approveDefinition(fx.db, { goalId: fx.goalId, version: second.version, actor: 'user' });
      const thirdDefinition = v2Definition();
      thirdDefinition.limits.maxExecutionCycles += 1;
      const third = beginAmendment(fx.db, {
        goalId: fx.goalId,
        actor: 'user',
        definition: thirdDefinition,
      });
      approveDefinition(fx.db, { goalId: fx.goalId, version: third.version, actor: 'user' });

      rewriteApprovedContract(fx, second.version, (contract) => {
        const policy = contract.completionPolicy as Record<string, unknown>;
        delete policy.completionContractVersion;
        delete policy.integrationMode;
      });

      expect(validateApprovedCompletionPolicyLineage(fx.db, fx.goalId)).toMatchObject({ kind: 'invalid' });
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.ok).toBe(false);
      expect(evaluation.failures).toContainEqual(
        expect.objectContaining({ code: 'completion_policy_unsupported' }),
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'rejects a legacy v1 definition whose content no longer matches its approved hash',
    async () => {
      const fx = goalRepoFixture();
      const earlier = await evaluateCompletion(fx.db, fx.goalId);
      rewriteApprovedContract(fx, 1, (contract) => {
        (contract.completionPolicy as Record<string, unknown>).applyToBase = 'required';
      });

      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.ok).toBe(false);
      expect(evaluation.failures).toContainEqual(
        expect.objectContaining({ code: 'completion_policy_unsupported' }),
      );
      expect(checkCompletionProof(fx.db, fx.goalId, earlier)).toMatchObject({
        ok: false,
        code: 'completion_policy_unsupported',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'rejects a legacy v1 definition whose user approval is bound to another hash',
    async () => {
      const fx = goalRepoFixture();
      const version = fx.db
        .prepare('SELECT approval_id FROM goal_definition_versions WHERE goal_id = ? AND version = 1')
        .get(fx.goalId) as { approval_id: string };
      const approval = fx.db
        .prepare('SELECT detail_json FROM goal_approvals WHERE id = ?')
        .get(version.approval_id) as { detail_json: string };
      const detail = JSON.parse(approval.detail_json) as Record<string, unknown>;
      detail.definitionHash = 'f'.repeat(64);
      // Test-only corruption of the immutable approval row, isolated to this temporary database.
      fx.db.exec('DROP TRIGGER trg_goal_approval_identity; DROP TRIGGER trg_goal_approval_terminal;');
      fx.db
        .prepare('UPDATE goal_approvals SET detail_json = ? WHERE id = ?')
        .run(JSON.stringify(detail), version.approval_id);

      expect(validateApprovedCompletionPolicyLineage(fx.db, fx.goalId)).toMatchObject({ kind: 'invalid' });
      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.ok).toBe(false);
      expect(evaluation.failures).toContainEqual(
        expect.objectContaining({ code: 'completion_policy_unsupported' }),
      );
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'fails closed on malformed approved definition JSON without throwing',
    async () => {
      const fx = goalRepoFixture();
      await passDeterministic(fx);
      const earlier = await evaluateCompletion(fx.db, fx.goalId);
      expect(earlier.ok).toBe(true);
      fx.db.exec('DROP TRIGGER trg_goal_definition_immutable;');
      fx.db
        .prepare('UPDATE goal_definition_versions SET contract_json = ? WHERE goal_id = ? AND version = 1')
        .run('{ malformed', fx.goalId);

      const evaluation = await evaluateCompletion(fx.db, fx.goalId);
      expect(evaluation.ok).toBe(false);
      expect(evaluation.failures).toContainEqual(
        expect.objectContaining({ code: 'completion_policy_unsupported' }),
      );
      expect(checkCompletionProof(fx.db, fx.goalId, earlier)).toMatchObject({
        ok: false,
        code: 'completion_policy_unsupported',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'allows v1 to opt into v2 through normal approval, then validates its approved hash-bound lineage',
    () => {
      const fx = goalRepoFixture();
      const { version } = beginAmendment(fx.db, {
        goalId: fx.goalId,
        actor: 'user',
        definition: v2Definition(),
        changeSummary: 'Opt into version 2 external integration completion.',
      });
      const approved = approveDefinition(fx.db, { goalId: fx.goalId, version, actor: 'user' });
      expect(approved.definitionHash).toBe(hashGoalDefinition(v2Definition()));
      expect(validateApprovedCompletionPolicyLineage(fx.db, fx.goalId)).toMatchObject({
        kind: 'valid',
        currentVersion: version,
        currentHash: approved.definitionHash,
        currentApprovalId: approved.approvalId,
        mode: 'external_user_attested_v2',
      });
      expect(getCompletionPolicyProjection(fx.db, fx.goalId)).toMatchObject({
        definitionVersion: version,
        mode: 'external_user_attested_v2',
        v2CompletionActivated: false,
        blockers: ['external_completion_not_activated', 'correction_authority_not_implemented'],
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a proposed or edited downgrade from an approved v2 definition',
    () => {
      const fx = goalRepoFixture();
      const { version } = beginAmendment(fx.db, {
        goalId: fx.goalId,
        actor: 'user',
        definition: v2Definition(),
      });
      approveDefinition(fx.db, { goalId: fx.goalId, version, actor: 'user' });

      expect(() =>
        beginAmendment(fx.db, { goalId: fx.goalId, actor: 'user', definition: fx.definition }),
      ).toThrow(expect.objectContaining({ code: 'completion_policy_downgrade' }));

      const next = beginAmendment(fx.db, { goalId: fx.goalId, actor: 'user' });
      expect(() =>
        editProposedDefinition(fx.db, {
          goalId: fx.goalId,
          version: next.version,
          expectedDefinitionHash: next.definitionHash,
          definition: fx.definition,
        }),
      ).toThrow(expect.objectContaining({ code: 'completion_policy_downgrade' }));
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );

  it(
    'rechecks the no-downgrade rule inside definition approval after a proposal is tampered',
    () => {
      const fx = goalRepoFixture();
      const { version } = beginAmendment(fx.db, {
        goalId: fx.goalId,
        actor: 'user',
        definition: v2Definition(),
      });
      approveDefinition(fx.db, { goalId: fx.goalId, version, actor: 'user' });
      const next = beginAmendment(fx.db, { goalId: fx.goalId, actor: 'user' });
      const contract = JSON.stringify(fx.definition.contract);
      const hash = hashGoalDefinition(fx.definition);
      fx.db
        .prepare(
          `UPDATE goal_definition_versions SET contract_json = ?, milestones_json = ?, routing_json = ?, review_json = ?,
         limits_json = ?, definition_hash = ? WHERE goal_id = ? AND version = ? AND status = 'proposed'`,
        )
        .run(
          contract,
          JSON.stringify(fx.definition.milestones),
          JSON.stringify(fx.definition.routing),
          JSON.stringify(fx.definition.review),
          JSON.stringify(fx.definition.limits),
          hash,
          fx.goalId,
          next.version,
        );
      expect(() =>
        approveDefinition(fx.db, { goalId: fx.goalId, version: next.version, actor: 'user' }),
      ).toThrow(expect.objectContaining({ code: 'completion_policy_downgrade' }));
      expect(
        fx.db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(fx.goalId),
      ).toEqual({
        current_definition_version: version,
      });
      expect(
        fx.db
          .prepare('SELECT status FROM goal_definition_versions WHERE goal_id = ? AND version = ?')
          .get(fx.goalId, next.version),
      ).toEqual({
        status: 'proposed',
      });
    },
    REAL_GIT_TEST_TIMEOUT_MS,
  );
});
