/*
 * FIXTURE DATA (UI.3). Every value in this file is invented for deterministic evidence. Goal titles, project names and
 * paths carry a "Fixture" marker, and no value describes a real repository, a real run or a real completion. Each object
 * is checked with `satisfies` against the shared Goal API types, so a drifting shape fails the typecheck.
 *
 * `goalCockpitRoutes` is `populatedRoutes` with the Goal endpoints replaced. `populated.ts` is not changed, so the UI.1c and UI.2
 * captures keep the inputs they were taken with.
 */
import type {
  GoalApprovalView,
  GoalAttestationCorrectionHistory,
  GoalCompletionStanding,
  GoalCompletionView,
  GoalDefinitionFull,
  GoalDefinitionSummary,
  GoalDetail,
  GoalExternalCompletionStatus,
  GoalExternalIntegrationAttestationProjection,
  GoalExternalIntegrationAttestationRecord,
  GoalExternalIntegrationStoredStatus,
  GoalExternalIntegrationVerification,
  GoalListItem,
  GoalListResponse,
  GoalManualHandoffListResponse,
  GoalManualHandoffProjection,
  GoalMilestoneView,
  GoalPreview,
  UnifiedApproval,
  UnifiedApprovalsResponse,
} from '../../src/shared/goalApi';
import type { GoalDefinition, GoalMilestoneSpec, SuccessCriterion } from '../../src/shared/goals';
import { FIXED_NOW } from './dashboard';
import { RawResponse } from './mockApi';
import { populatedRoutes } from './populated';

const NOW_MS = Date.parse(FIXED_NOW);
const at = (minutesBeforeNow: number): string => new Date(NOW_MS - minutesBeforeNow * 60_000).toISOString();
const DAY = 60 * 24;

const PROJECT_ATLAS = 'fixture-project-atlas';
const PROJECT_LEDGER = 'fixture-project-ledger';
const PROJECT_DOCS = 'fixture-project-docs';
const PROJECT_CLI = 'fixture-project-cli';

/** The five Goals this fixture set describes. Each one is the subject of at least one capture. */
export const UI3_IDS = {
  /** Needs the user: one pending Goal approval. */
  ledger: 'fixture-ui3-ledger',
  /** Active: milestones in three statuses, an open cycle, no percentage. */
  active: 'fixture-ui3-active',
  /**
   * Reviewing: a manual-integration handoff with a diff and a path list. Its Handoff tab also holds one attestation and a
   * decided completion, so the desktop completion standing and its Complete control render once the attestation is chosen.
   */
  handoff: 'fixture-ui3-handoff',
  /** Completed, with a contested (disputed) completion standing. */
  contested: 'fixture-ui3-contested',
  /** Completed, with a historical legacy standing that no attestation proves. */
  legacy: 'fixture-ui3-legacy',
} as const;

const LEDGER_APPROVAL_ID = 'fixture-ui3-approval-milestone-001';
const CONTESTED_ATTESTATION_ID = 'fixture-ui3-attestation-001';
const HANDOFF_ID = 'fixture-ui3-handoff-001';
const HANDOFF_ATTESTATION_ID = 'fixture-ui3-attestation-handoff-001';
const HANDOFF_ATTESTATION_APPROVAL_ID = 'fixture-ui3-approval-attestation-handoff-001';
const HANDOFF_DECISION_APPROVAL_ID = 'fixture-ui3-approval-completion-handoff-001';

/** A 64-character lower-case hex digest, the shape the client checks. Every value is an invented fixture, not a hash. */
const digest = (pair: string) => pair.repeat(32);
const DIGEST = {
  attestAction: digest('a1'),
  attestRecord: digest('b2'),
  handoff: digest('c3'),
  evidence: digest('d4'),
  completionAction: digest('e5'),
} as const;

// ---- Definitions -------------------------------------------------------------------------------------------------------

type DefinitionDraft = Pick<
  GoalDefinitionFull,
  'goalId' | 'version' | 'parentVersion' | 'status' | 'changeSummary'
> & {
  criteria: SuccessCriterion[];
  milestones: GoalMilestoneSpec[];
  outcome: string;
};

const criterion = (key: string, statement: string): SuccessCriterion => ({
  key,
  statement,
  verification: [{ kind: 'test', command: ['npm', 'test'] }],
  required: true,
});

const milestoneSpec = (
  key: string,
  title: string,
  criteria: string[],
  dependsOn: string[],
): GoalMilestoneSpec => ({
  key,
  title,
  objective: `Fixture objective for ${title.toLowerCase()}.`,
  criteria,
  dependsOn,
  allowedScope: { includeGlobs: ['fixture/**'], excludeGlobs: [] },
  requiredEvidence: criteria.map((criterionKey) => ({ criterionKey, kinds: ['test_result'] })),
  reviewRequirements: { milestoneReview: true },
});

function definitionBody(draft: DefinitionDraft): GoalDefinition {
  return {
    contract: {
      outcome: draft.outcome,
      successCriteria: draft.criteria,
      nonGoals: ['Fixture: no change outside the fixture paths.'],
      constraints: ['Fixture: keep each change small enough to review.'],
      deliverables: [],
      completionPolicy: {
        completionContractVersion: 2,
        integrationMode: 'external_user_attested',
        requireFinalReview: true,
        requireUserAcceptance: true,
        applyToBase: 'required',
        maxOpenFindings: { critical: 0, high: 0, medium: 0 },
        highSeverityResolution: 'review-only',
      },
    },
    milestones: draft.milestones,
    routing: {
      roles: {},
      pools: [],
      workflows: {
        planning: 'fixture-planning',
        execution: 'fixture-execution',
        review: 'fixture-review',
        verification: 'fixture-verification',
      },
      independence: { finalReview: 'none', against: [], allowFloatingFinalReviewer: false },
    },
    review: {
      onMilestoneComplete: true,
      final: true,
      blocking: { periodic: false, milestone: true, final: true },
    },
    limits: {
      maxExecutionCycles: 10,
      maxConsecutiveFailedCycles: 3,
      maxRemediationAttempts: 3,
      maxActiveMinutes: 600,
      maxWallClockDays: 2,
      maxParallelAgents: 1,
      maxMeteredUsd: null,
      billingMode: 'subscriptions-only',
      humanGates: {
        eachCycle: false,
        beforeMilestoneComplete: false,
        poolRouteFirstUse: false,
        finalAcceptance: true,
      },
    },
  };
}

function fullDefinition(draft: DefinitionDraft): GoalDefinitionFull {
  return {
    goalId: draft.goalId,
    version: draft.version,
    parentVersion: draft.parentVersion,
    status: draft.status,
    definitionHash: `fixture-hash-${draft.goalId}-v${draft.version}`,
    changeSummary: draft.changeSummary,
    createdBy: 'user',
    createdAt: at(DAY * 5),
    approvedAt: draft.status === 'approved' ? at(DAY * 5) : null,
    approvedBy: draft.status === 'approved' ? 'user' : null,
    approvalId: draft.status === 'approved' ? `fixture-ui3-approval-definition-v${draft.version}` : null,
    validation: { valid: true, errors: [], warnings: [] },
    definition: definitionBody(draft),
  } satisfies GoalDefinitionFull;
}

const summaryOf = (full: GoalDefinitionFull): GoalDefinitionSummary => ({
  version: full.version,
  parentVersion: full.parentVersion,
  status: full.status,
  definitionHash: full.definitionHash,
  changeSummary: full.changeSummary,
  createdBy: full.createdBy,
  createdAt: full.createdAt,
  approvedAt: full.approvedAt,
  approvedBy: full.approvedBy,
  approvalId: full.approvalId,
});

const ATLAS_MILESTONES = [
  milestoneSpec('m0', 'Scaffold', ['scaffold-builds'], []),
  milestoneSpec('m1', 'Client contract', ['contract-tests'], ['m0']),
  milestoneSpec('m2', 'Retry policy', ['backoff-bounded'], ['m1']),
  milestoneSpec('m3', 'Integration tests', ['integration-green'], ['m2']),
  milestoneSpec('m4', 'Documentation', ['docs-updated'], ['m3']),
];
const ATLAS_CRITERIA = [
  criterion('scaffold-builds', 'The client package builds.'),
  criterion('contract-tests', 'The client contract tests pass.'),
  criterion('backoff-bounded', 'Retries stop after the configured bound.'),
  criterion('integration-green', 'The integration suite passes.'),
  criterion('docs-updated', 'The retry section of the guide is updated.'),
];

const atlasV1 = fullDefinition({
  goalId: UI3_IDS.active,
  version: 1,
  parentVersion: null,
  status: 'superseded',
  changeSummary: 'Fixture: first draft of the Atlas retry Goal.',
  outcome: 'Fixture: the Atlas client retries transient failures.',
  criteria: ATLAS_CRITERIA.slice(0, 3),
  milestones: ATLAS_MILESTONES.slice(0, 3),
});
const atlasV2 = fullDefinition({
  goalId: UI3_IDS.active,
  version: 2,
  parentVersion: 1,
  status: 'approved',
  changeSummary: 'Fixture: bound the retries and add integration tests.',
  outcome: 'Fixture: the Atlas client retries transient failures with a bounded backoff.',
  criteria: ATLAS_CRITERIA,
  milestones: ATLAS_MILESTONES,
});

const ledgerV1 = fullDefinition({
  goalId: UI3_IDS.ledger,
  version: 1,
  parentVersion: null,
  status: 'approved',
  changeSummary: 'Fixture: CSV v2 export with a schema header.',
  outcome: 'Fixture: export the ledger as CSV v2.',
  criteria: [criterion('schema-header', 'The export starts with a schema header.')],
  milestones: [
    milestoneSpec('m0', 'Schema', ['schema-header'], []),
    milestoneSpec('m1', 'Parser', ['schema-header'], ['m0']),
    milestoneSpec('m2', 'CSV v2 writer', ['schema-header'], ['m1']),
  ],
});

const docsV1 = fullDefinition({
  goalId: UI3_IDS.handoff,
  version: 1,
  parentVersion: null,
  status: 'approved',
  changeSummary: 'Fixture: rebuild the docs search index.',
  outcome: 'Fixture: the docs search index is rebuilt and ranked.',
  criteria: [criterion('index-builds', 'The index builds from the docs.')],
  milestones: [milestoneSpec('m0', 'Index build', ['index-builds'], [])],
});

const contestedV1 = fullDefinition({
  goalId: UI3_IDS.contested,
  version: 1,
  parentVersion: null,
  status: 'approved',
  changeSummary: 'Fixture: migrate the export schema.',
  outcome: 'Fixture: the export schema migrates to version 2.',
  criteria: [criterion('migration-runs', 'The migration runs on the fixture data.')],
  milestones: [milestoneSpec('m0', 'Migration', ['migration-runs'], [])],
});

// ---- Completion standings ----------------------------------------------------------------------------------------------

const contestedStanding = {
  schemaVersion: 1,
  goalId: UI3_IDS.contested,
  status: { goalStatus: 'completed', completedAt: at(300), reasonCode: null },
  claim: {
    unqualifiedSuccessAllowed: false,
    trustedForDownstream: false,
    qualifier: 'disputed_by_user',
    contentPreservation: 'not_proven',
  },
  kind: 'v2',
  standing: 'disputed',
  proof: {
    state: 'valid',
    proofId: 'fixture-ui3-proof-001',
    proofDigest: 'fixture-ui3-proof-digest-001',
    attestationId: CONTESTED_ATTESTATION_ID,
    attestationRecordDigest: 'fixture-ui3-record-digest-001',
    approvalId: 'fixture-ui3-approval-completion-001',
    actionDigest: 'fixture-ui3-action-digest-001',
    observedAt: at(300),
    chainAtProof: { sequence: 0, digest: 'fixture-ui3-chain-000', standing: 'active_uncontested' },
  },
  correction: {
    attestationId: CONTESTED_ATTESTATION_ID,
    standing: 'disputed',
    correctionCount: 1,
    tip: {
      correctionId: 'fixture-ui3-correction-001',
      kind: 'dispute',
      sequence: 1,
      correctionDigest: 'fixture-ui3-correction-digest-001',
      decidedAt: at(200),
      replacementAttestationId: null,
    },
    correctedAfterCompletion: true,
    invalidCode: null,
    replacement: null,
  },
  classification: { trust: 'qualified', reconciliation: 'none', reasons: ['attestation_disputed'] },
  otherAttestations: [],
  otherAttestationsTruncated: false,
} satisfies GoalCompletionStanding;

const legacyStanding = {
  schemaVersion: 1,
  goalId: UI3_IDS.legacy,
  status: { goalStatus: 'completed', completedAt: at(480), reasonCode: null },
  claim: {
    unqualifiedSuccessAllowed: false,
    trustedForDownstream: false,
    qualifier: 'legacy_not_v2_attested',
    contentPreservation: 'not_proven',
  },
  kind: 'legacy',
  standing: 'historical_legacy',
  proof: { state: 'legacy_no_proof' },
  correction: null,
  classification: { trust: 'qualified', reconciliation: 'none', reasons: ['legacy_completion'] },
  otherAttestations: [],
  otherAttestationsTruncated: false,
} satisfies GoalCompletionStanding;

const notCompletedStanding = {
  schemaVersion: 1,
  goalId: UI3_IDS.active,
  status: { goalStatus: 'running', completedAt: null, reasonCode: null },
  claim: {
    unqualifiedSuccessAllowed: false,
    trustedForDownstream: false,
    qualifier: 'not_completed',
    contentPreservation: 'not_proven',
  },
  kind: 'not_completed',
  standing: null,
} satisfies GoalCompletionStanding;

const completedView = (definitionVersion: number, integrationHead: string): GoalCompletionView => ({
  ok: true,
  definitionVersion,
  definitionHash: `fixture-hash-completed-v${definitionVersion}`,
  integrationHead,
  integrationTree: 'fixture-ui3-tree-completed',
  failures: [],
  finalReview: { required: true, ok: true, reason: null },
  finalAcceptance: { required: true, ok: true, approvalId: 'fixture-ui3-approval-final-001', reason: null },
  finalApply: { required: true, ok: true, basis: 'manual_integration_recorded', reason: null },
});

// ---- Goal list rows and details ----------------------------------------------------------------------------------------

const LIST_DEFAULTS = {
  reasonDetail: null,
  paused: false,
  attention: [],
  needsUser: false,
  pendingApprovalCount: 0,
  reasonCode: null,
} satisfies Partial<GoalListItem>;

const ledgerItem = {
  ...LIST_DEFAULTS,
  id: UI3_IDS.ledger,
  projectId: PROJECT_LEDGER,
  projectName: 'Fixture Ledger UI',
  title: 'Fixture: CSV v2 ledger export',
  status: 'needs_user',
  reasonCode: 'approval_required',
  needsUser: true,
  attention: ['status_needs_user', 'pending_goal_approval'],
  pendingApprovalCount: 1,
  currentDefinitionVersion: 1,
  activeMilestone: { key: 'm2', title: 'CSV v2 writer', runtimeStatus: 'active' },
  lastCycle: {
    id: 'fixture-ui3-cycle-ledger-2',
    sequence: 2,
    kind: 'review',
    status: 'completed',
    triggerCode: 'milestone_complete',
    finishedAt: at(25),
  },
  nextAction: { kind: 'review_approval', approvalId: LEDGER_APPROVAL_ID },
  integrationBranch: 'goal/fixture-ledger-csv',
  integrationHead: null,
  openFindingCounts: { critical: 0, high: 0, medium: 0, low: 1 },
  usageSummary: { events: 22, inputTokens: 141_003, outputTokens: 20_118, meteredSpendUsd: 0 },
  createdAt: at(DAY * 6),
  updatedAt: at(25),
} satisfies GoalListItem;

const activeItem = {
  ...LIST_DEFAULTS,
  id: UI3_IDS.active,
  projectId: PROJECT_ATLAS,
  projectName: 'Fixture Atlas API',
  title: 'Fixture: retry backoff for the Atlas client',
  status: 'running',
  currentDefinitionVersion: 2,
  activeMilestone: { key: 'm2', title: 'Retry policy', runtimeStatus: 'active' },
  lastCycle: {
    id: 'fixture-ui3-cycle-active-3',
    sequence: 3,
    kind: 'execution',
    status: 'running',
    triggerCode: 'scheduled',
    finishedAt: null,
  },
  nextAction: { kind: 'wait_for_turing' },
  integrationBranch: 'goal/fixture-atlas-backoff',
  integrationHead: 'fixture0a1b2c3d4e5f60718293',
  openFindingCounts: { critical: 0, high: 0, medium: 1, low: 2 },
  usageSummary: { events: 14, inputTokens: 88_210, outputTokens: 12_904, meteredSpendUsd: 0 },
  createdAt: at(DAY * 6),
  updatedAt: at(9),
} satisfies GoalListItem;

const handoffItem = {
  ...LIST_DEFAULTS,
  id: UI3_IDS.handoff,
  projectId: PROJECT_DOCS,
  projectName: 'Fixture Docs Site',
  title: 'Fixture: docs search index refresh',
  status: 'reviewing',
  currentDefinitionVersion: 1,
  activeMilestone: { key: 'm0', title: 'Index build', runtimeStatus: 'satisfied' },
  lastCycle: {
    id: 'fixture-ui3-cycle-handoff-4',
    sequence: 4,
    kind: 'verification',
    status: 'completed',
    triggerCode: 'milestone_complete',
    finishedAt: at(60),
  },
  nextAction: { kind: 'final_apply' },
  integrationBranch: 'goal/fixture-docs-search',
  integrationHead: 'fixture9c8b7a6d5e4f3a2b1c0d',
  openFindingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
  usageSummary: { events: 9, inputTokens: 40_118, outputTokens: 6_022, meteredSpendUsd: 0 },
  createdAt: at(DAY * 4),
  updatedAt: at(60),
} satisfies GoalListItem;

const contestedItem = {
  ...LIST_DEFAULTS,
  id: UI3_IDS.contested,
  projectId: PROJECT_CLI,
  projectName: 'Fixture CLI',
  title: 'Fixture: export schema migration',
  status: 'completed',
  currentDefinitionVersion: 1,
  activeMilestone: null,
  lastCycle: {
    id: 'fixture-ui3-cycle-contested-5',
    sequence: 5,
    kind: 'verification',
    status: 'completed',
    triggerCode: 'completion',
    finishedAt: at(300),
  },
  nextAction: { kind: 'completed' },
  integrationBranch: 'goal/fixture-cli-migration',
  integrationHead: 'fixture7d6c5b4a39210fedcba9',
  openFindingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
  usageSummary: { events: 18, inputTokens: 120_004, outputTokens: 15_770, meteredSpendUsd: 0 },
  completionStandingBrief: {
    state: 'ready',
    standing: 'disputed',
    qualifier: 'disputed_by_user',
    trusted: false,
    contentPreservation: 'not_proven',
  },
  createdAt: at(DAY * 9),
  updatedAt: at(120),
} satisfies GoalListItem;

const legacyItem = {
  ...LIST_DEFAULTS,
  id: UI3_IDS.legacy,
  projectId: PROJECT_CLI,
  projectName: 'Fixture CLI',
  title: 'Fixture: JSON output for the status command',
  status: 'completed',
  currentDefinitionVersion: null,
  activeMilestone: null,
  lastCycle: {
    id: 'fixture-ui3-cycle-legacy-4',
    sequence: 4,
    kind: 'verification',
    status: 'completed',
    triggerCode: 'completion',
    finishedAt: at(480),
  },
  nextAction: { kind: 'completed' },
  integrationBranch: null,
  integrationHead: null,
  openFindingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
  usageSummary: { events: 31, inputTokens: 190_772, outputTokens: 27_560, meteredSpendUsd: 0 },
  completionStandingBrief: {
    state: 'ready',
    standing: 'historical_legacy',
    qualifier: 'legacy_not_v2_attested',
    trusted: false,
    contentPreservation: 'not_proven',
  },
  createdAt: at(DAY * 14),
  updatedAt: at(480),
} satisfies GoalListItem;

/** The list response, attention first, as the server orders it. */
export const ui3List = {
  goals: [ledgerItem, activeItem, handoffItem, contestedItem, legacyItem],
  total: 5,
  limit: 50,
} satisfies GoalListResponse;

const approvalView: GoalApprovalView = {
  id: LEDGER_APPROVAL_ID,
  goalId: UI3_IDS.ledger,
  gate: 'milestone_complete',
  risk: 'medium',
  reason: 'Fixture: the CSV v2 writer milestone is ready for your review.',
  requestedBy: 'supervisor',
  status: 'pending',
  decidedBy: null,
  decisionNote: null,
  createdAt: at(25),
  respondedAt: null,
  detail: {},
};

const activeMilestones: GoalMilestoneView[] = [
  {
    key: 'm0',
    title: 'Scaffold',
    ordinal: 0,
    runtimeStatus: 'satisfied',
    satisfiedAt: at(DAY * 4),
    evaluation: null,
  },
  {
    key: 'm1',
    title: 'Client contract',
    ordinal: 1,
    runtimeStatus: 'satisfied',
    satisfiedAt: at(DAY * 2),
    evaluation: null,
  },
  {
    key: 'm2',
    title: 'Retry policy',
    ordinal: 2,
    runtimeStatus: 'active',
    satisfiedAt: null,
    evaluation: { state: 'open', blockers: ['Fixture: criterion backoff-bounded is not yet met.'] },
  },
  {
    key: 'm3',
    title: 'Integration tests',
    ordinal: 3,
    runtimeStatus: 'pending',
    satisfiedAt: null,
    evaluation: null,
  },
  {
    key: 'm4',
    title: 'Documentation',
    ordinal: 4,
    runtimeStatus: 'pending',
    satisfiedAt: null,
    evaluation: null,
  },
];

const ledgerMilestones: GoalMilestoneView[] = [
  {
    key: 'm0',
    title: 'Schema',
    ordinal: 0,
    runtimeStatus: 'satisfied',
    satisfiedAt: at(DAY),
    evaluation: null,
  },
  {
    key: 'm1',
    title: 'Parser',
    ordinal: 1,
    runtimeStatus: 'satisfied',
    satisfiedAt: at(DAY * 0.5),
    evaluation: null,
  },
  {
    key: 'm2',
    title: 'CSV v2 writer',
    ordinal: 2,
    runtimeStatus: 'active',
    satisfiedAt: null,
    evaluation: { state: 'met', blockers: [] },
  },
];

const cycleOf = (item: GoalListItem, milestoneKey: string | null, createdAt: string) => ({
  ...(item.lastCycle ?? {
    id: 'fixture-ui3-cycle-none',
    sequence: 0,
    kind: 'execution' as const,
    status: 'pending',
    triggerCode: 'none',
    finishedAt: null,
  }),
  milestoneKey,
  createdAt,
});

/** Shared fields with GoalDetail defaults. Each Goal overrides only what it needs. */
const detailRest = (
  overrides: Partial<Omit<GoalDetail, keyof GoalListItem>>,
): Omit<GoalDetail, keyof GoalListItem> => ({
  approvedAt: at(DAY * 5),
  startedAt: at(DAY * 5),
  completedAt: null,
  baseBranch: 'main',
  baseCommit: 'fixture0base00000000ab',
  runtime: { cyclesExecuted: 3, consecutiveFailedCycles: 0, remediationAttempts: {}, activeMs: 1_860_000 },
  currentDefinition: null,
  proposedDefinition: null,
  definitions: [],
  milestones: [],
  activeCycle: null,
  childRun: null,
  memory: null,
  pendingApprovals: [],
  completion: null,
  flags: { cycleActive: false, childRun: 'none', proposalRequired: false, userNeeded: false },
  ...overrides,
});

const detailOf = (
  item: GoalListItem,
  overrides: Partial<Omit<GoalDetail, keyof GoalListItem>>,
): GoalDetail => ({
  ...item,
  ...detailRest(overrides),
});

const ledgerDetail = detailOf(ledgerItem, {
  approvedAt: at(DAY * 6),
  startedAt: at(DAY * 6),
  currentDefinition: ledgerV1,
  definitions: [summaryOf(ledgerV1)],
  milestones: ledgerMilestones,
  activeCycle: null,
  childRun: null,
  pendingApprovals: [approvalView],
  flags: { cycleActive: false, childRun: 'none', proposalRequired: false, userNeeded: true },
});

const activeDetail = detailOf(activeItem, {
  currentDefinition: atlasV2,
  definitions: [summaryOf(atlasV1), summaryOf(atlasV2)],
  milestones: activeMilestones,
  activeCycle: { ...cycleOf(activeItem, 'm2', at(20)), finishedAt: null },
  childRun: { id: 'fixture-ui3-run-active-execution', purpose: 'execution', status: 'running' },
  flags: { cycleActive: true, childRun: 'active', proposalRequired: false, userNeeded: false },
  completionStanding: notCompletedStanding,
});

const handoffDetail = detailOf(handoffItem, {
  currentDefinition: docsV1,
  definitions: [summaryOf(docsV1)],
  milestones: [
    {
      key: 'm0',
      title: 'Index build',
      ordinal: 0,
      runtimeStatus: 'satisfied',
      satisfiedAt: at(DAY),
      evaluation: null,
    },
  ],
  completion: {
    ok: false,
    definitionVersion: 1,
    definitionHash: 'fixture-hash-handoff-v1',
    integrationHead: 'fixture9c8b7a6d5e4f3a2b1c0d',
    integrationTree: 'fixture-ui3-tree-handoff',
    failures: [{ code: 'final_apply_required', detail: 'Fixture: no manual integration has been recorded.' }],
    finalReview: { required: true, ok: true, reason: null },
    finalAcceptance: {
      required: true,
      ok: true,
      approvalId: 'fixture-ui3-approval-final-docs',
      reason: null,
    },
    finalApply: { required: true, ok: false, basis: null, reason: 'manual_integration_not_recorded' },
  },
  flags: { cycleActive: false, childRun: 'none', proposalRequired: false, userNeeded: true },
});

const contestedDetail = detailOf(contestedItem, {
  completedAt: at(300),
  currentDefinition: contestedV1,
  definitions: [summaryOf(contestedV1)],
  milestones: [
    {
      key: 'm0',
      title: 'Migration',
      ordinal: 0,
      runtimeStatus: 'satisfied',
      satisfiedAt: at(DAY * 2),
      evaluation: null,
    },
  ],
  completion: completedView(1, 'fixture7d6c5b4a39210fedcba9'),
  completionStanding: contestedStanding,
});

const legacyDetail = detailOf(legacyItem, {
  completedAt: at(480),
  completion: null,
  completionStanding: legacyStanding,
});

const DETAILS: Record<string, GoalDetail> = {
  [UI3_IDS.ledger]: ledgerDetail,
  [UI3_IDS.active]: activeDetail,
  [UI3_IDS.handoff]: handoffDetail,
  [UI3_IDS.contested]: contestedDetail,
  [UI3_IDS.legacy]: legacyDetail,
};

const DEFINITIONS: Record<string, GoalDefinitionFull[]> = {
  [UI3_IDS.ledger]: [ledgerV1],
  [UI3_IDS.active]: [atlasV1, atlasV2],
  [UI3_IDS.handoff]: [docsV1],
  [UI3_IDS.contested]: [contestedV1],
  [UI3_IDS.legacy]: [],
};

/** A stored read-only preview. Routing is shown only for the active Goal, whose roles the fixture resolves. */
function previewOf(goal: GoalDetail): GoalPreview {
  const definition = goal.currentDefinition;
  const isActive = goal.id === UI3_IDS.active;
  return {
    goalId: goal.id,
    status: goal.status,
    reasonCode: goal.reasonCode,
    definition: definition
      ? { version: definition.version, definitionHash: definition.definitionHash }
      : null,
    activeMilestone: goal.activeMilestone
      ? { key: goal.activeMilestone.key, title: goal.activeMilestone.title }
      : null,
    runtime: goal.runtime,
    limits: definition
      ? {
          hard: { maxExecutionCycles: 10, maxActiveMinutes: 600, maxWallClockDays: 2 },
          remaining: { executionCycles: 7, activeMinutes: 480, wallClockDays: 2, meteredUsd: null },
          breach: null,
        }
      : null,
    integration: { branch: goal.integrationBranch, head: goal.integrationHead, tree: null },
    currentCycle: goal.activeCycle ? { ...goal.activeCycle } : null,
    routing: isActive
      ? {
          observation: 'stored',
          ok: true,
          roles: [
            {
              role: 'implementer',
              status: 'resolved',
              source: 'persisted',
              selection: {
                role: 'implementer',
                routeKind: 'pinned',
                poolId: null,
                identityHash: 'fixture-ui3-identity-001',
                backendId: 'fixture-backend',
                providerId: 'fixture-provider',
                modelId: 'fixture-model',
                approvalState: 'not_required',
              },
            },
          ],
        }
      : null,
    billing: { mode: 'subscriptions-only', maxMeteredUsd: null, meteredSpendUsd: 0 },
    proposalRequired: false,
    task: isActive
      ? {
          milestoneKey: 'm2',
          title: 'Fixture: add the bounded backoff',
          targetCriteria: ['backoff-bounded'],
          expectedPaths: ['fixture/atlas/retry.ts'],
          workflowId: null,
        }
      : null,
    completion: goal.completion,
    blockers: [],
    pendingApprovals: goal.pendingApprovals,
    openFindingCounts: goal.openFindingCounts,
    nextAction: goal.nextAction,
  } satisfies GoalPreview;
}

// ---- Approvals ---------------------------------------------------------------------------------------------------------

const UNIFIED_APPROVALS: UnifiedApproval[] = [
  {
    source: 'goal',
    id: LEDGER_APPROVAL_ID,
    goalId: UI3_IDS.ledger,
    title: 'milestone_complete',
    reason: 'Fixture: the CSV v2 writer milestone is ready for your review.',
    risk: 'medium',
    status: 'pending',
    requestedBy: 'supervisor',
    decidedBy: null,
    createdAt: at(25),
    respondedAt: null,
    gate: 'milestone_complete',
    decidable: true,
  },
];

// ---- Handoff -----------------------------------------------------------------------------------------------------------

const HANDOFF_DIFF_PREVIEW = [
  'diff --git a/fixture/docs/search/build.ts b/fixture/docs/search/build.ts',
  '--- a/fixture/docs/search/build.ts',
  '+++ b/fixture/docs/search/build.ts',
  '@@ -1,4 +1,9 @@',
  ' export function buildIndex(pages: string[]) {',
  '-  return pages.map(tokenise);',
  '+  const tokens = pages.map(tokenise);',
  '+  return rankTokens(tokens);',
  ' }',
  '',
  'diff --git a/fixture/docs/search/rank.ts b/fixture/docs/search/rank.ts',
  '+export function rankTokens(tokens: string[][]) {',
  '+  return tokens.flat().sort();',
  '+}',
  '',
].join('\n');

const HANDOFF_DIFF_STAT = [
  ' fixture/docs/search/build.ts                                    |  7 ++++---',
  ' fixture/docs/search/rank.ts                                     |  3 +++',
  ' fixture/docs/search/index.md                                    |  2 +-',
  ' fixture/docs/search/very-long-ranking-index-builder-with-an-extended-name-to-check-wrapping.ts | 12 +++++++++++',
  ' 4 files changed, 22 insertions(+), 2 deletions(-)',
].join('\n');

const handoffProjection = {
  state: 'current',
  label: 'Ready for manual integration',
  handoff: {
    schemaVersion: 1,
    kind: 'turing_goal_manual_integration_handoff',
    handoffId: HANDOFF_ID,
    goalId: UI3_IDS.handoff,
    definition: {
      version: 1,
      hash: docsV1.definitionHash,
      approvalId: 'fixture-ui3-approval-definition-v1',
      approvalIdentityDigest: 'fixture-ui3-digest-approval',
    },
    finalAcceptance: {
      approvalId: 'fixture-ui3-approval-final-docs',
      identityDigest: 'fixture-ui3-digest-final',
    },
    repository: {
      projectId: PROJECT_DOCS,
      identity: 'fixture-ui3-repository',
      objectFormat: 'sha1',
      scope: 'fixture-scope',
    },
    source: {
      goalRef: 'goal/fixture-docs-search',
      commit: 'fixture9c8b7a6d5e4f3a2b1c0d',
      tree: 'fixture-ui3-tree-source',
    },
    target: {
      baseBranch: 'main',
      baseRef: 'refs/heads/main',
      observedBaseCommit: 'fixture1base00000000cd',
      observedBaseTree: 'fixture-ui3-tree-base',
    },
    completion: {
      identityDigest: 'fixture-ui3-digest-completion',
      findingsIdentityDigest: 'fixture-ui3-digest-findings',
    },
    review: {
      finalReviewId: 'fixture-ui3-review-final-001',
      reviewIdentityDigest: 'fixture-ui3-digest-review',
      evidenceIdentityDigest: 'fixture-ui3-digest-evidence',
      evidence: [
        {
          evidenceId: 'fixture-ui3-evidence-001',
          criterionKey: 'index-builds',
          verifierDigest: 'fixture-ui3-verifier-001',
          kind: 'test_result',
          verdict: 'satisfies',
          identityDigest: 'fixture-ui3-digest-evidence-001',
        },
      ],
      changedPathDigest: 'fixture-ui3-digest-paths',
      changedPathCount: 4,
      changedPathSummaryDigest: 'fixture-ui3-digest-summary',
      diffPreviewLimit: 4000,
      diffStatDigest: 'fixture-ui3-digest-stat',
      diffStatTruncated: false,
      diffPreviewDigest: 'fixture-ui3-digest-preview',
      diffPreviewTruncated: false,
    },
    projection: {
      changedPaths: [
        'fixture/docs/search/build.ts',
        'fixture/docs/search/rank.ts',
        'fixture/docs/search/index.md',
        'fixture/docs/search/very-long-ranking-index-builder-with-an-extended-name-to-check-wrapping.ts',
      ],
      changedPathsTruncated: false,
      diffStat: HANDOFF_DIFF_STAT,
      diffPreview: HANDOFF_DIFF_PREVIEW,
      inspectionCommands: [
        `git -C <fixture-repository> log --oneline fixture9c8b7a6d5e4f3a2b1c0d -1`,
        `git -C <fixture-repository> diff --stat fixture1base00000000cd...fixture9c8b7a6d5e4f3a2b1c0d`,
      ],
      manualIntegrationRequired: true,
      warning:
        'Fixture: Turing prepared this handoff. You integrate it yourself. Turing does not change your branch.',
    },
    createdAt: at(60),
    handoffDigest: 'fixture-ui3-digest-handoff',
  },
  reason: null,
  actualApplication: 'not_performed_by_turing',
  goalCompletion: 'not_completed_by_handoff',
} satisfies GoalManualHandoffProjection;

const handoffList = {
  handoffs: [
    {
      handoffId: HANDOFF_ID,
      createdAt: at(60),
      definitionVersion: 1,
      sourceCommit: 'fixture9c8b7a6d5e4f3a2b1c0d',
      handoffDigest: 'fixture-ui3-digest-handoff',
    },
  ],
  limit: 50,
  nextOffset: null,
} satisfies GoalManualHandoffListResponse;

const externalStatus = {
  goalId: UI3_IDS.handoff,
  handoffId: HANDOFF_ID,
  hasAttestation: true,
  attestations: [
    {
      attestationId: HANDOFF_ATTESTATION_ID,
      actionDigest: DIGEST.attestAction,
      recordDigest: DIGEST.attestRecord,
      approvalId: HANDOFF_ATTESTATION_APPROVAL_ID,
      observedAt: at(90),
      decidedAt: at(90),
    },
  ],
  approvals: [
    {
      approvalId: HANDOFF_ATTESTATION_APPROVAL_ID,
      actionDigest: DIGEST.attestAction,
      status: 'approved',
      decidedBy: 'user',
      createdAt: at(92),
      respondedAt: at(90),
      attestationId: HANDOFF_ATTESTATION_ID,
    },
  ],
  limit: 50,
  attestationsHaveMore: false,
  approvalsHaveMore: false,
} satisfies GoalExternalIntegrationStoredStatus;

const externalVerification = {
  state: 'not_integrated',
  observation: null,
  proofLimitations: { contentPreservation: 'not_proven', goalCompletion: 'not_completed_by_attestation' },
  reason: {
    code: 'destination_not_at_source',
    message: 'Fixture: the recorded base branch does not contain the source commit yet.',
  },
} satisfies GoalExternalIntegrationVerification;

// ---- Attestation and decided completion (desktop Handoff tab) ----------------------------------------------------------

/** The recorded attestation of the handoff. Its shape is the one `isAttestationProjectionFor` checks. */
const handoffAttestation = {
  kind: 'turing_goal_external_integration_attestation',
  schemaVersion: 1,
  goalId: UI3_IDS.handoff,
  completionContractVersion: 2,
  attestationId: HANDOFF_ATTESTATION_ID,
  approvalId: HANDOFF_ATTESTATION_APPROVAL_ID,
  handoff: { id: HANDOFF_ID, digest: DIGEST.handoff },
  definition: { version: 1, hash: docsV1.definitionHash, approvalId: 'fixture-ui3-approval-definition-v1' },
  review: {
    finalReviewId: 'fixture-ui3-review-final-001',
    acceptanceApprovalId: 'fixture-ui3-approval-final-docs',
    evidenceIdentityDigest: DIGEST.evidence,
  },
  repository: {
    projectId: PROJECT_DOCS,
    identity: 'fixture-ui3-repository',
    scope: 'fixture-scope',
    objectFormat: 'sha1',
  },
  source: {
    ref: 'goal/fixture-docs-search',
    commit: 'fixture9c8b7a6d5e4f3a2b1c0d',
    tree: 'fixture-ui3-tree-source',
  },
  destination: {
    ref: 'refs/heads/main',
    expectedBaseCommit: 'fixture1base00000000cd',
    expectedBaseTree: 'fixture-ui3-tree-base',
    observedCommit: 'fixture9c8b7a6d5e4f3a2b1c0d',
    observedTree: 'fixture-ui3-tree-source',
  },
  proof: {
    mode: 'source_history_observed',
    sourceAncestor: true,
    baseAncestor: true,
    verifierVersion: 1,
    evidenceDigest: DIGEST.evidence,
  },
  decision: { value: 'confirm_external_integration', decidedBy: 'user', decidedAt: at(90) },
  observedAt: at(90),
  actionDigest: DIGEST.attestAction,
  recordDigest: DIGEST.attestRecord,
} satisfies GoalExternalIntegrationAttestationRecord;

const handoffAttestationProjection = {
  state: 'current',
  record: handoffAttestation,
  reason: null,
  claim: 'source_history_observed_at_recorded_time',
  contentPreservation: 'not_proven',
  goalCompletion: 'not_completed_by_attestation',
} satisfies GoalExternalIntegrationAttestationProjection;

const handoffCorrectionHistory = {
  goalId: UI3_IDS.handoff,
  handoffId: HANDOFF_ID,
  attestationId: HANDOFF_ATTESTATION_ID,
  standing: {
    goalId: UI3_IDS.handoff,
    attestationId: HANDOFF_ATTESTATION_ID,
    standing: 'active_uncontested',
    correctionCount: 0,
    tip: null,
    invalidCode: null,
  },
  corrections: [],
  chainPosition: 'fixture-ui3-chain-handoff-000',
  pending: [],
  pendingUnreadableCount: 0,
} satisfies GoalAttestationCorrectionHistory;

/** The Goal is still reviewing, so no completion stands. One eligible decision is recorded, so the Complete control renders. */
const handoffNotCompletedStanding = {
  schemaVersion: 1,
  goalId: UI3_IDS.handoff,
  status: { goalStatus: 'reviewing', completedAt: null, reasonCode: null },
  claim: {
    unqualifiedSuccessAllowed: false,
    trustedForDownstream: false,
    qualifier: 'not_completed',
    contentPreservation: 'not_proven',
  },
  kind: 'not_completed',
  standing: null,
} satisfies GoalCompletionStanding;

const handoffCompletionStatus = {
  goalId: UI3_IDS.handoff,
  state: 'decided',
  decisions: [
    {
      approvalId: HANDOFF_DECISION_APPROVAL_ID,
      actionDigest: DIGEST.completionAction,
      attestationId: HANDOFF_ATTESTATION_ID,
      status: 'approved',
      valid: true,
      invalidReason: null,
      eligibility: 'eligible',
      correctionStanding: 'active_uncontested',
    },
  ],
  completion: null,
  completionStanding: handoffNotCompletedStanding,
} satisfies GoalExternalCompletionStatus;

// ---- Routes ------------------------------------------------------------------------------------------------------------

const detailFor = (id: string | undefined): GoalDetail | null => (id ? (DETAILS[id] ?? null) : null);
const unknownGoal = { error: 'Fixture: no Goal with that id.' };

/**
 * The UI.3 route table. Every Goal endpoint the list, the cockpit tabs and the Handoff tab read is answered here, from the
 * fixtures above. The rest of the shell comes from `populatedRoutes`, unchanged.
 */
export const goalCockpitRoutes: Record<string, unknown> = {
  ...populatedRoutes,
  '/api/goals': ui3List,
  '/api/goals/:id': (_url: URL, _method: string, params: Record<string, string>) => {
    const goal = detailFor(params.id);
    return goal ? { goal } : unknownGoal;
  },
  '/api/goals/:id/preview': (_url: URL, _method: string, params: Record<string, string>) => {
    const goal = detailFor(params.id);
    return goal ? { preview: previewOf(goal) } : unknownGoal;
  },
  '/api/goals/:id/definitions': (_url: URL, _method: string, params: Record<string, string>) => ({
    definitions: (DEFINITIONS[params.id ?? ''] ?? []).map(summaryOf),
  }),
  '/api/goals/:id/definitions/:version': (_url: URL, _method: string, params: Record<string, string>) => {
    const found = (DEFINITIONS[params.id ?? ''] ?? []).find((row) => String(row.version) === params.version);
    return found ? { definition: found } : unknownGoal;
  },
  '/api/goals/:id/handoffs': (_url: URL, _method: string, params: Record<string, string>) =>
    params.id === UI3_IDS.handoff ? handoffList : { handoffs: [], limit: 50, nextOffset: null },
  '/api/goals/:id/handoffs/:handoffId': (_url: URL, _method: string, params: Record<string, string>) =>
    params.id === UI3_IDS.handoff && params.handoffId === HANDOFF_ID
      ? { projection: handoffProjection }
      : unknownGoal,
  '/api/goals/:id/handoffs/:handoffId/external-integration': (
    _url: URL,
    _method: string,
    params: Record<string, string>,
  ) => (params.id === UI3_IDS.handoff && params.handoffId === HANDOFF_ID ? externalStatus : unknownGoal),
  '/api/goals/:id/handoffs/:handoffId/external-integration/attestations/:attestationId': (
    _url: URL,
    _method: string,
    params: Record<string, string>,
  ) =>
    params.id === UI3_IDS.handoff &&
    params.handoffId === HANDOFF_ID &&
    params.attestationId === HANDOFF_ATTESTATION_ID
      ? { projection: handoffAttestationProjection }
      : unknownGoal,
  '/api/goals/:id/handoffs/:handoffId/external-integration/attestations/:attestationId/corrections': (
    _url: URL,
    _method: string,
    params: Record<string, string>,
  ) =>
    params.id === UI3_IDS.handoff &&
    params.handoffId === HANDOFF_ID &&
    params.attestationId === HANDOFF_ATTESTATION_ID
      ? handoffCorrectionHistory
      : unknownGoal,
  '/api/goals/:id/completion': (_url: URL, _method: string, params: Record<string, string>) =>
    params.id === UI3_IDS.handoff ? handoffCompletionStatus : unknownGoal,
  '/api/goals/:id/handoffs/:handoffId/external-integration/verification': (
    _url: URL,
    _method: string,
    params: Record<string, string>,
  ) =>
    params.id === UI3_IDS.handoff && params.handoffId === HANDOFF_ID
      ? { verification: externalVerification }
      : unknownGoal,
  '/api/approvals/unified': (url: URL): UnifiedApprovalsResponse => {
    const goalId = url.searchParams.get('goalId');
    const approvals = goalId
      ? UNIFIED_APPROVALS.filter((approval) => approval.goalId === goalId)
      : UNIFIED_APPROVALS;
    return { approvals, total: approvals.length, limit: 20 };
  },
  // The cockpit subscribes to a Goal's event stream. This fixture is a stream with no events, so nothing is pushed.
  '/api/events': new RawResponse('text/event-stream', ': fixture stream with no events\n\n'),
};
