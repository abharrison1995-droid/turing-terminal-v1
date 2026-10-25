import { z } from 'zod';

/** Operational bounds shared by Goal definition, admission, approval and route-audit code. */
export const OPPORTUNITY_OBSERVATION_IDS_CAP = 8;
export const OPPORTUNITY_POOL_MEMBERS_CAP = 16;
export const OPPORTUNITY_ROUTE_FIELD_MAX = 96;
export const OPPORTUNITY_POOL_ID_MAX = 64;
export const OPPORTUNITY_NATIVE_SETTINGS_CAP = 8;
export const OPPORTUNITY_NATIVE_SETTING_KEY_MAX = 48;
export const OPPORTUNITY_NATIVE_SETTING_VALUE_MAX = 96;
export const OPPORTUNITY_APPROVAL_DETAIL_MAX_CHARS = 4_000;
export const OPPORTUNITY_RESOLUTION_MAX_CHARS = 64_000;

export const opportunityObservationIdSchema = z.string().uuid();
export const opportunityDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const opportunityBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  opportunityDigest: opportunityDigestSchema,
  observationIds: z
    .array(opportunityObservationIdSchema)
    .min(1)
    .max(OPPORTUNITY_OBSERVATION_IDS_CAP)
    .refine((ids) => new Set(ids).size === ids.length, 'Observation ids must be unique.')
    .refine(
      (ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id),
      'Observation ids must be sorted.',
    ),
});

export const opportunityApprovalDetailSchema = z.strictObject({
  schemaVersion: z.literal(1),
  admissionKind: z.literal('opportunity'),
  poolId: z.string().min(1).max(OPPORTUNITY_POOL_ID_MAX),
  memberIndex: z
    .number()
    .int()
    .min(0)
    .max(OPPORTUNITY_POOL_MEMBERS_CAP - 1),
  memberIdentityHash: opportunityDigestSchema,
  opportunityDigest: opportunityDigestSchema,
  observationIds: opportunityBindingSchema.shape.observationIds,
});

export type OpportunityBinding = z.infer<typeof opportunityBindingSchema>;
export type OpportunityApprovalDetail = z.infer<typeof opportunityApprovalDetailSchema>;
