import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Static consumer guard for the completion Booleans `unqualifiedSuccessAllowed` and `trustedForDownstream` (GH.6a, D3-2
 * option 1). The Booleans mean an uncontested recorded decision on a proof. They never mean content correctness, so every
 * production read of a Boolean must sit in a scope that also names `contentPreservation`, and no file outside the
 * allow-list may read one at all.
 *
 * Limits:
 * - The scan covers production files under src only (not *.test.ts, *.test.tsx or *.d.ts). It cannot see a consumer
 *   outside src, such as a script, a separate package or a doc example that runs. docs/GOAL_D32_CONSUMER_AUDIT.md lists
 *   the consumers the audit grep found. A new consumer outside src needs a manual review.
 * - Pairing is checked on the enclosing function, or on the whole file for a top-level read. It proves that the scope
 *   names `contentPreservation` (and, for the client classifier, the literal 'not_proven'). It does not prove the scope
 *   uses the field correctly; the behaviour tests in goalListStanding, mobileStanding and completionStandingCopy do that.
 * - The list label reads a brief field named `trusted`, not a Boolean name. It is covered by those behaviour tests, not
 *   by this name scan.
 *
 * The detector is `findViolations`. The production scan and the seeded tests all call it, so the seeded tests exercise
 * the code that guards the tree.
 */

const SRC = fileURLToPath(new URL('../../', import.meta.url));

const BOOLEAN_NAMES = new Set(['unqualifiedSuccessAllowed', 'trustedForDownstream']);
/** The bare names anywhere in the text, so a comment, a bracket key or a spacing trick cannot hide a mention. */
const BOOLEAN_MENTION = /\b(?:unqualifiedSuccessAllowed|trustedForDownstream)\b/;

/** Allow-list by path relative to src, with the reason each file may mention a Boolean. Stale entries fail the test. */
const ALLOWED_PATHS = new Map<string, string>([
  ['shared/goalApi.ts', 'the type declaration and its doc comments'],
  ['server/goals/completionStanding.ts', 'the producer and the accessor predicates'],
  [
    'server/goals/goalRoutes.ts',
    'the list brief copies trustedForDownstream beside contentPreservation (paired)',
  ],
  ['client/goals/completionStandingCopy.ts', 'the client classifier and the list label (paired)'],
  ['client/goals/qualificationKit.ts', 'test fixture, not a *.test file; imported only by test files'],
]);

/** Consumers whose Boolean reads must sit in a scope that names contentPreservation. */
const PAIRED_PATHS = new Map<string, { notProvenLiteral: boolean }>([
  // The route copies the value into the brief. The 'not_proven' value is asserted by the route's list test, not here.
  ['server/goals/goalRoutes.ts', { notProvenLiteral: false }],
  // The client decides from the value, so the scope must also name the literal 'not_proven'.
  ['client/goals/completionStandingCopy.ts', { notProvenLiteral: true }],
]);

export interface GuardViolation {
  path: string;
  line: number;
  reason: 'unlisted_consumer' | 'unpaired_read';
}

/** One Boolean read in a paired file, with what its enclosing scope names. */
export interface BooleanRead {
  line: number;
  withContentPreservation: boolean;
  withNotProvenLiteral: boolean;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** The nearest function that contains the node, or the whole file for a top-level read. */
function enclosingScope(node: ts.Node, source: ts.SourceFile): ts.Node {
  let current: ts.Node = node;
  while (current.parent) {
    if (ts.isFunctionLike(current.parent)) return current.parent;
    current = current.parent;
  }
  return source;
}

function scopeNames(scope: ts.Node): { contentPreservation: boolean; notProven: boolean } {
  const names = { contentPreservation: false, notProven: false };
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'contentPreservation') names.contentPreservation = true;
    if (ts.isStringLiteral(node) && node.text === 'not_proven') names.notProven = true;
    ts.forEachChild(node, walk);
  };
  walk(scope);
  return names;
}

/** Every read of a Boolean name in the text, identifier or string key, each with its enclosing scope's pairing. */
export function booleanReadsIn(text: string, path: string): BooleanRead[] {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const reads: BooleanRead[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && BOOLEAN_NAMES.has(node.text)) {
      const names = scopeNames(enclosingScope(node, source));
      reads.push({
        line: lineOf(source, node),
        withContentPreservation: names.contentPreservation,
        withNotProvenLiteral: names.notProven,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

/** The detector. `path` is relative to src and uses forward slashes. Returns no violation for a clean file. */
export function findViolations(path: string, text: string): GuardViolation[] {
  if (!ALLOWED_PATHS.has(path)) {
    const match = BOOLEAN_MENTION.exec(text);
    if (!match) return [];
    return [{ path, line: text.slice(0, match.index).split('\n').length, reason: 'unlisted_consumer' }];
  }
  const paired = PAIRED_PATHS.get(path);
  if (!paired) return [];
  return booleanReadsIn(text, path)
    .filter(
      (read) => !(read.withContentPreservation && (!paired.notProvenLiteral || read.withNotProvenLiteral)),
    )
    .map((read): GuardViolation => ({ path, line: read.line, reason: 'unpaired_read' }));
}

function productionFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...productionFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe('completion Boolean consumer guard: the Booleans are read only beside contentPreservation (D3-2 option 1)', () => {
  it('the production tree under src has no unlisted consumer and no unpaired Boolean read', () => {
    const files = productionFiles(SRC);
    // Non-vacuous: the scan covers the whole production tree, including the producer and the two paired consumers.
    expect(files.length).toBeGreaterThan(100);
    const paths = files.map((file) => relative(SRC, file).split('\\').join('/'));
    expect(paths).toContain('server/goals/completionStanding.ts');
    const violations = paths.flatMap((path) => findViolations(path, readFileSync(join(SRC, path), 'utf8')));
    expect(violations).toEqual([]);
  });

  it('every allow-listed file exists in the scan and still mentions a Boolean, so the list cannot go stale', () => {
    const paths = productionFiles(SRC).map((file) => relative(SRC, file).split('\\').join('/'));
    for (const path of ALLOWED_PATHS.keys()) {
      expect(paths, path).toContain(path);
      expect(BOOLEAN_MENTION.test(readFileSync(join(SRC, path), 'utf8')), path).toBe(true);
    }
  });

  it('every paired consumer has at least one Boolean read, so its pairing check is not vacuous', () => {
    for (const path of PAIRED_PATHS.keys()) {
      expect(booleanReadsIn(readFileSync(join(SRC, path), 'utf8'), path).length, path).toBeGreaterThan(0);
    }
  });

  it('the qualificationKit fixture is imported by no production file', () => {
    const importers = productionFiles(SRC).filter((file) =>
      readFileSync(file, 'utf8').includes('qualificationKit'),
    );
    expect(importers.map((file) => relative(SRC, file))).toEqual([]);
  });

  it('seeded violation: a new production file that reads a Boolean is caught, whatever the spacing or key form', () => {
    const seeded = [
      'const ok = claim.trustedForDownstream;',
      "const ok = claim['unqualifiedSuccessAllowed'];",
      'const ok = claim.trustedForDownstream\n  ;',
    ];
    for (const text of seeded) {
      expect(findViolations('server/goals/newConsumer.ts', text), text).toEqual([
        { path: 'server/goals/newConsumer.ts', line: 1, reason: 'unlisted_consumer' },
      ]);
    }
  });

  it('seeded violation: an allow-listed consumer that reads a Boolean with no contentPreservation in its scope is caught', () => {
    const copyWithoutPairing = [
      'export function classify(claim: GoalCompletionStandingClaim) {',
      "  return claim.unqualifiedSuccessAllowed === true && claim.qualifier === 'none' ? TRUSTED : UNRECOGNISED;",
      '}',
    ].join('\n');
    expect(findViolations('client/goals/completionStandingCopy.ts', copyWithoutPairing)).toEqual([
      { path: 'client/goals/completionStandingCopy.ts', line: 2, reason: 'unpaired_read' },
    ]);
    const routeWithoutPairing = 'const brief = { trusted: standing.claim.trustedForDownstream };';
    expect(findViolations('server/goals/goalRoutes.ts', routeWithoutPairing)).toEqual([
      { path: 'server/goals/goalRoutes.ts', line: 1, reason: 'unpaired_read' },
    ]);
  });

  it('seeded violation: the client classifier names contentPreservation but not the literal not_proven, and is caught', () => {
    const noLiteral = [
      'function classify(claim: GoalCompletionStandingClaim) {',
      '  return claim.trustedForDownstream && claim.contentPreservation ? TRUSTED : UNRECOGNISED;',
      '}',
    ].join('\n');
    expect(findViolations('client/goals/completionStandingCopy.ts', noLiteral)).toEqual([
      { path: 'client/goals/completionStandingCopy.ts', line: 2, reason: 'unpaired_read' },
    ]);
  });

  it('seeded violation: a Boolean read in one function is not paired by a contentPreservation in another', () => {
    const splitScopes = [
      'function a(claim) {',
      '  return claim.contentPreservation;',
      '}',
      'function b(claim) {',
      '  return claim.trustedForDownstream;',
      '}',
    ].join('\n');
    expect(findViolations('server/goals/goalRoutes.ts', splitScopes)).toEqual([
      { path: 'server/goals/goalRoutes.ts', line: 5, reason: 'unpaired_read' },
    ]);
  });

  it('negative controls: paired reads pass, the route needs no literal, a same-named file elsewhere is not exempt, and near-miss names pass', () => {
    const copyPaired = [
      'function classify(claim: GoalCompletionStandingClaim) {',
      "  return claim.unqualifiedSuccessAllowed === true && claim.contentPreservation === 'not_proven' ? TRUSTED : UNRECOGNISED;",
      '}',
    ].join('\n');
    expect(findViolations('client/goals/completionStandingCopy.ts', copyPaired)).toEqual([]);
    expect(
      findViolations(
        'server/goals/goalRoutes.ts',
        'const b = { contentPreservation: x.contentPreservation, t: y.trustedForDownstream };',
      ),
    ).toEqual([]);
    expect(
      findViolations('server/goals/other/completionStandingCopy.ts', 'const x = claim.trustedForDownstream;'),
    ).toEqual([
      { path: 'server/goals/other/completionStandingCopy.ts', line: 1, reason: 'unlisted_consumer' },
    ]);
    expect(
      findViolations('server/goals/newConsumer.ts', 'const m = readGoalCompletionStanding(db, goalId);'),
    ).toEqual([]);
    expect(findViolations('server/goals/newConsumer.ts', 'const x = claim.trusted;')).toEqual([]);
    expect(
      findViolations('server/goals/newConsumer.ts', 'const x = claim.trustedForDownstreamLegacy;'),
    ).toEqual([]);
  });
});
