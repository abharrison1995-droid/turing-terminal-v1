import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static protection for completion authority in production server code. The shared scanner below is the only place
 * these rules are defined. Each rule is checked against every non-test production file under src/server (test files
 * and fixture kits are excluded), and each rule has a seeded violation and a negative control.
 */

const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
const KIT_FILE_NAMES = new Set([
  'goalV2TestKit.ts',
  'repoKit.ts',
  'testKit.ts',
  'fakeExecutor.ts',
  'testPlanProvider.ts',
]);

/**
 * The completion-action identifier allow-list of production files. It starts as the D.3D set; D.3E commit 2 adds the
 * proof-bound terminal writer, the only file that writes proofs or consumes decisions. Each entry is checked for drift
 * by the `only_in` rule below. `finalApplyAuthority.ts` is a refusal-only consumer (D.3E F2).
 */
const D3D_COMPLETION_IDENTIFIER_FILES = [
  'goals/approvals.ts',
  // D.4R Slice 1: the read-only classifier and the leaf module that reads completion-decision rows.
  'goals/completionAuthorityPolicy.ts',
  'goals/evidence.ts',
  'goals/externalCompletionDecision.ts',
  'goals/externalCompletionDecisionRows.ts',
  'goals/externalCompletionPreflight.ts',
  'goals/externalCompletionProof.ts',
  'goals/externalCompletionTerminal.ts',
  // legacy final-apply refuses completion and correction approvals (refusal only; D.3E F2)
  'goals/finalApplyAuthority.ts',
  'goals/freshness.ts',
  'goals/goalCommands.ts',
] as const;

interface AuthorityRule {
  id: string;
  pattern: RegExp;
  /**
   * `only_in`: the production files that match must be exactly `files`, so the allow-list cannot go stale or grow.
   * `never_in`: no production match may appear in any of `files`.
   */
  mode: 'only_in' | 'never_in';
  files: readonly string[];
  reason: string;
  /** When true, the rule also scans the non-test sources under src/shared (paths prefixed `shared/`). */
  includeShared?: boolean;
}

/**
 * SQL separator: whitespace or a block comment, so `INSERT /**\/ INTO` is one gap. Line comments (`--`) are not matched.
 */
const SQL_GAP = String.raw`(?:\s|/\*[\s\S]*?\*/)+`;
/** An optional schema qualifier (`main.`, `"main".`) and an optional opening quote or bracket before a table name. */
const SQL_TABLE_PREFIX = String.raw`(?:["\`\[]?\w+["\`\]]?\s*\.\s*)?["\`\[]?`;
/** `INSERT`, `INSERT OR <conflict>`, `REPLACE` into the proof table, or `UPDATE` / `DELETE FROM` it, in any casing. */
const PROOF_WRITE_SQL = new RegExp(
  String.raw`\b(?:insert|replace)${SQL_GAP}(?:or${SQL_GAP}\w+${SQL_GAP})?into${SQL_GAP}${SQL_TABLE_PREFIX}goal_external_completion_proofs\b` +
    String.raw`|\bupdate${SQL_GAP}(?:or${SQL_GAP}\w+${SQL_GAP})?${SQL_TABLE_PREFIX}goal_external_completion_proofs\b` +
    String.raw`|\bdelete${SQL_GAP}from${SQL_GAP}${SQL_TABLE_PREFIX}goal_external_completion_proofs\b`,
  'i',
);
/**
 * Any `UPDATE` of the goals table whose SET list assigns `status`, whatever its position in the list. Covers schema
 * qualifiers, quoted names and `OR <conflict>`. The SET list ends at `WHERE`, `;` or a backtick, so a `status` in a
 * WHERE clause or a later statement does not count. Does not cover `status` reached by string concatenation.
 */
const GOAL_STATUS_WRITE_SQL = new RegExp(
  String.raw`\bupdate${SQL_GAP}(?:or${SQL_GAP}\w+${SQL_GAP})?${SQL_TABLE_PREFIX}goals["\`\]]?${SQL_GAP}set${SQL_GAP}` +
    String.raw`(?:(?!\bwhere\b)[^;\`])*?(?<!\w)["\`\[]?status["\`\]]?\s*=`,
  'i',
);

/**
 * The read-only classifier and its row reader name no writer, no SQL write statement and no statement runner. Writers
 * are named with word boundaries; SQL uses the same whitespace-or-block-comment gap as the rules above.
 */
const CLASSIFIER_WRITE_PATTERN = new RegExp(
  String.raw`\b(?:requestGoalApproval|decideGoalApproval|recordExternalCompletionDecision|completeGoalFromExternalDecision|consumeExternalCompletionDecision|appendAttestationCorrection|requestAttestationCorrectionApproval|writeGoalEvent|transitionGoal)\b` +
    String.raw`|\b(?:insert${SQL_GAP}into|replace${SQL_GAP}into|update${SQL_GAP}\w+${SQL_GAP}set|delete${SQL_GAP}from)\b` +
    String.raw`|\.run\(|\.exec\(`,
  'i',
);
/**
 * Imports of the modules the classifier must not depend on (the preflight, the writers, the locks and the routes),
 * and the identifiers that reach into the preflight or the internal recorded-decision option.
 */
const CLASSIFIER_ISOLATION_PATTERN =
  /from\s+["'][^"']*\/(?:externalCompletionPreflight|externalCompletionDecision|externalCompletionTerminal|externalCompletion|externalCompletionApi|goalCompletionLock|goalRoutes)\.js["']|\b(?:computeExternalCompletionPreflight|computeEmptyCorrectionChainIdentity|readPreflightSnapshotIdentity|allowRecordedDecision)\b/;

const RULES: readonly AuthorityRule[] = [
  {
    id: 'proof_write',
    // Covers the proof table with or without a schema qualifier or quotes, and with block comments or newlines between
    // keywords. Does not cover line comments or table names built by string concatenation.
    pattern: PROOF_WRITE_SQL,
    mode: 'only_in',
    files: ['goals/externalCompletionTerminal.ts'],
    reason:
      'Only the proof-bound terminal writer may write a completion proof. Its single INSERT is reviewed with the terminal authority.',
  },
  {
    id: 'decision_reader',
    pattern: /\b(?:readExternalCompletionDecision|listExternalCompletionDecisions)\b/,
    mode: 'only_in',
    // externalCompletion.ts reads the decision to replay a stored completion and to re-check it before the terminal write.
    files: [
      'goals/externalCompletionApi.ts',
      'goals/externalCompletionDecision.ts',
      // Defines the readers that the decision module re-exports (D.4R Slice 1).
      'goals/externalCompletionDecisionRows.ts',
      'goals/externalCompletionTerminal.ts',
      'goals/externalCompletion.ts',
    ],
    reason:
      'Only the decision module, the proof-bound terminal authority and the atomic completion service name the decision readers. The read-only D.4A status and lookup adapter may read a decision. No other production consumer reads a decision.',
  },
  {
    id: 'decision_record',
    pattern: /\brecordExternalCompletionDecision\b/,
    mode: 'only_in',
    files: ['goals/externalCompletionDecision.ts', 'goals/goalRoutes.ts'],
    reason:
      'Only the decision module names the decision recorder. The D.4A route layer is the only caller besides the decision module.',
  },
  {
    id: 'completion_service',
    pattern: /\bcompleteGoalFromExternalDecision\b/,
    mode: 'only_in',
    files: ['goals/externalCompletion.ts', 'goals/goalRoutes.ts'],
    reason:
      'Only the atomic version-2 completion service names its entry point. The D.4A route layer is the only route caller.',
  },
  {
    id: 'correction_decision_service',
    pattern: /\bdecideAttestationCorrectionAsUser\b/,
    mode: 'only_in',
    files: ['goals/attestationCorrectionDecision.ts', 'goals/goalRoutes.ts'],
    reason:
      'Only the dedicated correction decision service names its entry point. The D.4C route layer is the only caller.',
  },
  {
    id: 'correction_request_service',
    pattern: /\brequestAttestationCorrectionAsUser\b/,
    mode: 'only_in',
    files: ['goals/attestationCorrectionRequest.ts', 'goals/goalRoutes.ts'],
    reason:
      'Only the dedicated correction request service names its entry point. The D.4D route layer is the only caller.',
  },
  {
    id: 'correction_raw_creator',
    // The raw creator inserts a pending correction approval without the request service's CAS and duplicate checks.
    pattern: /\brequestAttestationCorrectionApproval\b/,
    mode: 'only_in',
    files: ['goals/attestationCorrection.ts', 'goals/attestationCorrectionRequest.ts'],
    reason:
      'Only the correction ledger and the dedicated request service may call the raw correction approval creator. No route or read calls it directly.',
  },
  {
    id: 'completion_consume',
    pattern: /\b(?:consumeExternalCompletionDecision|selectCompletionDecision)\b/,
    mode: 'only_in',
    files: ['goals/externalCompletion.ts', 'goals/externalCompletionTerminal.ts'],
    reason:
      'Only the proof-bound terminal authority and the atomic completion service may select or consume a completion decision.',
  },
  {
    id: 'completion_reason',
    pattern:
      /\b(?:EXTERNAL_COMPLETION_REASON|external_completion_user_confirmed|external_completion_recorded)\b/,
    mode: 'only_in',
    files: [
      'goals/events.ts',
      'goals/externalCompletion.ts',
      'goals/externalCompletionTerminal.ts',
      'shared/goals.ts',
    ],
    includeShared: true,
    reason:
      'Only the event vocabulary, the proof-bound terminal writer and the atomic completion service may name the external completion reason or event.',
  },
  {
    id: 'completion_identifier',
    pattern:
      /externalCompletionActionDigest|external_completion_action_digest|complete_goal_external_integration_v2|goal_external_completion_proofs/,
    mode: 'only_in',
    files: D3D_COMPLETION_IDENTIFIER_FILES,
    reason: 'Only the D.3D allow-listed production files may name completion-action identifiers.',
  },
  {
    id: 'goal_status_write',
    // Covers `status` at any position in the SET list, quoted or schema-qualified goals, and OR <conflict> forms.
    pattern: GOAL_STATUS_WRITE_SQL,
    mode: 'only_in',
    files: ['goals/stateMachine.ts', 'goals/externalCompletionTerminal.ts'],
    reason:
      'Only the state machine and the proof-bound terminal writer write goal status. The terminal writes it once, to completed, after its checks.',
  },
  {
    id: 'preflight_isolation',
    pattern:
      /from\s+["'][^"']*\/(?:externalCompletion|externalCompletionTerminal|externalCompletionDecision|goalCompletionLock)\.js["']|\b(?:externalCompletionDecision|externalCompletionTerminal|goalCompletionLock|recordExternalCompletionDecision|readExternalCompletionDecision|listExternalCompletionDecisions|withGoalCompletionLock|completeGoalFromExternalDecision)\b/,
    mode: 'never_in',
    files: ['goals/externalCompletionPreflight.ts'],
    reason: 'The preflight is read-only and cannot depend on the modules that write completion decisions.',
  },
  {
    id: 'classifier_entry',
    pattern: /\bclassifyCompletionAuthority\b/,
    mode: 'only_in',
    files: [
      'goals/completionAuthorityPolicy.ts',
      'goals/externalCompletionPreflight.ts',
      'goals/externalCompletionDecision.ts',
      'goals/externalCompletionTerminal.ts',
      'goals/externalCompletionApi.ts',
    ],
    reason:
      'Only the completion authority classifier module, the public preflight, the decision service and the terminal consumer name its entry point. Slice 2a adds the preflight caller; Slice 2b adds the decision caller, which classifies inside its transaction; Slice 2c adds the terminal caller, which re-classifies inside the completion transaction. Slice 3 adds the read-only status shaper, which reads the classifier entries for eligibility and never writes. A later caller must extend this list in the same commit.',
  },
  {
    id: 'classifier_not_writer',
    pattern: CLASSIFIER_WRITE_PATTERN,
    mode: 'never_in',
    files: ['goals/completionAuthorityPolicy.ts', 'goals/externalCompletionDecisionRows.ts'],
    reason:
      'The classifier and the completion-decision row reader are read-only: they name no writer, no SQL write statement and no statement runner.',
  },
  {
    id: 'classifier_isolation',
    pattern: CLASSIFIER_ISOLATION_PATTERN,
    mode: 'never_in',
    files: ['goals/completionAuthorityPolicy.ts', 'goals/externalCompletionDecisionRows.ts'],
    reason:
      'The classifier and the row reader are leaf modules: they cannot import the preflight, the decision writer, the terminal, the locks or the routes, and they cannot reach the preflight identity or the recorded-decision option.',
  },
  {
    id: 'allow_recorded_decision_callers',
    pattern: /\ballowRecordedDecision\b/,
    mode: 'only_in',
    // Pins the current callers. This slice changes no behaviour: the option keeps its meaning in these three modules.
    files: [
      'goals/externalCompletionDecision.ts',
      'goals/externalCompletionPreflight.ts',
      'goals/externalCompletionTerminal.ts',
    ],
    reason:
      'Only the three completion modules that name the internal recorded-decision option may name it. A new caller must be reviewed and added here.',
  },
];

function ruleById(id: string): AuthorityRule {
  const rule = RULES.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`unknown authority rule ${id}`);
  return rule;
}

/** True when one source, at one production path, breaks the rule. */
function breaksRule(rule: AuthorityRule, path: string, source: string): boolean {
  if (!rule.pattern.test(source)) return false;
  return rule.mode === 'only_in' ? !rule.files.includes(path) : rule.files.includes(path);
}

/** Every production file under src/server, excluding test files, fixture kits, and dependencies. */
function productionSources(dir = SERVER_ROOT): { path: string; source: string }[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return productionSources(full);
    const isProduction =
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !KIT_FILE_NAMES.has(name) &&
      !/Kit\.ts$/.test(name);
    return isProduction ? [{ path: relative(SERVER_ROOT, full), source: readFileSync(full, 'utf8') }] : [];
  });
}

const SHARED_ROOT = fileURLToPath(new URL('../../shared/', import.meta.url));

/** Every non-test file under src/shared, with paths prefixed `shared/`. Only rules with `includeShared` scan it. */
function sharedSources(dir = SHARED_ROOT): { path: string; source: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sharedSources(full);
    const isProduction = name.endsWith('.ts') && !name.endsWith('.test.ts') && !/Kit\.ts$/.test(name);
    return isProduction
      ? [{ path: `shared/${relative(SHARED_ROOT, full)}`, source: readFileSync(full, 'utf8') }]
      : [];
  });
}

/** Paths of the production files that match a rule's pattern, sorted. */
function matchingPaths(rule: AuthorityRule, sources: { path: string; source: string }[]): string[] {
  return sources
    .filter(({ source }) => rule.pattern.test(source))
    .map(({ path }) => path)
    .sort();
}

describe('authority static guard: production sources', () => {
  const sources = productionSources();
  const shared = sharedSources();
  const scopeFor = (rule: AuthorityRule) => (rule.includeShared ? [...sources, ...shared] : sources);

  it('scans the production server (non-vacuous) and excludes test and kit files', () => {
    expect(sources.length).toBeGreaterThan(50);
    const paths = sources.map(({ path }) => path);
    expect(paths).toEqual(
      expect.arrayContaining(['goals/stateMachine.ts', 'goals/externalCompletionDecision.ts']),
    );
    expect(paths.some((path) => /\.test\.ts$/.test(path))).toBe(false);
    expect(paths.some((path) => /Kit\.ts$/.test(path))).toBe(false);
    expect(paths).not.toContain('goals/repoKit.ts');
    expect(paths).not.toContain('goals/goalV2TestKit.ts');
  });

  it('scans src/shared (non-vacuous) for rules that include shared sources', () => {
    const paths = shared.map(({ path }) => path);
    expect(paths).toContain('shared/goals.ts');
    expect(paths.some((path) => /\.test\.ts$/.test(path))).toBe(false);
  });

  it('completion identifier allow-list is exactly the reviewed file set', () => {
    expect(ruleById('completion_identifier').files).toEqual([...D3D_COMPLETION_IDENTIFIER_FILES].sort());
    expect(D3D_COMPLETION_IDENTIFIER_FILES).toHaveLength(11);
  });

  for (const rule of RULES) {
    it(`${rule.id}: ${rule.reason}`, () => {
      const scope = scopeFor(rule);
      const offenders = scope
        .filter(({ path, source }) => breaksRule(rule, path, source))
        .map(({ path }) => path);
      expect(offenders).toEqual([]);
      if (rule.mode === 'only_in') {
        // Drift check: every allowed file still matches, so a stale entry fails rather than hiding a removal.
        expect(matchingPaths(rule, scope).filter((path) => !rule.files.includes(path))).toEqual([]);
        for (const path of rule.files) expect(scope.map((entry) => entry.path)).toContain(path);
      }
    });
  }
});

/** Every function that writes a correction, a Goal approval, a completion decision or a completion. */
const WRITER_NAMES = [
  'requestAttestationCorrectionAsUser',
  'requestAttestationCorrectionApproval',
  'decideAttestationCorrectionAsUser',
  'appendAttestationCorrection',
  'requestGoalApproval',
  'decideGoalApproval',
  'recordExternalCompletionDecision',
  'completeGoalFromExternalDecision',
] as const;

describe('authority static guard: the correction history read is read-only', () => {
  const routes = readFileSync(join(SERVER_ROOT, 'goals/goalRoutes.ts'), 'utf8');
  // The GET handler sits between its own comment and the D.4D request comment; the text in between is the handler.
  const start = routes.indexOf('// Read-only correction history and standing.');
  const end = routes.indexOf('// Correction request (D.4D).');
  const readHandler = routes.slice(start, end);

  it('locates the correction history GET handler (non-vacuous)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(readHandler).toContain('app.get(');
    expect(readHandler).toContain('listAttestationCorrectionHistory');
  });

  it.each(WRITER_NAMES)('the GET handler names no writer: %s', (name) => {
    expect(readHandler).not.toMatch(new RegExp(`\\b${name}\\b`));
  });
});

describe('authority static guard: seeded violations and negative controls', () => {
  const seeded: [rule: string, path: string, source: string][] = [
    [
      'proof_write',
      'goals/synthetic.ts',
      "db.prepare('INSERT INTO goal_external_completion_proofs (id) VALUES (?)');",
    ],
    [
      'proof_write',
      'goals/synthetic.ts',
      'db.prepare(`INSERT   INTO\n goal_external_completion_proofs (id) VALUES (?)`);',
    ],
    [
      'proof_write',
      'goals/synthetic.ts',
      'db.prepare(\'INSERT OR REPLACE INTO "goal_external_completion_proofs" (id) VALUES (?)\');',
    ],
    ['proof_write', 'goals/synthetic.ts', "db.prepare('update goal_external_completion_proofs set id = ?');"],
    ['proof_write', 'goals/synthetic.ts', 'db.prepare("DELETE\nFROM `goal_external_completion_proofs`");'],
    [
      'proof_write',
      'goals/synthetic.ts',
      "db.prepare('INSERT INTO main.goal_external_completion_proofs (id) VALUES (?)');",
    ],
    [
      'proof_write',
      'goals/synthetic.ts',
      'db.prepare(\'INSERT INTO "main"."goal_external_completion_proofs" (id) VALUES (?)\');',
    ],
    [
      'proof_write',
      'goals/synthetic.ts',
      "db.prepare('INSERT /**/ INTO goal_external_completion_proofs (id) VALUES (?)');",
    ],
    [
      'proof_write',
      'goals/synthetic.ts',
      "db.prepare('INSERT /* split */ OR REPLACE INTO main.goal_external_completion_proofs (id) VALUES (?)');",
    ],
    [
      'proof_write',
      'goals/synthetic.ts',
      "db.prepare('UPDATE main.goal_external_completion_proofs SET id = ?');",
    ],
    ['decision_reader', 'goals/synthetic.ts', 'readExternalCompletionDecision(db, goalId, approvalId);'],
    ['decision_reader', 'goals/synthetic.ts', 'const rows = listExternalCompletionDecisions(db, goalId);'],
    ['decision_record', 'goals/synthetic.ts', 'await recordExternalCompletionDecision(db, input);'],
    [
      'completion_identifier',
      'goals/synthetic.ts',
      'const row = { externalCompletionActionDigest: digest };',
    ],
    ['completion_identifier', 'goals/synthetic.ts', "const sql = 'external_completion_action_digest';"],
    ['completion_identifier', 'goals/synthetic.ts', "const kind = 'complete_goal_external_integration_v2';"],
    [
      'goal_status_write',
      'goals/synthetic.ts',
      'db.prepare("UPDATE goals SET status = \'completed\' WHERE id = ?");',
    ],
    ['goal_status_write', 'goals/synthetic.ts', 'db.prepare("update   goals\n  set status = ?");'],
    ['goal_status_write', 'goals/synthetic.ts', "db.prepare('UPDATE goals SET updated_at = ?, status = ?');"],
    ['goal_status_write', 'goals/synthetic.ts', `db.prepare('UPDATE "goals" SET status = ?');`],
    ['goal_status_write', 'goals/synthetic.ts', "db.prepare('UPDATE OR REPLACE goals SET status = ?');"],
    [
      'goal_status_write',
      'goals/synthetic.ts',
      "db.prepare('UPDATE main.goals SET updated_at = ?,\n  status = ?');",
    ],
    [
      'preflight_isolation',
      'goals/externalCompletionPreflight.ts',
      "import { recordExternalCompletionDecision } from './externalCompletionDecision.js';",
    ],
    [
      'preflight_isolation',
      'goals/externalCompletionPreflight.ts',
      "import { withGoalCompletionLock } from './goalCompletionLock.js';",
    ],
    [
      'preflight_isolation',
      'goals/externalCompletionPreflight.ts',
      "import { x } from './externalCompletionTerminal.js';",
    ],
    [
      'preflight_isolation',
      'goals/externalCompletionPreflight.ts',
      'const later = readExternalCompletionDecision(db, goalId, approvalId);',
    ],
    [
      'proof_write',
      'goals/activeWork.ts',
      "db.prepare('INSERT INTO goal_external_completion_proofs (id) VALUES (?)');",
    ],
    [
      'proof_write',
      'goals/externalCompletionPreflight.ts',
      "db.prepare('UPDATE goal_external_completion_proofs SET id = ?');",
    ],
    ['decision_reader', 'goals/activeWork.ts', 'const rows = listExternalCompletionDecisions(db, goalId);'],
    [
      'goal_status_write',
      'goals/activeWork.ts',
      `db.prepare("UPDATE goals SET status = 'completed' WHERE id = ?");`,
    ],
    ['completion_identifier', 'goals/activeWork.ts', 'const digest = row.externalCompletionActionDigest;'],
    ['completion_service', 'goals/activeWork.ts', 'await completeGoalFromExternalDecision(db, input);'],
    [
      'completion_service',
      'goals/routes.ts',
      'app.post(path, () => completeGoalFromExternalDecision(db, body));',
    ],
    [
      'correction_decision_service',
      'goals/activeWork.ts',
      'await decideAttestationCorrectionAsUser(db, input);',
    ],
    [
      'correction_decision_service',
      'goals/routes.ts',
      'app.post(path, () => decideAttestationCorrectionAsUser(db, body));',
    ],
    [
      'correction_request_service',
      'goals/activeWork.ts',
      'await requestAttestationCorrectionAsUser(db, input);',
    ],
    [
      'correction_request_service',
      'goals/routes.ts',
      'app.post(path, () => requestAttestationCorrectionAsUser(db, body));',
    ],
    [
      'correction_raw_creator',
      'goals/activeWork.ts',
      'const created = requestAttestationCorrectionApproval(db, input);',
    ],
    [
      'correction_raw_creator',
      'goals/goalRoutes.ts',
      'return requestAttestationCorrectionApproval(db, input);',
    ],
    [
      'completion_consume',
      'goals/externalCompletionDecision.ts',
      'selectCompletionDecision(db, goalId, approvalId);',
    ],
    [
      'completion_consume',
      'goals/activeWork.ts',
      'consumeExternalCompletionDecision(db, decision, proof, identity, now);',
    ],
    ['completion_reason', 'goals/activeWork.ts', 'const reason = EXTERNAL_COMPLETION_REASON;'],
    ['completion_reason', 'goals/synthetic.ts', "const type = 'external_completion_recorded';"],
    [
      'completion_reason',
      'shared/synthetic.ts',
      "export const reason = 'external_completion_user_confirmed';",
    ],
    ['classifier_entry', 'goals/synthetic.ts', 'const result = classifyCompletionAuthority(db, goalId, id);'],
    ['classifier_not_writer', 'goals/completionAuthorityPolicy.ts', 'await requestGoalApproval(db, input);'],
    [
      'classifier_not_writer',
      'goals/externalCompletionDecisionRows.ts',
      'transitionGoal(db, goalId, "completed");',
    ],
    [
      'classifier_not_writer',
      'goals/completionAuthorityPolicy.ts',
      "db.prepare('INSERT INTO goal_events (id) VALUES (?)');",
    ],
    ['classifier_not_writer', 'goals/completionAuthorityPolicy.ts', "db.prepare('DELETE FROM goal_events');"],
    [
      'classifier_not_writer',
      'goals/externalCompletionDecisionRows.ts',
      "db.prepare('REPLACE INTO goal_events (id) VALUES (?)');",
    ],
    [
      'classifier_not_writer',
      'goals/completionAuthorityPolicy.ts',
      "db.prepare('UPDATE goal_events SET id = ?');",
    ],
    ['classifier_not_writer', 'goals/completionAuthorityPolicy.ts', "db.prepare('select 1').run();"],
    ['classifier_not_writer', 'goals/externalCompletionDecisionRows.ts', 'db.exec("PRAGMA foreign_keys");'],
    [
      'classifier_isolation',
      'goals/completionAuthorityPolicy.ts',
      "import { computeExternalCompletionPreflight } from './externalCompletionPreflight.js';",
    ],
    [
      'classifier_isolation',
      'goals/externalCompletionDecisionRows.ts',
      "import { x } from './externalCompletionTerminal.js';",
    ],
    [
      'classifier_isolation',
      'goals/completionAuthorityPolicy.ts',
      "import { withGoalCompletionLock } from './goalCompletionLock.js';",
    ],
    ['classifier_isolation', 'goals/completionAuthorityPolicy.ts', "import { x } from './goalRoutes.js';"],
    [
      'classifier_isolation',
      'goals/externalCompletionDecisionRows.ts',
      "import { x } from './externalCompletionDecision.js';",
    ],
    [
      'classifier_isolation',
      'goals/completionAuthorityPolicy.ts',
      'const id = computeEmptyCorrectionChainIdentity({ attestationId, attestationRecordDigest });',
    ],
    [
      'classifier_isolation',
      'goals/externalCompletionDecisionRows.ts',
      'const snapshot = readPreflightSnapshotIdentity(db, goalId, attestationId);',
    ],
    [
      'allow_recorded_decision_callers',
      'goals/completionAuthorityPolicy.ts',
      'const options = { allowRecordedDecision: true };',
    ],
    [
      'allow_recorded_decision_callers',
      'goals/synthetic.ts',
      'computeExternalCompletionPreflight(db, goalId, input, { allowRecordedDecision: true });',
    ],
  ];

  it.each(seeded)('%s flags a seeded violation in %s', (ruleId, path, source) => {
    expect(breaksRule(ruleById(ruleId), path, source)).toBe(true);
  });

  const controls: [rule: string, path: string, source: string][] = [
    [
      'proof_write',
      'goals/externalCompletionProof.ts',
      'SELECT COUNT(*) FROM goal_external_completion_proofs WHERE goal_id = ?',
    ],
    ['proof_write', 'goals/synthetic.ts', 'db.prepare("INSERT INTO goal_events (id) VALUES (?)");'],
    [
      'proof_write',
      'goals/synthetic.ts',
      "db.prepare('SELECT COUNT(*) FROM main.goal_external_completion_proofs');",
    ],
    ['proof_write', 'goals/synthetic.ts', "db.prepare('INSERT INTO main.goal_events (id) VALUES (?)');"],
    [
      'decision_reader',
      'goals/externalCompletionDecision.ts',
      'export function readExternalCompletionDecision() {}',
    ],
    [
      'decision_record',
      'goals/externalCompletionDecision.ts',
      'export async function recordExternalCompletionDecision() {}',
    ],
    [
      'completion_identifier',
      'goals/evidence.ts',
      'if (approval.externalCompletionActionDigest !== undefined) return;',
    ],
    ['completion_identifier', 'goals/synthetic.ts', 'const label = "completion of the Goal";'],
    [
      'goal_status_write',
      'goals/stateMachine.ts',
      'UPDATE goals SET status = ?, status_reason_code = ? WHERE id = ?',
    ],
    ['goal_status_write', 'goals/synthetic.ts', 'UPDATE goal_runtime SET status = ? WHERE goal_id = ?'],
    [
      'goal_status_write',
      'goals/synthetic.ts',
      "db.prepare('UPDATE goals SET updated_at = ? WHERE status = ?');",
    ],
    [
      'goal_status_write',
      'goals/synthetic.ts',
      "db.prepare('UPDATE goals SET status_reason_code = ? WHERE id = ?');",
    ],
    [
      'goal_status_write',
      'goals/synthetic.ts',
      "db.prepare('UPDATE goals SET last_status = ? WHERE id = ?');",
    ],
    [
      'preflight_isolation',
      'goals/externalCompletionPreflight.ts',
      "import { buildExternalCompletionAction } from './externalCompletionProof.js';",
    ],
    ['preflight_isolation', 'goals/synthetic.ts', "import { x } from './externalCompletionDecision.js';"],
    [
      'proof_write',
      'goals/externalCompletionTerminal.ts',
      'INSERT INTO goal_external_completion_proofs (id) VALUES (?)',
    ],
    [
      'decision_reader',
      'goals/externalCompletionTerminal.ts',
      'const read = readExternalCompletionDecision(db, goalId, approvalId);',
    ],
    [
      'goal_status_write',
      'goals/externalCompletionTerminal.ts',
      "UPDATE goals SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'running'",
    ],
    [
      'completion_identifier',
      'goals/externalCompletionTerminal.ts',
      'const digest = row.externalCompletionActionDigest;',
    ],
    [
      'completion_service',
      'goals/externalCompletion.ts',
      'export async function completeGoalFromExternalDecision() {}',
    ],
    [
      'correction_decision_service',
      'goals/attestationCorrectionDecision.ts',
      'export function decideAttestationCorrectionAsUser() {}',
    ],
    [
      'correction_decision_service',
      'goals/goalRoutes.ts',
      'return decideAttestationCorrectionAsUser(db, input);',
    ],
    [
      'correction_request_service',
      'goals/attestationCorrectionRequest.ts',
      'export function requestAttestationCorrectionAsUser() {}',
    ],
    [
      'correction_request_service',
      'goals/goalRoutes.ts',
      'return requestAttestationCorrectionAsUser(db, input);',
    ],
    [
      'correction_request_service',
      'goals/synthetic.ts',
      'const label = "request attestation correction as user";',
    ],
    [
      'correction_raw_creator',
      'goals/attestationCorrection.ts',
      'export function requestAttestationCorrectionApproval() {}',
    ],
    [
      'correction_raw_creator',
      'goals/attestationCorrectionRequest.ts',
      'const { approval } = requestAttestationCorrectionApproval(db, input);',
    ],
    [
      'correction_raw_creator',
      'goals/synthetic.ts',
      'const label = "request attestation correction approval";',
    ],
    [
      'correction_decision_service',
      'goals/synthetic.ts',
      'const label = "decide attestation correction as user";',
    ],
    ['completion_service', 'goals/synthetic.ts', 'const label = "complete goal from external decision";'],
    [
      'completion_consume',
      'goals/externalCompletionTerminal.ts',
      'export function consumeExternalCompletionDecision() {}',
    ],
    [
      'completion_consume',
      'goals/externalCompletion.ts',
      'consumeExternalCompletionDecision(db, decision, proof, postGitIdentity, now);',
    ],
    [
      'decision_reader',
      'goals/externalCompletion.ts',
      'const rows = listExternalCompletionDecisions(db, goalId);',
    ],
    [
      'completion_reason',
      'shared/goals.ts',
      "export const EXTERNAL_COMPLETION_REASON = 'external_completion_user_confirmed' as const;",
    ],
    ['completion_reason', 'goals/events.ts', 'external_completion_recorded: {'],
    ['completion_reason', 'goals/synthetic.ts', 'const label = "external completion recorded";'],
    [
      'classifier_entry',
      'goals/completionAuthorityPolicy.ts',
      'export function classifyCompletionAuthority(db: Db, goalId: string) {}',
    ],
    ['classifier_entry', 'goals/synthetic.ts', 'const label = "completion authority";'],
    [
      'classifier_not_writer',
      'goals/completionAuthorityPolicy.ts',
      "db.prepare('SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ?').get(goalId);",
    ],
    ['classifier_not_writer', 'goals/synthetic.ts', "db.prepare('INSERT INTO goal_events (id) VALUES (?)');"],
    [
      'classifier_not_writer',
      'goals/externalCompletionDecisionRows.ts',
      'const label = "update the goal row";',
    ],
    [
      'classifier_isolation',
      'goals/externalCompletionDecisionRows.ts',
      "import { getGoalApproval } from './approvals.js';",
    ],
    [
      'classifier_isolation',
      'goals/completionAuthorityPolicy.ts',
      "import { x } from './externalCompletionDecisionRows.js';",
    ],
    [
      'classifier_isolation',
      'goals/externalCompletionPreflight.ts',
      "import { x } from './externalCompletionDecision.js';",
    ],
    ['classifier_isolation', 'goals/synthetic.ts', 'const v = allowRecordedDecision;'],
    [
      'allow_recorded_decision_callers',
      'goals/externalCompletionTerminal.ts',
      'computeExternalCompletionPreflight(db, goalId, input, { allowRecordedDecision: true });',
    ],
    ['allow_recorded_decision_callers', 'goals/synthetic.ts', 'const label = "recorded decision";'],
    [
      'classifier_entry',
      'goals/externalCompletionPreflight.ts',
      "import { classifyCompletionAuthority } from './completionAuthorityPolicy.js';",
    ],
    [
      'classifier_entry',
      'goals/externalCompletionTerminal.ts',
      "import { classifyCompletionAuthority } from './completionAuthorityPolicy.js';",
    ],
    [
      'classifier_entry',
      'goals/externalCompletionApi.ts',
      "import { classifyCompletionAuthority } from './completionAuthorityPolicy.js';",
    ],
  ];

  it.each(controls)('%s passes its negative control in %s', (ruleId, path, source) => {
    expect(breaksRule(ruleById(ruleId), path, source)).toBe(false);
  });
});
