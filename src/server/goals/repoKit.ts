import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CompletionPolicy,
  GoalDefinition,
  GoalHumanGates,
  GoalMilestoneSpec,
  SuccessCriterion,
} from '../../shared/goals.js';
import { openDatabase, type Db } from '../db.js';
import { requestGoalApproval, decideGoalApproval } from './approvals.js';
import { approveDefinition, createGoalDraft, loadDefinitionVersion } from './definitions.js';
import { validDefinition } from './testKit.js';
import { verifierDigest } from './verifierDigest.js';

/**
 * The explicit per-test timeout for every test that builds a real Git repository or fixture (enforced by
 * goalRealGitTimeoutGuard.test.ts). Measured locally on 2026-10-11 on the final D.3E commit 1 tree, one file at a time
 * under the repository's serialized Vitest config (maxWorkers 1), across the 62 real-Git test files (1218 tests, all
 * passing): slowest real-Git test 5.0 s (goalE2E.test.ts, "runs a proposal through final-apply readiness"); next
 * slowest 4.0 s (externalCompletionDecision.test.ts, D18); slowest version-2 destination-ref case 3.1 s
 * (manualHandoff.test.ts, A3, sha1 and sha256). 30 s is 6x the slowest measured test. Do not raise the global Vitest
 * timeout to hide a slow test; fix the fixture cost or change this value with new data.
 */
export const REAL_GIT_TEST_TIMEOUT_MS = 30_000;

const folders: string[] = [];
const databases: Db[] = [];

/** Closes every fixture database, then removes the temporary repositories. Call from `afterEach`. */
export function cleanupRepoFixtures(): void {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

export interface DefinitionOptions {
  criteria?: SuccessCriterion[];
  milestones?: GoalMilestoneSpec[];
  policy?: Partial<CompletionPolicy>;
  gates?: Partial<GoalHumanGates>;
}

export const BUILD: SuccessCriterion = {
  key: 'build',
  statement: 'The project builds',
  verification: [{ kind: 'build', command: ['npm', 'run', 'build'] }],
  required: true,
};
export const TESTS: SuccessCriterion = {
  key: 'tests',
  statement: 'Tests pass',
  verification: [{ kind: 'test' }],
  required: true,
};

export function milestone(
  key: string,
  criteria: string[],
  over: Partial<GoalMilestoneSpec> = {},
): GoalMilestoneSpec {
  return {
    key,
    title: key,
    objective: `Deliver ${key}`,
    criteria,
    dependsOn: [],
    allowedScope: { includeGlobs: ['src/**'], excludeGlobs: [] },
    requiredEvidence: [],
    reviewRequirements: { milestoneReview: false },
    ...over,
  };
}

/**
 * A small valid definition whose completion needs only deterministic evidence by default: no final review, no user
 * acceptance, result left on the Goal branch, no human gates. Tests switch requirements on one at a time.
 */
export function simpleDefinition(options: DefinitionOptions = {}): GoalDefinition {
  const definition = validDefinition();
  definition.contract.successCriteria = options.criteria ?? [structuredClone(BUILD), structuredClone(TESTS)];
  definition.contract.deliverables = [];
  definition.contract.completionPolicy = {
    requireFinalReview: false,
    requireUserAcceptance: false,
    applyToBase: 'leave-on-goal-branch',
    maxOpenFindings: { critical: 0, high: 0 },
    highSeverityResolution: 'review-plus-head-bound-verifier',
    ...options.policy,
  };
  definition.milestones = options.milestones ?? [milestone('m1', ['build', 'tests'])];
  definition.review.final = options.policy?.requireFinalReview ?? false;
  definition.review.onMilestoneComplete = definition.milestones.some(
    (spec) => spec.reviewRequirements.milestoneReview,
  );
  definition.limits.humanGates = {
    eachCycle: false,
    beforeMilestoneComplete: false,
    poolRouteFirstUse: false,
    finalAcceptance: false,
    ...options.gates,
  };
  return definition;
}

export interface GoalRepoFixture {
  db: Db;
  repo: string;
  baseCommit: string;
  projectId: string;
  goalId: string;
  definition: GoalDefinition;
  git(...args: string[]): string;
  /** Writes (or, with null, deletes) files relative to the project root, commits, and moves the Goal ref there. */
  advance(files: Record<string, string | null>, message?: string): { commit: string; tree: string };
  /** Commits like `advance` but leaves the Goal ref where it is (a commit not in Goal history). */
  sideCommit(files: Record<string, string | null>): string;
  /** A root commit with no parent: in no Goal history. */
  orphanCommit(): string;
  head(): string;
  tree(commit?: string): string;
  digest(criterionKey: string, verifierIndex?: number, version?: number): string;
  /** Creates a milestone runtime row id lookup. */
  milestoneId(key: string): string;
  /** Records a decided user approval for a gate (requested then approved/denied by the user). */
  approval(
    gate: Parameters<typeof requestGoalApproval>[1]['gate'],
    detail: Record<string, unknown>,
    decision?: 'approved' | 'denied',
  ): string;
  currentHash(): string;
}

/** Test-only digest for a copied row. The value is a real 64-character lowercase hex digest. */
export function testDigest(label: string): string {
  return createHash('sha256').update(`repoKit-test-digest:${label}`).digest('hex');
}

/**
 * Inserts a copy of one `goal_approvals` row whose two digest columns are replaced. Every other column is copied, so
 * the copy differs from its source only in the digest columns named here. Callers must drop the matching insert guard
 * trigger inside their own disposable database first; the guard would otherwise refuse the copy.
 */
export function copyGoalApprovalRow(
  db: Db,
  sourceId: string,
  digests: { externalCompletion: string | null; attestationCorrection: string | null },
): string {
  const row = db.prepare('SELECT * FROM goal_approvals WHERE id = ?').get(sourceId) as Record<
    string,
    unknown
  >;
  // Approvals are inserted pending and decided once by UPDATE, so the copy follows that path with the source's decision.
  const copy: Record<string, unknown> = {
    ...row,
    id: randomUUID(),
    status: 'pending',
    decided_by: null,
    decision_note: null,
    responded_at: null,
    external_completion_action_digest: digests.externalCompletion,
    attestation_correction_action_digest: digests.attestationCorrection,
  };
  insertCopy(db, 'goal_approvals', copy);
  db.prepare(
    'UPDATE goal_approvals SET status = ?, decided_by = ?, decision_note = ?, responded_at = ? WHERE id = ?',
  ).run(row.status, row.decided_by, row.decision_note, row.responded_at, copy.id);
  return copy.id as string;
}

/**
 * Inserts a copy of one `goal_evidence` row that points at another approval. Used to show how freshness judges the same
 * evidence when only its approval differs. Evidence rows are immutable, so only a fresh row can be copied.
 */
export function copyGoalEvidenceRow(db: Db, sourceId: string, approvalId: string): string {
  const row = db.prepare('SELECT * FROM goal_evidence WHERE id = ?').get(sourceId) as Record<string, unknown>;
  const copy: Record<string, unknown> = {
    ...row,
    id: randomUUID(),
    ref_json: JSON.stringify({ ...(JSON.parse(row.ref_json as string) as object), approvalId }),
  };
  insertCopy(db, 'goal_evidence', copy);
  return copy.id as string;
}

function insertCopy(db: Db, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((column) => row[column] as string | number | null));
}

/** Creates a real temporary Git repository and Goal; approval and Goal-ref initialization are on by default. */
export function goalRepoFixture(
  options: {
    definition?: GoalDefinition;
    subdir?: string;
    initialFiles?: Record<string, string>;
    approved?: boolean;
    initializeRef?: boolean;
    objectFormat?: 'sha1' | 'sha256';
  } = {},
): GoalRepoFixture {
  const root = mkdtempSync(join(tmpdir(), 'turing-goalrepo-'));
  folders.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main', `--object-format=${options.objectFormat ?? 'sha1'}`);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  const projectPath = options.subdir ? join(repo, options.subdir) : repo;
  const write = (files: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(projectPath, path);
      if (content === null) rmSync(full, { force: true });
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
  };
  write({
    'src/parser.ts': 'export const parse = 1;\n',
    'docs/README.md': '# docs\n',
    ...options.initialFiles,
  });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  const base = git(repo, 'rev-parse', 'HEAD');

  const db = openDatabase(root);
  databases.push(db);
  const machine = (
    db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
  ).value;
  const projectId = randomUUID();
  db.prepare(
    "INSERT INTO projects (id, machine_id, name, path, git_root, created_at) VALUES (?, ?, 'P', ?, ?, '2026-01-01T00:00:00.000Z')",
  ).run(projectId, machine, projectPath, repo);
  const definition = options.definition ?? simpleDefinition();
  const { goalId } = createGoalDraft(db, { projectId, title: 'G', definition });
  const ref = `refs/heads/turing/goal/${goalId}`;
  if (options.approved !== false) approveDefinition(db, { goalId, version: 1, actor: 'user' });
  if (options.initializeRef !== false) {
    git(repo, 'update-ref', ref, base);
    db.prepare(
      'UPDATE goal_runtime SET integration_head = ?, goal_branch = ?, base_branch = ?, base_commit = ? WHERE goal_id = ?',
    ).run(base, `turing/goal/${goalId}`, 'main', base, goalId);
  }

  const commitFiles = (files: Record<string, string | null>, message: string) => {
    write(files);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--allow-empty', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const tree = (commit: string) => git(repo, 'rev-parse', `${commit}^{tree}`);
  let approvalSequence = 0;
  return {
    db,
    repo,
    baseCommit: base,
    projectId,
    goalId,
    definition,
    git: (...args) => git(repo, ...args),
    advance(files, message = 'advance') {
      const commit = commitFiles(files, message);
      git(repo, 'update-ref', ref, commit);
      db.prepare('UPDATE goal_runtime SET integration_head = ? WHERE goal_id = ?').run(commit, goalId);
      return { commit, tree: tree(commit) };
    },
    sideCommit(files) {
      const before = git(repo, 'rev-parse', 'HEAD');
      const commit = commitFiles(files, 'side');
      git(repo, 'reset', '-q', '--hard', before);
      return commit;
    },
    orphanCommit() {
      return git(repo, 'commit-tree', tree(base), '-m', `orphan ${approvalSequence++}`);
    },
    head: () =>
      (
        db.prepare('SELECT integration_head AS h FROM goal_runtime WHERE goal_id = ?').get(goalId) as {
          h: string;
        }
      ).h,
    tree: (commit) =>
      tree(
        commit ??
          (
            db.prepare('SELECT integration_head AS h FROM goal_runtime WHERE goal_id = ?').get(goalId) as {
              h: string;
            }
          ).h,
      ),
    digest(criterionKey, verifierIndex = 0, version = 1) {
      const def = loadDefinitionVersion(db, goalId, version)!.definition;
      const criterion = def.contract.successCriteria.find((candidate) => candidate.key === criterionKey)!;
      return verifierDigest(criterionKey, criterion.verification[verifierIndex]!);
    },
    milestoneId: (key) =>
      (
        db
          .prepare('SELECT id FROM goal_milestones WHERE goal_id = ? AND milestone_key = ?')
          .get(goalId, key) as { id: string }
      ).id,
    approval(gate, detail, decision = 'approved') {
      approvalSequence++;
      const request = requestGoalApproval(db, {
        goalId,
        gate,
        risk: 'low',
        reason: 'test',
        requestedBy: 'supervisor',
        detail,
      });
      decideGoalApproval(db, { goalId, approvalId: request.id, decision, decidedBy: 'user' });
      return request.id;
    },
    currentHash: () =>
      (
        db
          .prepare(
            'SELECT d.definition_hash AS h FROM goals g JOIN goal_definition_versions d ON d.goal_id = g.id AND d.version = g.current_definition_version WHERE g.id = ?',
          )
          .get(goalId) as { h: string }
      ).h,
  };
}

/** A ReviewReport with every field present; tests override what they care about. */
export function reportOf(over: Partial<import('../../shared/goals.js').ReviewReport> = {}) {
  return {
    verdict: 'pass' as const,
    criterionProgress: [],
    existingFindings: [],
    newFindings: [],
    regressions: [],
    scopeDrift: false,
    architectureDrift: false,
    furtherWorkJustified: false,
    ...over,
  };
}

export function newFinding(over: Record<string, unknown> = {}) {
  return {
    severity: 'high' as const,
    category: 'correctness',
    description: 'Parser drops the last token',
    evidence: 'see parse()',
    affectedFiles: ['src/parser.ts'],
    remediation: 'keep it',
    ...over,
  };
}

/** Records fresh passing build and test evidence for the current integration tree. */
export async function passDeterministic(fx: GoalRepoFixture, now?: string): Promise<void> {
  const { recordEvidence } = await import('./evidence.js');
  for (const [key, kind] of [
    ['build', 'build_result'],
    ['tests', 'test_result'],
  ] as const)
    await recordEvidence(fx.db, {
      goalId: fx.goalId,
      definitionVersion: 1,
      criterionKey: key,
      verifierDigest: fx.digest(key),
      kind,
      verdict: 'satisfies',
      subjectTree: fx.tree(),
      now,
    });
}
