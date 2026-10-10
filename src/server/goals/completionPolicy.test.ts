import { afterEach, describe, expect, it } from 'vitest';
import { hashGoalDefinition } from './definitionHash.js';
import {
  getCompletionPolicyProjection,
  parseCompletionPolicy,
  validateApprovedCompletionPolicyLineage,
} from './completionPolicy.js';
import { approveDefinition, beginAmendment, editProposedDefinition } from './definitions.js';
import { cleanupRepoFixtures, goalRepoFixture, simpleDefinition } from './repoKit.js';
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

  it('fails closed on a malformed stored policy without throwing or accepting an earlier proof', async () => {
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
  });

  it('allows v1 to opt into v2 through normal approval, then validates its approved hash-bound lineage', () => {
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
  });

  it('refuses a proposed or edited downgrade from an approved v2 definition', () => {
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
  });

  it('rechecks the no-downgrade rule inside definition approval after a proposal is tampered', () => {
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
    expect(fx.db.prepare('SELECT current_definition_version FROM goals WHERE id = ?').get(fx.goalId)).toEqual(
      {
        current_definition_version: version,
      },
    );
    expect(
      fx.db
        .prepare('SELECT status FROM goal_definition_versions WHERE goal_id = ? AND version = ?')
        .get(fx.goalId, next.version),
    ).toEqual({
      status: 'proposed',
    });
  });
});
