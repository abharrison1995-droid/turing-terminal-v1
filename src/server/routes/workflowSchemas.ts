import { z } from 'zod';
import type { BillingLane } from '../../shared/types.js';
import { ALL_BILLING_LANES, BILLING_MODES } from '../../shared/billing.js';

export const PROFILES = ['economy', 'balanced', 'maximum'] as const;
export const PERMISSIONS = ['supervised', 'normal', 'yolo', 'enigma'] as const;

export const billingLanes = ALL_BILLING_LANES as unknown as readonly [BillingLane, ...BillingLane[]];
const nativeSettingsSchema = z.record(
  z.string(),
  z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
);
export const modelConfigurationSchema = z.object({
  backendId: z.string().max(80).optional(),
  connectionProfileId: z.string().max(100).optional(),
  providerId: z.string().max(80).optional(),
  billingLane: z.enum(billingLanes).optional(),
  modelId: z.string().max(180).optional(),
  modelDisplayName: z.string().max(180).optional(),
  variantId: z.string().max(80).optional(),
  reasoning: z.string().max(80).optional(),
  nativeSettings: nativeSettingsSchema.optional(),
});
const conditionSchema = z.object({
  path: z.enum([
    'build.success',
    'tests.failed',
    'review.openCritical',
    'review.openHigh',
    'finalGate.status',
  ]),
  operator: z.enum(['equals', 'notEquals', 'greaterThan', 'lessThan']),
  value: z.union([z.boolean(), z.number(), z.string().max(80)]),
});
const routeActionSchema = z.object({
  action: z.enum(['continue', 'skip-stages', 'fail-run', 'human-approval', 'escalate']),
  skipStageIds: z.array(z.string().min(1).max(80)).max(50).optional(),
});
const decisionEngines = [
  'deterministic-rules',
  'jev-openrouter',
  'subscription-llm-judge',
  'openrouter-judge',
] as const;
const engineRouteSchema = z.object({
  engine: z.enum(decisionEngines),
  modelId: z.string().max(180).optional(),
  connectionProfileId: z.string().max(100).optional(),
  judge: modelConfigurationSchema.optional(),
});
export const decisionSchema = engineRouteSchema.extend({
  questionType: z.enum(['boolean', 'choice', 'score']),
  question: z.string().trim().min(1).max(2_000),
  criteria: z
    .union([z.record(z.string().min(1).max(80), z.string().max(500)), z.array(z.string().max(500)).max(10)])
    .optional(),
  inputs: z
    .array(z.enum(['task', 'plan', 'implementation', 'diff', 'tests', 'build', 'findings', 'finalGate']))
    .max(8),
  maxStateChars: z.number().int().min(1_000).max(96_000).optional(),
  rule: conditionSchema.optional(),
  routing: z.object({
    field: z.enum(['probability', 'confidence', 'score']),
    passAtOrAbove: z.number().finite().optional(),
    failAtOrBelow: z.number().finite().optional(),
    minConfidence: z.number().finite().optional(),
    onPass: routeActionSchema,
    onFail: routeActionSchema,
    onUncertain: routeActionSchema,
    choiceRoutes: z.record(z.string().max(80), routeActionSchema).optional(),
  }),
  escalation: engineRouteSchema.optional(),
  instructions: z.string().max(4_000).optional(),
});
const meteredBudgetSchema = z.object({
  perRunUsd: z.number().finite().min(0).max(1_000).nullable().default(null),
  unknownCostPolicy: z.enum(['block', 'ask', 'allow-with-warning']).default('block'),
});
const stageSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  kind: z.enum([
    'planner',
    'promptRefinement',
    'implementer',
    'build',
    'test',
    'reviewer',
    'parallelReview',
    'consolidate',
    'orchestrator',
    'remediation',
    'finalGate',
    'gitCheckpoint',
    'gitCommit',
    'gitPush',
    'gitMerge',
    'gitRollback',
    'conditionalBranch',
    'shellCommand',
    'notification',
    'humanApproval',
    'decisionGate',
  ]),
  role: z.string().max(80).optional(),
  backendId: z.string().max(80).optional(),
  providerId: z.string().max(80).optional(),
  modelId: z.string().max(180).optional(),
  reasoning: z.string().max(40).optional(),
  billingLane: z.enum(billingLanes).optional(),
  connectionProfileId: z.string().max(100).optional(),
  modelDisplayName: z.string().max(180).optional(),
  variantId: z.string().max(80).optional(),
  modelSnapshot: z
    .object({
      providerId: z.string().max(80),
      modelId: z.string().max(180),
      displayName: z.string().max(180),
      connectionProfileName: z.string().max(100).nullable().optional(),
      billingLane: z.enum(billingLanes).optional(),
      variantId: z.string().max(80).optional(),
      capabilities: z.record(z.string(), z.unknown()),
      discoveredAt: z.string().datetime().nullable(),
      adapterVersion: z.string().max(120).nullable(),
      status: z.enum(['current', 'last-known', 'unavailable', 'deprecated']),
      identity: z.enum(['pinned', 'floating']).optional(),
      reasoningControl: z.enum(['effort', 'variant', 'budget', 'provider-controlled', 'none']).optional(),
    })
    .optional(),
  nativeSettings: z
    .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .optional(),
  customInstructions: z.string().max(8_000).optional(),
  contextPolicy: z
    .object({
      strategy: z.enum(['focused', 'changed-files', 'artifacts-only', 'full-project']).optional(),
      maxFiles: z.number().int().min(1).max(500).optional(),
      maxEstimatedTokens: z.number().int().min(1_000).max(500_000).optional(),
      maxFileBytes: z.number().int().min(1_024).max(2_000_000).optional(),
      includeGlobs: z.array(z.string().max(160)).max(100).optional(),
      excludeGlobs: z.array(z.string().max(160)).max(100).optional(),
      includeCurrentDiff: z.boolean().optional(),
      includeTestOutput: z.boolean().optional(),
      includeBuildOutput: z.boolean().optional(),
      includePreviousArtifact: z.boolean().optional(),
      includePreviousTranscript: z.boolean().optional(),
      onLimitExceeded: z.enum(['compact', 'ask', 'stop']).optional(),
    })
    .optional(),
  decision: decisionSchema.optional(),
  orchestration: z
    .object({
      branches: z
        .array(
          z.object({
            id: z.string().trim().min(1).max(80),
            label: z.string().trim().min(1).max(120),
            skipStageIds: z.array(z.string().min(1).max(80)).max(50),
          }),
        )
        .min(1)
        .max(10),
      defaultBranchId: z.string().trim().min(1).max(80),
    })
    .optional(),
  maxIterations: z.number().int().min(1).max(20).optional(),
  timeoutMinutes: z.number().int().min(1).max(360).optional(),
  retryPolicy: z
    .object({
      maxRetries: z.number().int().min(0).max(5).optional(),
      initialDelayMs: z.number().int().min(100).max(30_000).optional(),
      maxDelayMs: z.number().int().min(100).max(120_000).optional(),
    })
    .optional(),
  parallelism: z.number().int().min(1).max(8).optional(),
  command: z.array(z.string().max(200)).length(3).optional(),
  condition: conditionSchema.optional(),
  skipStageIds: z.array(z.string().min(1).max(80)).max(50).optional(),
  notificationMessage: z.string().max(1_000).optional(),
  commitMessage: z.string().trim().min(1).max(120).optional(),
  allowNoChanges: z.boolean().optional(),
  pushRemote: z.string().trim().min(1).max(61).optional(),
  pushBranch: z.string().trim().min(1).max(100).optional(),
  rollbackTarget: z.enum(['runStart', 'latestCheckpoint']).optional(),
  continueOnFailure: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export const workflowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
  template: z.string().max(80),
  executionProfile: z.enum(PROFILES),
  permissionMode: z.enum(PERMISSIONS),
  promptRefinementDefault: z.boolean().default(false),
  maxRemediationRounds: z.number().int().min(0).max(5),
  maxParallelAgents: z.number().int().min(1).max(8),
  maxDurationMinutes: z.number().int().min(1).max(1_440).default(120),
  retryPolicy: z
    .object({
      maxRetries: z.number().int().min(0).max(5).default(1),
      initialDelayMs: z.number().int().min(100).max(30_000).default(1_000),
      maxDelayMs: z.number().int().min(100).max(120_000).default(30_000),
    })
    .default({ maxRetries: 1, initialDelayMs: 1_000, maxDelayMs: 30_000 })
    .refine((policy) => policy.maxDelayMs >= policy.initialDelayMs, {
      message: 'Maximum retry delay must be at least the initial delay.',
    }),
  isolatedWorktree: z.boolean(),
  subscriptionOnly: z.boolean().default(true),
  billingMode: z
    .enum(
      BILLING_MODES as unknown as readonly [
        'subscriptions-only',
        'subscriptions-plus-decision-budget',
        'custom',
      ],
    )
    .optional(),
  customAllowedLanes: z.array(z.enum(billingLanes)).max(20).optional(),
  meteredBudget: meteredBudgetSchema.default({ perRunUsd: null, unknownCostPolicy: 'block' }),
  externalDecisionDataPolicy: z.enum(['allow', 'ask-first', 'block']).default('ask-first'),
  lockProviders: z.boolean().default(true),
  defaultModelConfiguration: modelConfigurationSchema.optional(),
  stageDefaults: z.record(z.string(), modelConfigurationSchema).optional(),
  globalInstructions: z.string().max(8_000).optional(),
  contextPolicy: z
    .object({
      strategy: z.enum(['focused', 'changed-files', 'artifacts-only', 'full-project']).default('focused'),
      maxFiles: z.number().int().min(1).max(500).default(24),
      maxEstimatedTokens: z.number().int().min(1_000).max(500_000).default(32_000),
      maxFileBytes: z.number().int().min(1_024).max(2_000_000).default(80_000),
      includeGlobs: z.array(z.string().max(160)).max(100).default([]),
      excludeGlobs: z
        .array(z.string().max(160))
        .max(100)
        .default(['.git/**', 'node_modules/**', 'dist/**', 'build/**']),
      includeCurrentDiff: z.boolean().default(true),
      includeTestOutput: z.boolean().default(true),
      includeBuildOutput: z.boolean().default(true),
      includePreviousArtifact: z.boolean().default(true),
      includePreviousTranscript: z.boolean().default(false),
      onLimitExceeded: z.enum(['compact', 'ask', 'stop']).default('compact'),
    })
    .default({
      strategy: 'focused',
      maxFiles: 24,
      maxEstimatedTokens: 32_000,
      maxFileBytes: 80_000,
      includeGlobs: [],
      excludeGlobs: ['.git/**', 'node_modules/**', 'dist/**', 'build/**'],
      includeCurrentDiff: true,
      includeTestOutput: true,
      includeBuildOutput: true,
      includePreviousArtifact: true,
      includePreviousTranscript: false,
      onLimitExceeded: 'compact',
    }),
  stages: z.array(stageSchema).min(1).max(50),
});
