import type { GoalDefinition, VerificationKind } from '../../shared/goals.js';
import type { WorkflowDefinition, WorkflowStage } from '../../shared/types.js';
import type { Db } from '../db.js';
import { materializeVerifierStage } from './verificationCommands.js';
import { listVerifiers, type CurrentVerifier } from './verifierDigest.js';

/**
 * Deterministic Goal verification. A verification workflow is a trusted, server-built override of the
 * reserved `goal-verification-v1` workflow: it contains only build/test/lint stages that `materializeVerifierStage`
 * produced from the approved definition, each named `gv-<64-hex verifier digest>`. No stage is model-backed, so there is
 * no route plan, provider or model. The collector later trusts the stage id only after re-deriving the command.
 */
export const DETERMINISTIC_VERIFIER_KINDS: readonly VerificationKind[] = ['build', 'test', 'lint'];
const STAGE_ID = /^gv-([0-9a-f]{64})$/;

export const verificationStageId = (digest: string): string => `gv-${digest}`;

export function parseVerificationStageId(stageKey: string): string | null {
  return STAGE_ID.exec(stageKey)?.[1] ?? null;
}

/** Required deterministic verifiers (build, test, lint) of the criteria a milestone owns, in definition order. */
export function milestoneDeterministicVerifiers(
  definition: GoalDefinition,
  milestoneKey: string,
): CurrentVerifier[] {
  const milestone = definition.milestones.find((item) => item.key === milestoneKey);
  if (!milestone) return [];
  const owned = new Set(milestone.criteria);
  return listVerifiers(definition).filter(
    (verifier) =>
      owned.has(verifier.criterionKey) &&
      verifier.required &&
      DETERMINISTIC_VERIFIER_KINDS.includes(verifier.spec.kind),
  );
}

export type VerificationMaterialization =
  | { ok: true; stages: WorkflowStage[]; commands: Record<string, string[]> }
  | {
      ok: false;
      code: 'verification_command_missing' | 'verification_command_unsafe' | 'verification_kind_unsupported';
      verifier: { kind: VerificationKind; criterionKey: string; digest: string };
    };

/** Materialises every verifier or reports the first one that cannot be (naming it); nothing is invented. */
export function materializeVerification(
  db: Db,
  projectId: string,
  verifiers: readonly CurrentVerifier[],
): VerificationMaterialization {
  const stages: WorkflowStage[] = [];
  const commands: Record<string, string[]> = {};
  for (const verifier of verifiers) {
    const materialized = materializeVerifierStage(
      db,
      projectId,
      verifier.spec,
      verificationStageId(verifier.digest),
    );
    if (!materialized.ok)
      return {
        ok: false,
        code: materialized.code,
        verifier: { kind: verifier.spec.kind, criterionKey: verifier.criterionKey, digest: verifier.digest },
      };
    // Every verifier gets its own verdict: a failing command never prevents the next verifier from running.
    stages.push({ ...materialized.stage, continueOnFailure: true });
    commands[verifier.digest] = materialized.command;
  }
  return { ok: true, stages, commands };
}

/** The registered verification workflow with its stages replaced by the materialised verifier stages. */
export function verificationWorkflow(
  registered: WorkflowDefinition,
  stages: WorkflowStage[],
): WorkflowDefinition {
  return { ...registered, stages };
}
