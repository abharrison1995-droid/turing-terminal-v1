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
  'goals/evidence.ts',
  'goals/externalCompletionDecision.ts',
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
    files: ['goals/externalCompletionDecision.ts', 'goals/externalCompletionTerminal.ts'],
    reason:
      'Only the decision module and the proof-bound terminal authority name the decision readers. No other production consumer reads a decision.',
  },
  {
    id: 'decision_record',
    pattern: /\brecordExternalCompletionDecision\b/,
    mode: 'only_in',
    files: ['goals/externalCompletionDecision.ts'],
    reason: 'Only the decision module names the decision recorder. It has no production caller yet.',
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

/** Paths of the production files that match a rule's pattern, sorted. */
function matchingPaths(rule: AuthorityRule, sources: { path: string; source: string }[]): string[] {
  return sources
    .filter(({ source }) => rule.pattern.test(source))
    .map(({ path }) => path)
    .sort();
}

describe('authority static guard: production sources', () => {
  const sources = productionSources();

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

  it('completion identifier allow-list is exactly the reviewed file set', () => {
    expect(ruleById('completion_identifier').files).toEqual([...D3D_COMPLETION_IDENTIFIER_FILES].sort());
    expect(D3D_COMPLETION_IDENTIFIER_FILES).toHaveLength(9);
  });

  for (const rule of RULES) {
    it(`${rule.id}: ${rule.reason}`, () => {
      const offenders = sources
        .filter(({ path, source }) => breaksRule(rule, path, source))
        .map(({ path }) => path);
      expect(offenders).toEqual([]);
      if (rule.mode === 'only_in') {
        // Drift check: every allowed file still matches, so a stale entry fails rather than hiding a removal.
        expect(matchingPaths(rule, sources).filter((path) => !rule.files.includes(path))).toEqual([]);
        for (const path of rule.files) expect(sources.map((entry) => entry.path)).toContain(path);
      }
    });
  }
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
  ];

  it.each(controls)('%s passes its negative control in %s', (ruleId, path, source) => {
    expect(breaksRule(ruleById(ruleId), path, source)).toBe(false);
  });
});
