import type { EvidenceVerdict, VerificationSpec } from '../../shared/goals.js';
import type { Db } from '../db.js';
import { getCycle, type CycleRow } from './cycles.js';
import { loadDefinitionVersion } from './definitions.js';
import { recordEvidence } from './evidence.js';
import { recordRunEvidenceCollected } from './retention.js';
import { materializeVerifierStage } from './verificationCommands.js';
import { parseVerificationStageId } from './verification.js';
import { VERIFIER_EVIDENCE_KIND, listVerifiers, type CurrentVerifier } from './verifierDigest.js';

/**
 * The Stage 4B run-evidence collector. It works only from persisted state and Git: no provider is called, no model is
 * consulted, and nothing is inferred from a label. For every terminal Goal repository run (execution, remediation or
 * verification) of a terminal cycle it
 *   1. re-derives which approved verifier a deterministic stage actually ran, by re-materialising the verifier command
 *      with the same code that built the workflow and requiring it to equal the command recorded by the engine;
 *   2. records build/test/lint evidence bound to the exact tree and commit the stage verified;
 *   3. records commit and artifact evidence only where the cycle history proves it;
 *   4. and only then writes the retention marker (`run_evidence_collected`), last.
 * Evidence rows are append-only and keyed by their logical identity, so a collector that died between rows resumes
 * by reusing what exists and adding the rest; the marker is written once.
 */
export const EVIDENCE_RUN_PURPOSES = ['execution', 'remediation', 'verification'] as const;
type EvidencePurpose = (typeof EVIDENCE_RUN_PURPOSES)[number];

const TERMINAL_RUN = ['completed', 'failed', 'cancelled'];
const TERMINAL_CYCLE = ['succeeded', 'failed', 'cancelled', 'rejected'];
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_STAGE_OUTPUT_CHARS = 200_000;

export type CollectIneligibleCode =
  | 'run_not_found'
  | 'not_goal_run'
  | 'unsupported_purpose'
  | 'run_not_terminal'
  | 'cycle_missing'
  | 'cycle_not_terminal'
  | 'definition_unavailable';

export type CollectResult =
  | {
      status: 'collected';
      goalId: string;
      runId: string;
      cycleId: string;
      /** Evidence rows stored for the run after this call (the marker count). */
      evidenceCount: number;
      /** Rows inserted by this call; the rest were reused from an earlier, interrupted pass. */
      created: number;
      /** False when the marker already existed. */
      markerRecorded: boolean;
    }
  | { status: 'ineligible'; code: CollectIneligibleCode };

interface RunRow {
  id: string;
  project_id: string;
  status: string;
  goal_cycle_id: string | null;
  goal_run_purpose: string | null;
}

interface StageRow {
  id: string;
  stage_key: string;
  kind: string;
  status: string;
  output_json: string | null;
}

interface Candidate {
  verifier: CurrentVerifier;
  kind: 'build_result' | 'test_result' | 'lint_result';
  verdict: EvidenceVerdict;
  stageId: string;
  stageKey: string;
  subjectTree: string;
  subjectCommit?: string;
  exitCode?: number | null;
}

const sameCommand = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((part, index) => part === b[index]);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((part) => typeof part === 'string');

const hasMarker = (db: Db, goalId: string, runId: string): boolean =>
  !!db
    .prepare(
      `SELECT 1 FROM goal_events WHERE goal_id = ? AND type = 'run_evidence_collected'
         AND json_extract(payload_json, '$.runId') = ? LIMIT 1`,
    )
    .get(goalId, runId);

/**
 * Terminal repository runs of a Goal whose owning cycle is terminal and that have no retention marker yet, oldest cycle
 * first. A pure persisted read; the supervisor collects at most one per action.
 */
export function listUncollectedRunIds(db: Db, goalId: string, limit = 20): string[] {
  return (
    db
      .prepare(
        `SELECT r.id FROM runs r JOIN goal_cycles c ON c.id = r.goal_cycle_id
         WHERE c.goal_id = ? AND r.goal_run_purpose IN ('execution','remediation','verification')
           AND r.status IN ('completed','failed','cancelled')
           AND c.status IN ('succeeded','failed','cancelled','rejected')
           AND NOT EXISTS (
             SELECT 1 FROM goal_events e WHERE e.goal_id = c.goal_id AND e.type = 'run_evidence_collected'
               AND json_extract(e.payload_json, '$.runId') = r.id)
         ORDER BY c.sequence, r.id LIMIT ?`,
      )
      .all(goalId, limit) as Array<{ id: string }>
  ).map((row) => row.id);
}

function parseOutput(stage: StageRow): Record<string, unknown> | null {
  if (!stage.output_json || stage.output_json.length > MAX_STAGE_OUTPUT_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(stage.output_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Which approved verifiers a deterministic stage genuinely ran. The command the engine recorded in `output_json` is
 * authoritative; a stage whose recorded command differs from the re-materialised verifier command matches nothing.
 */
function matchingVerifiers(
  db: Db,
  projectId: string,
  stage: StageRow,
  command: string[],
  verifiers: CurrentVerifier[],
): CurrentVerifier[] {
  const digest = parseVerificationStageId(stage.stage_key);
  const pool =
    digest !== null
      ? verifiers.filter((verifier) => verifier.digest === digest)
      : (stage.stage_key === 'goal-build' && stage.kind === 'build') ||
          (stage.stage_key === 'goal-test' && stage.kind === 'test')
        ? verifiers.filter((verifier) => verifier.spec.kind === stage.kind)
        : [];
  return pool.filter((verifier) => {
    if (verifier.spec.kind !== 'build' && verifier.spec.kind !== 'test' && verifier.spec.kind !== 'lint')
      return false;
    const materialized = materializeVerifierStage(db, projectId, verifier.spec, stage.stage_key);
    if (!materialized.ok || !sameCommand(materialized.command, command)) return false;
    // The stage the engine ran must be the stage kind the verifier materialises to (native build/test vs shell).
    return materialized.stage.kind === stage.kind;
  });
}

function stageCandidates(
  db: Db,
  run: RunRow,
  cycle: CycleRow,
  purpose: EvidencePurpose,
  stages: StageRow[],
  verifiers: CurrentVerifier[],
): Candidate[] {
  const found: Candidate[] = [];
  for (const stage of stages) {
    if (stage.kind !== 'build' && stage.kind !== 'test' && stage.kind !== 'shellCommand') continue;
    const verdict: EvidenceVerdict | null =
      stage.status === 'passed' ? 'satisfies' : stage.status === 'failed' ? 'contradicts' : null;
    if (!verdict) continue;
    const output = parseOutput(stage);
    if (!output || !isStringArray(output.command)) continue;
    // Only a real non-zero command exit contradicts. Timeouts, runner errors and cancellation say nothing.
    if (verdict === 'contradicts' && output.failureKind !== 'command_exit') continue;
    if (typeof output.subjectTree !== 'string' || !OBJECT_ID.test(output.subjectTree)) continue;
    const subjectCommit =
      typeof output.subjectCommit === 'string' && OBJECT_ID.test(output.subjectCommit)
        ? output.subjectCommit
        : undefined;
    // A verification run must have verified exactly the head its cycle captured.
    if (
      purpose === 'verification' &&
      (!cycle.baseIntegrationCommit || subjectCommit !== cycle.baseIntegrationCommit)
    )
      continue;
    for (const verifier of matchingVerifiers(db, run.project_id, stage, output.command, verifiers)) {
      const kind = VERIFIER_EVIDENCE_KIND[verifier.spec.kind];
      if (kind !== 'build_result' && kind !== 'test_result' && kind !== 'lint_result') continue;
      found.push({
        verifier,
        kind,
        verdict,
        stageId: stage.id,
        stageKey: stage.stage_key,
        subjectTree: output.subjectTree,
        ...(subjectCommit ? { subjectCommit } : {}),
        exitCode: typeof output.exitCode === 'number' ? output.exitCode : null,
      });
    }
  }
  return found;
}

function integrationHead(db: Db, goalId: string): string | null {
  return (
    (
      db.prepare('SELECT integration_head FROM goal_runtime WHERE goal_id = ?').get(goalId) as
        { integration_head: string | null } | undefined
    )?.integration_head ?? null
  );
}

/** The cycle result commit, but only when an applied integration operation of this very run and cycle proves it. */
function provenIntegrationCommit(db: Db, run: RunRow, cycle: CycleRow): string | null {
  if (cycle.status !== 'succeeded' || !cycle.resultIntegrationCommit) return null;
  const applied = db
    .prepare(
      "SELECT new_commit FROM goal_integration_ops WHERE goal_id = ? AND cycle_id = ? AND run_id = ? AND op = 'advance' AND status = 'applied'",
    )
    .get(cycle.goalId, cycle.id, run.id) as { new_commit: string } | undefined;
  return applied && applied.new_commit === cycle.resultIntegrationCommit ? applied.new_commit : null;
}

interface Identity {
  goalId: string;
  definitionVersion: number;
  criterionKey: string;
  verifierDigest: string;
  kind: string;
  runId: string;
  stageId: string | null;
  subjectCommit: string | null;
}

/** A row is "the same evidence" by its logical identity; the first insert wins and rows are never changed. */
function existingEvidence(db: Db, identity: Identity): string | undefined {
  return (
    db
      .prepare(
        `SELECT id FROM goal_evidence WHERE goal_id = ? AND definition_version = ? AND criterion_key = ?
           AND verifier_digest = ? AND kind = ? AND run_id = ? AND COALESCE(stage_id, '') = COALESCE(?, '')
           AND (? IS NULL OR subject_commit = ?) ORDER BY rowid LIMIT 1`,
      )
      .get(
        identity.goalId,
        identity.definitionVersion,
        identity.criterionKey,
        identity.verifierDigest,
        identity.kind,
        identity.runId,
        identity.stageId,
        identity.subjectCommit,
        identity.subjectCommit,
      ) as { id: string } | undefined
  )?.id;
}

export async function collectRunEvidence(
  db: Db,
  runId: string,
  options: { now?: string } = {},
): Promise<CollectResult> {
  const run = db
    .prepare('SELECT id, project_id, status, goal_cycle_id, goal_run_purpose FROM runs WHERE id = ?')
    .get(runId) as RunRow | undefined;
  if (!run) return { status: 'ineligible', code: 'run_not_found' };
  if (!run.goal_cycle_id || !run.goal_run_purpose) return { status: 'ineligible', code: 'not_goal_run' };
  if (!(EVIDENCE_RUN_PURPOSES as readonly string[]).includes(run.goal_run_purpose))
    return { status: 'ineligible', code: 'unsupported_purpose' };
  const purpose = run.goal_run_purpose as EvidencePurpose;
  if (!TERMINAL_RUN.includes(run.status)) return { status: 'ineligible', code: 'run_not_terminal' };
  const cycle = getCycle(db, run.goal_cycle_id);
  if (!cycle) return { status: 'ineligible', code: 'cycle_missing' };
  if (!TERMINAL_CYCLE.includes(cycle.status)) return { status: 'ineligible', code: 'cycle_not_terminal' };
  const goalId = cycle.goalId;
  if (!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId))
    return { status: 'ineligible', code: 'cycle_missing' };
  const version =
    cycle.definitionVersion === null ? undefined : loadDefinitionVersion(db, goalId, cycle.definitionVersion);
  if (!version || (version.status !== 'approved' && version.status !== 'superseded'))
    return { status: 'ineligible', code: 'definition_unavailable' };
  const definitionVersion = version.version;
  const storedCount = () =>
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM goal_evidence WHERE goal_id = ? AND run_id = ?')
        .get(goalId, runId) as { n: number }
    ).n;

  if (hasMarker(db, goalId, runId))
    return {
      status: 'collected',
      goalId,
      runId,
      cycleId: cycle.id,
      evidenceCount: storedCount(),
      created: 0,
      markerRecorded: false,
    };

  const verifiers = listVerifiers(version.definition);
  const stages = db
    .prepare('SELECT id, stage_key, kind, status, output_json FROM stages WHERE run_id = ? ORDER BY sequence')
    .all(runId) as StageRow[];
  let created = 0;
  const common = {
    goalId,
    definitionVersion,
    cycleId: cycle.id,
    runId,
    ...(options.now ? { now: options.now } : {}),
  };

  for (const candidate of stageCandidates(db, run, cycle, purpose, stages, verifiers)) {
    const identity: Identity = {
      goalId,
      definitionVersion,
      criterionKey: candidate.verifier.criterionKey,
      verifierDigest: candidate.verifier.digest,
      kind: candidate.kind,
      runId,
      stageId: candidate.stageId,
      subjectCommit: null,
    };
    if (existingEvidence(db, identity)) continue;
    await recordEvidence(db, {
      ...common,
      criterionKey: candidate.verifier.criterionKey,
      verifierDigest: candidate.verifier.digest,
      kind: candidate.kind,
      verdict: candidate.verdict,
      subjectTree: candidate.subjectTree,
      ...(candidate.subjectCommit ? { subjectCommit: candidate.subjectCommit } : {}),
      stageId: candidate.stageId,
      ref: {
        source: 'run_stage',
        stageKey: candidate.stageKey,
        purpose,
        ...(candidate.exitCode !== null && candidate.exitCode !== undefined
          ? { exitCode: candidate.exitCode }
          : {}),
      },
    });
    created += 1;
  }

  // Commit and artifact evidence are derived from cycle history and the Goal head, never from a claim.
  const integrated =
    purpose === 'execution' || purpose === 'remediation' ? provenIntegrationCommit(db, run, cycle) : null;
  const head = integrationHead(db, goalId);
  for (const verifier of verifiers) {
    const spec: VerificationSpec = verifier.spec;
    if (spec.kind === 'commit_on_branch' && integrated) {
      const identity: Identity = {
        goalId,
        definitionVersion,
        criterionKey: verifier.criterionKey,
        verifierDigest: verifier.digest,
        kind: 'commit',
        runId,
        stageId: null,
        subjectCommit: integrated,
      };
      if (existingEvidence(db, identity)) continue;
      await recordEvidence(db, {
        ...common,
        criterionKey: verifier.criterionKey,
        verifierDigest: verifier.digest,
        kind: 'commit',
        verdict: 'satisfies',
        subjectCommit: integrated,
        ref: { source: 'cycle_integration', purpose },
      });
      created += 1;
    } else if (spec.kind === 'file_exists' && head) {
      // The recorded blob is read at the Goal head, so it is only evidence for this run while the head is still the
      // commit the run produced (execution, remediation) or verified (verification). If the head moved, nothing is
      // fabricated; a later verification cycle will record it.
      const bound =
        purpose === 'verification'
          ? cycle.status !== 'cancelled' && cycle.baseIntegrationCommit === head
          : integrated !== null && integrated === head;
      if (!bound) continue;
      const identity: Identity = {
        goalId,
        definitionVersion,
        criterionKey: verifier.criterionKey,
        verifierDigest: verifier.digest,
        kind: VERIFIER_EVIDENCE_KIND.file_exists,
        runId,
        stageId: null,
        subjectCommit: null,
      };
      if (existingEvidence(db, identity)) continue;
      await recordEvidence(db, {
        ...common,
        criterionKey: verifier.criterionKey,
        verifierDigest: verifier.digest,
        kind: 'artifact',
        ref: { source: 'goal_head', purpose },
      });
      created += 1;
    }
  }

  // The marker is last: a crash before this line leaves retention refusing (fail closed), and a rerun resumes.
  const evidenceCount = storedCount();
  const marker = recordRunEvidenceCollected(db, {
    goalId,
    runId,
    evidenceCount,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    status: 'collected',
    goalId,
    runId,
    cycleId: cycle.id,
    evidenceCount,
    created,
    markerRecorded: marker.recorded,
  };
}
