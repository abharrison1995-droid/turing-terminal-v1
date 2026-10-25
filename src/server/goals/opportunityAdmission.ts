import { GoalApprovalError, requestGoalApproval } from './approvals.js';
import { loadDefinitionVersion, verifyDefinitionHash } from './definitions.js';
import type { GoalOpportunityAdmissionTarget } from '../../shared/goalApi.js';
import type { GoalRole } from '../../shared/goals.js';
import { storedProviders } from '../modelCatalog.js';
import { classifyOpportunityPricingEvidence, readVerifiedModelObservation } from '../modelOpportunity.js';
import { observeProfiles } from './routingSnapshot.js';
import {
  assertOpportunityLocalValidation,
  hasOpportunityAdmissionProof,
  OpportunityEvidenceError,
  opportunityRolesUsingPool,
  opportunityBindingForMember,
  verifyOpportunityApprovalDetail,
  verifyOpportunityObservationEvidence,
} from '../opportunityEvidence.js';
import { computeRouteIdentity, effectiveIdentityKind, type RouteSnapshot } from './routeIdentity.js';
import { canonicalJson } from './definitionHash.js';
import type { Db } from '../db.js';

export class GoalOpportunityAdmissionError extends Error {
  constructor(
    readonly code:
      | 'goal_not_found'
      | 'definition_not_found'
      | 'definition_not_proposed'
      | 'opportunity_member_not_found'
      | 'opportunity_evidence_invalid'
      | 'opportunity_admission_pending'
      | 'opportunity_admission_exists',
    message: string,
  ) {
    super(message);
    this.name = 'GoalOpportunityAdmissionError';
  }
}

export function requestOpportunityAdmission(
  db: Db,
  input: {
    goalId: string;
    definitionVersion: number;
    poolId: string;
    memberIndex: number;
    snapshot: RouteSnapshot;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  return db.transaction(() => {
    const goal = db.prepare('SELECT 1 FROM goals WHERE id = ?').get(input.goalId);
    if (!goal) throw new GoalOpportunityAdmissionError('goal_not_found', 'The Goal does not exist.');
    const version = loadDefinitionVersion(db, input.goalId, input.definitionVersion);
    if (!version)
      throw new GoalOpportunityAdmissionError('definition_not_found', 'No such definition version.');
    if (version.status !== 'proposed')
      throw new GoalOpportunityAdmissionError(
        'definition_not_proposed',
        'Only a proposed definition can request an opportunity admission.',
      );
    if (!verifyDefinitionHash(version))
      throw new GoalOpportunityAdmissionError(
        'opportunity_evidence_invalid',
        'The proposed definition could not be verified.',
      );
    const pool = version.definition.routing.pools.find((candidate) => candidate.id === input.poolId);
    const member = pool?.members[input.memberIndex];
    if (!pool || pool.admission !== 'opportunity' || !member?.opportunity)
      throw new GoalOpportunityAdmissionError(
        'opportunity_member_not_found',
        'That opportunity pool member is not in the proposed definition.',
      );

    let verified;
    try {
      verified = verifyOpportunityObservationEvidence(db, member, now);
      const identity = computeRouteIdentity(member, input.snapshot);
      if (
        !identity.ok ||
        effectiveIdentityKind(member) === 'unknown' ||
        !identity.value.provider ||
        !identity.value.model ||
        identity.value.issues.length > 0
      )
        throw new OpportunityEvidenceError('opportunity_identity_unavailable');
      if (verified === 'locally-discovered')
        verifyOpportunityApprovalDetail({
          db,
          goalId: input.goalId,
          definitionVersion: version.version,
          definition: version.definition,
          detail: {
            schemaVersion: 1,
            admissionKind: 'opportunity',
            poolId: pool.id,
            memberIndex: input.memberIndex,
            memberIdentityHash: identity.value.identityHash,
            opportunityDigest: member.opportunity.opportunityDigest,
            observationIds: member.opportunity.observationIds,
          },
          now,
          snapshot: input.snapshot,
        });
      const detail = {
        schemaVersion: 1,
        admissionKind: 'opportunity',
        poolId: pool.id,
        memberIndex: input.memberIndex,
        memberIdentityHash: identity.value.identityHash,
        opportunityDigest: member.opportunity.opportunityDigest,
        observationIds: member.opportunity.observationIds,
      } as const;
      if (
        hasOpportunityAdmissionProof({
          db,
          goalId: input.goalId,
          definitionVersion: version.version,
          poolId: pool.id,
          memberIndex: input.memberIndex,
          member,
          identityHash: identity.value.identityHash,
        })
      )
        throw new GoalOpportunityAdmissionError(
          'opportunity_admission_exists',
          'This exact opportunity admission is already approved.',
        );
      const prior = db
        .prepare(
          `SELECT a.* FROM goal_approvals a
        JOIN model_observation_admission_refs ref ON ref.admission_id = a.id
        WHERE a.goal_id = ? AND a.gate = 'pool_route_first_use' AND ref.definition_version = ?
          AND ref.pool_id = ? AND ref.member_index = ? AND ref.expires_at > ?
        ORDER BY a.created_at DESC, a.rowid DESC`,
        )
        .all(input.goalId, version.version, pool.id, input.memberIndex, now) as Array<
        Record<string, unknown>
      >;
      for (const row of prior) {
        let saved: unknown;
        try {
          saved = JSON.parse(String(row.detail_json));
        } catch {
          continue;
        }
        if (canonicalJson(saved) !== canonicalJson(detail)) continue;
        if (row.status === 'pending')
          throw new GoalOpportunityAdmissionError(
            'opportunity_admission_pending',
            'This admission is already waiting for your decision.',
          );
        if (
          row.status === 'approved' &&
          hasOpportunityAdmissionProof({
            db,
            goalId: input.goalId,
            definitionVersion: version.version,
            poolId: pool.id,
            memberIndex: input.memberIndex,
            member,
            identityHash: identity.value.identityHash,
          })
        )
          throw new GoalOpportunityAdmissionError(
            'opportunity_admission_exists',
            'This exact opportunity admission is already approved.',
          );
        break;
      }
      const approval = requestGoalApproval(db, {
        goalId: input.goalId,
        gate: 'pool_route_first_use',
        risk: 'medium',
        reason: `Admit ${member.configuration.modelId} to Goal pool ${pool.id}`.slice(0, 300),
        requestedBy: 'user',
        detail,
        now,
      });
      const expiresAt = new Date(Date.parse(now) + 90 * 86_400_000).toISOString();
      const addReference = db.prepare(`INSERT INTO model_observation_admission_refs
        (admission_id, goal_id, definition_version, pool_id, member_index, observation_id, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const observationId of member.opportunity.observationIds)
        addReference.run(
          approval.id,
          input.goalId,
          version.version,
          pool.id,
          input.memberIndex,
          observationId,
          expiresAt,
          now,
        );
      return { approval, definitionVersion: version.version, verifiedPath: verified };
    } catch (error) {
      if (error instanceof GoalOpportunityAdmissionError || error instanceof GoalApprovalError) throw error;
      throw new GoalOpportunityAdmissionError(
        'opportunity_evidence_invalid',
        error instanceof OpportunityEvidenceError
          ? 'The cited observation or exact route validation is not admissible.'
          : 'The opportunity admission could not be recorded safely.',
      );
    }
  })();
}

/** Read-only projection of proposed opportunity-pool members; it never triggers discovery or writes. */
export async function listOpportunityAdmissionTargets(
  db: Db,
  now = new Date().toISOString(),
): Promise<GoalOpportunityAdmissionTarget[]> {
  const providers = await storedProviders(db);
  const snapshot: RouteSnapshot = { providers, profiles: observeProfiles(db) };
  const versions = db
    .prepare(
      `SELECT g.id AS goal_id, g.title AS goal_title, d.version
    FROM goals g JOIN goal_definition_versions d ON d.goal_id = g.id
    WHERE d.status = 'proposed' ORDER BY g.title COLLATE NOCASE, d.version`,
    )
    .all() as Array<{
    goal_id: string;
    goal_title: string;
    version: number;
  }>;
  const targets: GoalOpportunityAdmissionTarget[] = [];
  for (const row of versions) {
    const version = loadDefinitionVersion(db, row.goal_id, row.version);
    if (!version || version.status !== 'proposed' || !verifyDefinitionHash(version)) continue;
    for (const pool of version.definition.routing.pools.filter(
      (candidate) => candidate.admission === 'opportunity',
    )) {
      const roles = opportunityRolesUsingPool(version.definition, pool.id);
      for (const [memberIndex, member] of pool.members.entries()) {
        if (!member.opportunity) continue;
        let evidencePath: GoalOpportunityAdmissionTarget['evidencePath'] = null;
        let eligibility: GoalOpportunityAdmissionTarget['eligibility'] = 'evidence_invalid';
        let identityHash: string | null = null;
        let costClass: GoalOpportunityAdmissionTarget['costClass'] = 'unknown';
        try {
          const binding = opportunityBindingForMember(member);
          evidencePath = verifyOpportunityObservationEvidence(db, member, now);
          const boundObservation = readVerifiedModelObservation(db, binding.observationIds[0]!);
          if (boundObservation)
            costClass = classifyOpportunityPricingEvidence(boundObservation.payload.pricingEvidence);
          const identity = computeRouteIdentity(member, snapshot);
          if (
            !identity.ok ||
            effectiveIdentityKind(member) === 'unknown' ||
            !identity.value.provider ||
            !identity.value.model ||
            identity.value.issues.length > 0
          )
            eligibility = 'identity_unavailable';
          else {
            identityHash = identity.value.identityHash;
            if (evidencePath === 'locally-discovered') {
              try {
                assertOpportunityLocalValidation({
                  db,
                  definition: version.definition,
                  poolId: pool.id,
                  member,
                  now,
                  identityHash,
                  snapshot,
                });
                eligibility = 'ready';
              } catch {
                eligibility = 'validation_required';
              }
            } else eligibility = 'ready';
          }
          const approvals = db
            .prepare(
              `SELECT a.id, a.status, a.decided_by, a.requested_by, a.risk, a.detail_json
            FROM goal_approvals a
            WHERE a.goal_id = ? AND a.gate = 'pool_route_first_use' AND (
              EXISTS (SELECT 1 FROM model_observation_admission_refs ref
                WHERE ref.admission_id = a.id AND ref.definition_version = ? AND ref.pool_id = ?
                  AND ref.member_index = ? AND ref.expires_at > ?)
            ) ORDER BY a.created_at DESC, a.rowid DESC`,
            )
            .all(row.goal_id, version.version, pool.id, memberIndex, now) as Array<{
            id: string;
            status: string;
            decided_by: string | null;
            requested_by: string;
            risk: string;
            detail_json: string;
          }>;
          let admissionStatus: GoalOpportunityAdmissionTarget['admissionStatus'] = 'none';
          if (
            identityHash !== null &&
            hasOpportunityAdmissionProof({
              db,
              goalId: row.goal_id,
              definitionVersion: version.version,
              poolId: pool.id,
              memberIndex,
              member,
              identityHash,
            })
          )
            admissionStatus = 'approved';
          for (const approval of approvals) {
            if (admissionStatus === 'approved') break;
            let detail: unknown;
            try {
              detail = JSON.parse(approval.detail_json);
            } catch {
              continue;
            }
            if (
              !detail ||
              typeof detail !== 'object' ||
              Array.isArray(detail) ||
              (detail as Record<string, unknown>).poolId !== pool.id ||
              (detail as Record<string, unknown>).memberIndex !== memberIndex ||
              (detail as Record<string, unknown>).opportunityDigest !== binding.opportunityDigest ||
              canonicalJson((detail as Record<string, unknown>).observationIds) !==
                canonicalJson(binding.observationIds) ||
              identityHash === null ||
              (detail as Record<string, unknown>).memberIdentityHash !== identityHash ||
              approval.requested_by !== 'user' ||
              approval.risk !== 'medium'
            )
              continue;
            if (approval.status === 'approved' && approval.decided_by === 'user')
              admissionStatus = 'approved';
            else if (approval.status === 'pending') admissionStatus = 'pending';
            else if (approval.status === 'denied') admissionStatus = 'denied';
            break;
          }
          const configuration = member.configuration;
          const observation = db
            .prepare(`SELECT payload_json FROM model_observations WHERE id = ?`)
            .get(binding.observationIds[0]) as { payload_json: string } | undefined;
          let displayName = configuration.modelDisplayName ?? configuration.modelId ?? 'Opportunity model';
          if (observation) {
            try {
              const payload = JSON.parse(observation.payload_json) as { displayName?: unknown };
              if (typeof payload.displayName === 'string') displayName = payload.displayName;
            } catch {
              /* integrity proof already failed closed above */
            }
          }
          if (
            !configuration.backendId ||
            !configuration.providerId ||
            !configuration.modelId ||
            !configuration.billingLane
          )
            eligibility = 'evidence_invalid';
          targets.push({
            goalId: row.goal_id,
            goalTitle: row.goal_title,
            definitionVersion: version.version,
            definitionHash: version.definitionHash,
            poolId: pool.id,
            poolLabel: pool.label,
            memberIndex,
            modelId: configuration.modelId ?? '',
            backendId: configuration.backendId ?? '',
            providerId: configuration.providerId ?? '',
            billingLane: configuration.billingLane ?? 'unknown',
            costClass,
            displayName,
            observationIds: [...binding.observationIds],
            roles: roles as GoalRole[],
            member,
            evidencePath,
            eligibility,
            admissionStatus,
          });
        } catch {
          // Keep malformed proposals out of the action list; the definition editor already reports their validation errors.
        }
      }
    }
  }
  return targets;
}
