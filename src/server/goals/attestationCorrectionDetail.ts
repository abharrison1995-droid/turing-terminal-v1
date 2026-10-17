import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './definitionHash.js';

// Stage 7C.2B.5D.2: pure schemas and digests for append-only external-integration attestation corrections.
// A correction is a user decision about one immutable attestation. Nothing here reads the database or Git.

export const ATTESTATION_CORRECTION_ACTION = 'correct_external_integration_attestation_v1' as const;
export const ATTESTATION_CORRECTION_KINDS = ['dispute', 'withdraw', 'supersede'] as const;
export const ATTESTATION_CORRECTION_REASON_CODES = [
  'integration_not_performed',
  'wrong_source',
  'wrong_destination',
  'content_not_preserved',
  'observation_error',
  'superseded_by_new_observation',
  'other',
] as const;
export const ATTESTATION_CORRECTION_EXPLANATION_MAX = 1_000;

export type AttestationCorrectionKind = (typeof ATTESTATION_CORRECTION_KINDS)[number];
export type AttestationCorrectionReasonCode = (typeof ATTESTATION_CORRECTION_REASON_CODES)[number];

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const correctionKind = z.enum(ATTESTATION_CORRECTION_KINDS);
const reasonCode = z.enum(ATTESTATION_CORRECTION_REASON_CODES);

// Control characters, bidi controls and tabs are rejected. A single newline is allowed in plain-text explanations.
const EXPLANATION_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/;
export const attestationCorrectionExplanationSchema = z
  .string()
  .min(1)
  .max(ATTESTATION_CORRECTION_EXPLANATION_MAX)
  .refine((text) => !EXPLANATION_CONTROL.test(text), 'explanation contains control characters');

/** Exactly 19 top-level keys. The high-risk approval detail binds the whole reviewed correction action. */
export const attestationCorrectionApprovalDetailSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    action: z.literal(ATTESTATION_CORRECTION_ACTION),
    actionDigest: digest,
    goalId: uuid,
    handoffId: uuid,
    handoffDigest: digest,
    attestationId: uuid,
    attestationActionDigest: digest,
    attestationRecordDigest: digest,
    attestationApprovalId: uuid,
    correctionKind,
    sequence: z.number().int().min(1),
    previousCorrectionDigest: digest.nullable(),
    reasonCode,
    explanationDigest: digest.nullable(),
    replacementAttestationId: uuid.nullable(),
    replacementRecordDigest: digest.nullable(),
    definitionVersion: z.number().int().positive(),
    definitionHash: digest,
  })
  .superRefine((detail, context) => {
    if (detail.sequence === 1 && detail.previousCorrectionDigest !== null)
      context.addIssue({ code: 'custom', message: 'the first correction has no previous digest' });
    if (detail.sequence > 1 && detail.previousCorrectionDigest === null)
      context.addIssue({ code: 'custom', message: 'a later correction must name its previous digest' });
    if ((detail.correctionKind === 'supersede') !== (detail.replacementAttestationId !== null))
      context.addIssue({ code: 'custom', message: 'only supersede names a replacement attestation' });
    if ((detail.replacementAttestationId === null) !== (detail.replacementRecordDigest === null))
      context.addIssue({ code: 'custom', message: 'replacement identity and digest must appear together' });
    if (detail.replacementAttestationId !== null && detail.replacementAttestationId === detail.attestationId)
      context.addIssue({ code: 'custom', message: 'an attestation cannot replace itself' });
  });

export type AttestationCorrectionApprovalDetailV1 = z.infer<typeof attestationCorrectionApprovalDetailSchema>;

/** The fields covered by the action digest: everything except the digest itself. */
export type AttestationCorrectionActionFields = Omit<AttestationCorrectionApprovalDetailV1, 'actionDigest'>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function computeAttestationCorrectionExplanationDigest(explanation: string): string {
  return sha256(`turing-goal-attestation-correction-explanation-v1\n${explanation}`);
}

export function computeAttestationCorrectionActionDigest(fields: AttestationCorrectionActionFields): string {
  return sha256(`turing-goal-attestation-correction-action-digest-v1\n${canonicalJson(fields)}`);
}

/** Parses an approval detail and verifies its action digest; returns null for any other shape. */
export function parseAttestationCorrectionApprovalDetail(
  value: unknown,
): AttestationCorrectionApprovalDetailV1 | null {
  const parsed = attestationCorrectionApprovalDetailSchema.safeParse(value);
  if (!parsed.success) return null;
  const { actionDigest, ...fields } = parsed.data;
  return computeAttestationCorrectionActionDigest(fields) === actionDigest ? parsed.data : null;
}

/** Immutable correction record. The payload is canonical JSON and the record digest binds every field. */
const attestationCorrectionRecordBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('turing_goal_attestation_correction'),
  correctionId: uuid,
  goalId: uuid,
  handoffId: uuid,
  handoffDigest: digest,
  attestationId: uuid,
  attestationActionDigest: digest,
  attestationRecordDigest: digest,
  approvalId: uuid,
  correctionKind,
  sequence: z.number().int().min(1),
  previousCorrectionDigest: digest.nullable(),
  actionDigest: digest,
  reasonCode,
  explanation: attestationCorrectionExplanationSchema.nullable(),
  explanationDigest: digest.nullable(),
  replacement: z.strictObject({ attestationId: uuid, recordDigest: digest }).nullable(),
  definition: z.strictObject({ version: z.number().int().positive(), hash: digest }),
  decision: z.strictObject({
    value: z.literal(ATTESTATION_CORRECTION_ACTION),
    decidedBy: z.literal('user'),
    decidedAt: z.string().min(1).max(64),
  }),
});

function refineAttestationCorrectionRecord(
  record: z.infer<typeof attestationCorrectionRecordBaseSchema>,
  context: z.RefinementCtx,
): void {
  if ((record.explanation === null) !== (record.explanationDigest === null))
    context.addIssue({ code: 'custom', message: 'explanation and its digest must appear together' });
  if (
    record.explanation !== null &&
    record.explanationDigest !== computeAttestationCorrectionExplanationDigest(record.explanation)
  )
    context.addIssue({ code: 'custom', message: 'explanation digest does not match the explanation' });
  if ((record.correctionKind === 'supersede') !== (record.replacement !== null))
    context.addIssue({ code: 'custom', message: 'only supersede names a replacement attestation' });
  if (record.sequence === 1 && record.previousCorrectionDigest !== null)
    context.addIssue({ code: 'custom', message: 'the first correction has no previous digest' });
  if (record.sequence > 1 && record.previousCorrectionDigest === null)
    context.addIssue({ code: 'custom', message: 'a later correction must name its previous digest' });
}

export const attestationCorrectionRecordBodySchema = attestationCorrectionRecordBaseSchema.superRefine(
  refineAttestationCorrectionRecord,
);

export type AttestationCorrectionRecordBodyV1 = z.infer<typeof attestationCorrectionRecordBodySchema>;
export type AttestationCorrectionRecordV1 = AttestationCorrectionRecordBodyV1 & { correctionDigest: string };

export const attestationCorrectionRecordSchema = attestationCorrectionRecordBaseSchema
  .extend({ correctionDigest: digest })
  .superRefine(refineAttestationCorrectionRecord);

export function computeAttestationCorrectionRecordDigest(body: AttestationCorrectionRecordBodyV1): string {
  return sha256(`turing-goal-attestation-correction-record-v1\n${canonicalJson(body)}`);
}

/** Strict parse of a stored correction payload. The raw text must be exactly the canonical serialization. */
export function parseAttestationCorrectionRecord(raw: string): AttestationCorrectionRecordV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = attestationCorrectionRecordSchema.safeParse(value);
  if (!parsed.success) return null;
  const { correctionDigest, ...body } = parsed.data;
  if (computeAttestationCorrectionRecordDigest(body) !== correctionDigest) return null;
  const record: AttestationCorrectionRecordV1 = { ...body, correctionDigest };
  return canonicalJson(record) === raw ? record : null;
}

/** The approval detail a correction record must have been decided under, derived from the record itself. */
export function attestationCorrectionDetailFromRecord(
  record: AttestationCorrectionRecordV1,
  attestationApprovalId: string,
): AttestationCorrectionApprovalDetailV1 {
  const fields: AttestationCorrectionActionFields = {
    schemaVersion: 1,
    action: ATTESTATION_CORRECTION_ACTION,
    goalId: record.goalId,
    handoffId: record.handoffId,
    handoffDigest: record.handoffDigest,
    attestationId: record.attestationId,
    attestationActionDigest: record.attestationActionDigest,
    attestationRecordDigest: record.attestationRecordDigest,
    attestationApprovalId,
    correctionKind: record.correctionKind,
    sequence: record.sequence,
    previousCorrectionDigest: record.previousCorrectionDigest,
    reasonCode: record.reasonCode,
    explanationDigest: record.explanationDigest,
    replacementAttestationId: record.replacement?.attestationId ?? null,
    replacementRecordDigest: record.replacement?.recordDigest ?? null,
    definitionVersion: record.definition.version,
    definitionHash: record.definition.hash,
  };
  return { ...fields, actionDigest: computeAttestationCorrectionActionDigest(fields) };
}
