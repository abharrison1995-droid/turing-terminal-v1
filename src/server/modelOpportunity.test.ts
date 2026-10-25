import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelOption, ProviderStatus } from '../shared/types.js';
import {
  computeOpportunityDigest,
  hasOpportunityAdmissionProof,
  verifyOpportunityObservationEvidence,
} from './opportunityEvidence.js';
import { openDatabase } from './db.js';
import { decideGoalApproval, requestGoalApproval } from './goals/approvals.js';
import { approveDefinition, beginAmendment, createGoalDraft } from './goals/definitions.js';
import { requestOpportunityAdmission } from './goals/opportunityAdmission.js';
import { loadFirstUseApprovals } from './goals/routeResolution.js';
import { seedProject, validDefinition } from './goals/testKit.js';
import {
  MODEL_OBSERVATION_PAYLOAD_MAX_BYTES,
  listModelOpportunityObservations,
  modelObservationRefreshesFromProviders,
  persistModelObservationRefreshes,
  runModelObservationRetention,
} from './modelOpportunity.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dbFixture() {
  const root = mkdtempSync(join(tmpdir(), 'turing-opportunity-'));
  roots.push(root);
  return openDatabase(root);
}

function model(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    id: 'beam-free/model',
    name: 'Beam Free',
    providerId: 'beam-free',
    discoveredAt: '2026-10-24T10:00:00.000Z',
    adapterVersion: '1.2.3',
    capabilities: { tools: true },
    ...overrides,
  };
}

function provider(
  id: string,
  models: ModelOption[],
  catalogSource: ProviderStatus['catalogSource'],
  checkedAt = '2026-10-24T10:00:01.000Z',
): ProviderStatus {
  return {
    id,
    name: id,
    cli: id,
    detected: true,
    version: '1.2.3',
    authentication: 'connected',
    authMechanism: 'test',
    note: 'test',
    checkedAt,
    capabilities: {
      authentication: true,
      subscriptionAuth: true,
      modelDiscovery: true,
      execution: true,
      streaming: true,
      cancellation: true,
      usageTelemetry: true,
      remainingAllowance: false,
      resetTelemetry: false,
      structuredOutput: false,
      sessionResume: false,
      toolMediation: true,
    },
    models,
    catalogSource,
  };
}

describe('Model Opportunity observation history', () => {
  it('records provider-advertised, local adapter and cache provenance while excluding static placeholders', () => {
    const db = dbFixture();
    const providers = [
      provider(
        'openrouter',
        [
          model({ id: 'acme/model', providerId: 'acme', discoveredAt: '2026-10-24T10:00:00.000Z' }),
          {
            id: 'typesafe/jev-1.13',
            name: 'Jev placeholder',
            providerId: 'openrouter',
            status: 'last-known',
          },
        ],
        'live',
      ),
      provider('opencode', [model()], 'adapter', '2026-10-24T10:00:03.000Z'),
      provider(
        'codex-cli',
        [
          model({
            id: 'codex-gpt',
            providerId: 'openai-codex',
            status: 'last-known',
            discoveredAt: '2026-09-01T00:00:00.000Z',
          }),
        ],
        'cache',
        '2026-10-24T10:00:05.000Z',
      ),
    ];
    const batch = modelObservationRefreshesFromProviders(providers, '2026-10-24T09:59:00.000Z');
    persistModelObservationRefreshes(db, batch);
    const rows = listModelOpportunityObservations(db);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.backendId === 'openrouter')).toMatchObject({
      claimKind: 'provider-advertised',
      sourceClass: 'live',
      refreshOutcome: 'success',
      costClass: 'unknown',
      valid: true,
    });
    expect(rows.find((row) => row.backendId === 'opencode')).toMatchObject({
      claimKind: 'locally-discovered',
      sourceClass: 'adapter',
      checkedAt: '2026-10-24T10:00:03.000Z',
    });
    expect(rows.find((row) => row.backendId === 'codex-cli')).toMatchObject({
      claimKind: 'locally-discovered',
      sourceClass: 'cache',
      refreshOutcome: 'failed',
      observedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(rows.some((row) => row.modelId === 'typesafe/jev-1.13')).toBe(false);
  });

  it('replays an identical refresh idempotently and aborts a changed replay without partial writes', () => {
    const db = dbFixture();
    const refresh = modelObservationRefreshesFromProviders(
      [provider('opencode', [model()], 'adapter')],
      '2026-10-24T09:59:00.000Z',
    );
    persistModelObservationRefreshes(db, refresh);
    persistModelObservationRefreshes(db, refresh);
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_observations').get()).toEqual({ count: 1 });

    const changed = structuredClone(refresh);
    changed[0]!.observations[0]!.payload.displayName = 'Different model claim';
    expect(() => persistModelObservationRefreshes(db, changed)).toThrowError(
      expect.objectContaining({ code: 'observation_collision' }),
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_observation_refreshes').get()).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_observations').get()).toEqual({ count: 1 });
  });

  it('requires fresh raw observations for a new admission even before retention cleanup runs', () => {
    const db = dbFixture();
    const now = new Date('2026-10-24T12:00:00.000Z');
    const staleAt = new Date(now.getTime() - 91 * 86_400_000).toISOString();
    const live = provider(
      'openrouter',
      [model({ id: 'acme/model', providerId: 'acme', discoveredAt: staleAt })],
      'live',
      staleAt,
    );
    persistModelObservationRefreshes(db, modelObservationRefreshesFromProviders([live], staleAt));
    const observation = db.prepare('SELECT id FROM model_observations').get() as { id: string };
    const definition = validDefinition();
    const pool = definition.routing.pools[0]!;
    const member = pool.members[0]!;
    pool.admission = 'opportunity';
    member.configuration = {
      backendId: 'openrouter',
      providerId: 'acme',
      billingLane: 'openrouter-metered',
      modelId: 'acme/model',
    };
    member.identityKind = 'pinned';
    member.freshnessClass = 'opportunity';
    member.opportunity = {
      schemaVersion: 1,
      opportunityDigest: computeOpportunityDigest({
        backendId: 'openrouter',
        providerId: 'acme',
        modelId: 'acme/model',
        observationIds: [observation.id],
      }),
      observationIds: [observation.id],
    };

    expect(() => verifyOpportunityObservationEvidence(db, member, now.toISOString())).toThrow(
      expect.objectContaining({ code: 'opportunity_observation_invalid' }),
    );
  });

  it('rejects updates and direct deletion outside the explicit retention job', () => {
    const db = dbFixture();
    persistModelObservationRefreshes(
      db,
      modelObservationRefreshesFromProviders(
        [provider('opencode', [model()], 'adapter')],
        '2026-10-24T09:59:00.000Z',
      ),
    );
    const row = db.prepare('SELECT id FROM model_observations').get() as { id: string };
    expect(() =>
      db.prepare('UPDATE model_observations SET model_id = ? WHERE id = ?').run('changed', row.id),
    ).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM model_observations WHERE id = ?').run(row.id)).toThrow(
      /retention job/,
    );
  });

  it('retains observations referenced by active admissions, then purges expired evidence explicitly', () => {
    const db = dbFixture();
    const oldTime = '2026-01-01T00:00:00.000Z';
    const oldProvider = provider(
      'opencode',
      [model({ discoveredAt: oldTime })],
      'adapter',
      '2026-01-01T00:00:01.000Z',
    );
    const batch = modelObservationRefreshesFromProviders([oldProvider], oldTime);
    persistModelObservationRefreshes(db, batch);
    const observation = db.prepare('SELECT id FROM model_observations').get() as { id: string };
    const now = new Date();
    const activeUntil = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    const machineId = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const projectId = randomUUID();
    db.prepare('INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)').run(
      projectId,
      machineId,
      'Opportunity retention test',
      join(tmpdir(), projectId),
      now.toISOString(),
    );
    const definition = validDefinition();
    const pool = definition.routing.pools[0]!;
    const member = pool.members[0]!;
    pool.admission = 'opportunity';
    pool.members = [member];
    member.freshnessClass = 'opportunity';
    member.opportunity = {
      schemaVersion: 1,
      opportunityDigest: computeOpportunityDigest({
        backendId: member.configuration.backendId!,
        providerId: member.configuration.providerId!,
        modelId: member.configuration.modelId!,
        observationIds: [observation.id],
      }),
      observationIds: [observation.id],
    };
    const goal = createGoalDraft(db, { projectId, title: 'Opportunity retention', definition });
    const detail = {
      schemaVersion: 1,
      admissionKind: 'opportunity',
      poolId: pool.id,
      memberIndex: 0,
      memberIdentityHash: 'a'.repeat(64),
      opportunityDigest: member.opportunity.opportunityDigest,
      observationIds: [observation.id],
    } as const;
    const approval = requestGoalApproval(db, {
      goalId: goal.goalId,
      gate: 'pool_route_first_use',
      risk: 'medium',
      reason: 'Test opportunity admission retention',
      requestedBy: 'user',
      detail,
      now: now.toISOString(),
    });
    db.prepare(
      `INSERT INTO model_observation_admission_refs
      (admission_id, goal_id, definition_version, pool_id, member_index, observation_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(approval.id, goal.goalId, goal.version, pool.id, 0, observation.id, activeUntil, now.toISOString());

    expect(runModelObservationRetention(db, now).deletedObservations).toBe(0);
    expect(db.prepare('SELECT id FROM model_observations WHERE id = ?').get(observation.id)).toBeTruthy();

    const expiredAt = new Date(now.getTime() + 2 * 24 * 60 * 60_000);
    const result = runModelObservationRetention(db, expiredAt);
    expect(result.deletedObservations).toBe(1);
    expect(result.deletedRefreshes).toBe(1);
    expect(db.prepare('SELECT id FROM model_observations WHERE id = ?').get(observation.id)).toBeUndefined();
  });

  it('keeps the approved proof through its exam definition after raw evidence expires', async () => {
    const db = dbFixture();
    const now = '2026-10-24T12:00:00.000Z';
    const live = provider(
      'openrouter',
      [model({ id: 'acme/model', providerId: 'acme', discoveredAt: now })],
      'live',
      now,
    );
    persistModelObservationRefreshes(db, modelObservationRefreshesFromProviders([live], now));
    const observation = db.prepare('SELECT id FROM model_observations').get() as { id: string };
    const definition = validDefinition();
    const pool = definition.routing.pools[0]!;
    const member = pool.members[0]!;
    pool.admission = 'opportunity';
    pool.laneClass = 'permitted-by-billing-mode';
    pool.members = [member];
    member.configuration = {
      backendId: 'openrouter',
      providerId: 'acme',
      billingLane: 'openrouter-metered',
      modelId: 'acme/model',
    };
    member.identityKind = 'pinned';
    member.freshnessClass = 'opportunity';
    member.opportunity = {
      schemaVersion: 1,
      opportunityDigest: computeOpportunityDigest({
        backendId: 'openrouter',
        providerId: 'acme',
        modelId: 'acme/model',
        observationIds: [observation.id],
      }),
      observationIds: [observation.id],
    };
    definition.limits.billingMode = 'custom';
    definition.limits.maxMeteredUsd = 10;
    const goal = createGoalDraft(db, {
      projectId: seedProject(db),
      title: 'Opportunity proof retention',
      definition,
      now,
    });
    const providers = [live];
    const admission = await requestOpportunityAdmission(db, {
      goalId: goal.goalId,
      definitionVersion: goal.version,
      poolId: pool.id,
      memberIndex: 0,
      snapshot: { providers, profiles: [] },
      now,
    });
    expect(admission.approval).toMatchObject({ risk: 'medium', requestedBy: 'user', status: 'pending' });
    decideGoalApproval(db, {
      goalId: goal.goalId,
      approvalId: admission.approval.id,
      decision: 'approved',
      decidedBy: 'user',
      now,
    });
    approveDefinition(db, {
      goalId: goal.goalId,
      version: goal.version,
      expectedDefinitionHash: goal.definitionHash,
      actor: 'user',
      now,
    });

    const beforeExpiry = new Date(Date.parse(now) + 89 * 86_400_000);
    const afterExpiry = new Date(Date.parse(now) + 91 * 86_400_000);
    expect(runModelObservationRetention(db, beforeExpiry).deletedObservations).toBe(0);
    const expired = runModelObservationRetention(db, afterExpiry);
    expect(expired).toMatchObject({
      deletedObservations: 1,
      deletedRefreshes: 1,
      deletedAdmissionReferences: 1,
      deletedAdmissionProofs: 0,
    });
    expect(db.prepare('SELECT id FROM model_observations WHERE id = ?').get(observation.id)).toBeUndefined();
    expect(
      db
        .prepare('SELECT approval_id FROM model_opportunity_admission_proofs WHERE approval_id = ?')
        .get(admission.approval.id),
    ).toBeTruthy();
    expect(
      hasOpportunityAdmissionProof({
        db,
        goalId: goal.goalId,
        definitionVersion: goal.version,
        poolId: pool.id,
        memberIndex: 0,
        member,
      }),
    ).toBe(true);
    expect(loadFirstUseApprovals(db, goal.goalId).map((approval) => approval.id)).toContain(
      admission.approval.id,
    );

    const nextDefinition = structuredClone(definition);
    const nextPool = nextDefinition.routing.pools[0]!;
    nextPool.admission = 'static';
    for (const nextMember of nextPool.members) {
      delete nextMember.opportunity;
      nextMember.freshnessClass = 'stable-subscription';
    }
    const next = beginAmendment(db, {
      goalId: goal.goalId,
      actor: 'user',
      definition: nextDefinition,
      now: afterExpiry.toISOString(),
    });
    approveDefinition(db, {
      goalId: goal.goalId,
      version: next.version,
      expectedDefinitionHash: next.definitionHash,
      actor: 'user',
      now: afterExpiry.toISOString(),
    });
    const afterExamCycle = runModelObservationRetention(db, new Date(afterExpiry.getTime() + 1_000));
    expect(afterExamCycle.deletedAdmissionProofs).toBe(1);
    expect(
      db
        .prepare('SELECT approval_id FROM model_opportunity_admission_proofs WHERE approval_id = ?')
        .get(admission.approval.id),
    ).toBeUndefined();
    expect(loadFirstUseApprovals(db, goal.goalId).map((approval) => approval.id)).not.toContain(
      admission.approval.id,
    );
  });

  it('keeps the canonical payload within the operational ceiling and rejects oversized bounded fields atomically', () => {
    expect(MODEL_OBSERVATION_PAYLOAD_MAX_BYTES).toBe(8_192);
    const db = dbFixture();
    const rows = modelObservationRefreshesFromProviders(
      [
        provider(
          'opencode',
          [model({ name: 'Beam', capabilities: { detail: 'kept out of raw payload' } })],
          'adapter',
        ),
      ],
      '2026-10-24T09:59:00.000Z',
    );
    persistModelObservationRefreshes(db, rows);
    const payloadRow = db
      .prepare('SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM model_observations')
      .get() as { bytes: number };
    expect(payloadRow.bytes).toBeLessThanOrEqual(MODEL_OBSERVATION_PAYLOAD_MAX_BYTES);

    const invalid = structuredClone(rows);
    invalid[0]!.observations[0]!.payload.displayName = 'x'.repeat(181);
    invalid[0]!.id = randomUUID();
    expect(() => persistModelObservationRefreshes(db, invalid)).toThrowError(
      expect.objectContaining({ code: 'observation_payload_invalid' }),
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_observation_refreshes').get()).toEqual({
      count: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM model_observations').get()).toEqual({ count: 1 });
  });
});
