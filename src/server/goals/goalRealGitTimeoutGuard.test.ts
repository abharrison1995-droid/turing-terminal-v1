import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every test that builds a real Git repository or fixture must pass REAL_GIT_TEST_TIMEOUT_MS explicitly as its
 * timeout argument. A test is "real-Git" when its callback calls one of the helpers below, directly or through a
 * function declared in the same test file that calls one of them. The helpers are the exports of the test kits that
 * run Git, derived from the kit sources (a helper that calls `git` or `goalRepoFixture`, transitively). The raw
 * `git(...)` call and the fixture method `.git(...)` count as Git calls in any test file.
 */

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TIMEOUT_CONSTANT = 'REAL_GIT_TEST_TIMEOUT_MS';
/** Vitest hooks run under the 10 s default timeout unless the second argument is passed, so they are guarded too. */
const HOOK_NAMES = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);

/**
 * Each real-Git kit helper and the kit module that exports it. Checked against the kit sources below.
 * Kit exports that run no Git, directly or through a helper here, are deliberately absent: `approveExternalObservation`
 * and `appendCorrectionForTest` are synchronous and touch only the database, and `probeHarness` makes no Git call
 * itself (its methods start production runs, which the name-based scan cannot follow).
 */
const REAL_GIT_HELPERS: Record<string, string> = {
  acceptedFixture: 'goalV2TestKit',
  attestObservation: 'goalLifecycleKit',
  buildFixtureRepository: 'routeProbeFixture',
  call: 'goalLifecycleKit',
  decideAndComplete: 'goalLifecycleKit',
  driveToVerifiedHandoff: 'goalLifecycleKit',
  ensureFixture: 'routeProbeFixture',
  expectCompleted: 'goalLifecycleKit',
  goalRepoFixture: 'repoKit',
  harness: 'supervisorKit',
  integratedExternalFixture: 'goalV2TestKit',
  openAndDriveToVerifiedHandoff: 'goalLifecycleKit',
  openGoal: 'goalLifecycleKit',
  passDeterministic: 'repoKit',
  realRunHarness: 'turingRunKit',
  reattestAtCurrentTip: 'goalV2TestKit',
  repositoryState: 'goalV2TestKit',
  reviewedDigest: 'goalV2TestKit',
  snapshotOf: 'goalLifecycleKit',
  untilGoal: 'goalLifecycleKit',
  v2AttestedFixture: 'goalV2TestKit',
  v2RunningAttestedFixture: 'goalV2TestKit',
  verifyFixture: 'routeProbeFixture',
};
const RAW_GIT_HELPER = 'git';
/** The names that declare a test: `it` and `test`. */
const TEST_ROOTS = new Set(['it', 'test']);
/**
 * Vitest modifiers that keep a declaration a test: `it.only`, `test.skip`, `it.concurrent`, `it.only.concurrent`. The
 * `each` form is matched separately, because it takes the table before the test arguments.
 */
const TEST_MODIFIERS = new Set(['only', 'skip', 'concurrent', 'sequential']);

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** Names exported by a kit module, function or const. */
function kitExports(moduleName: string): Set<string> {
  const file = join(SRC_ROOT, 'server', 'goals', `${moduleName}.ts`);
  const names = new Set<string>();
  for (const statement of sourceFile(file).statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement))
      names.add(statement.name.text);
    if (ts.isVariableStatement(statement) && isExported(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
  }
  return names;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Names of functions declared in a file, with their bodies: declarations and arrow or function constants. */
function localFunctions(file: ts.SourceFile): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        functions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return functions;
}

/** Local names bound to real-Git helpers by an import from a kit module, plus the raw helper name. */
function gitCallableNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text.replace(/\.js$/, '').split('/').pop()!;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (REAL_GIT_HELPERS[imported] === module) names.add(element.name.text);
    }
  }
  return names;
}

/**
 * A raw Git call: the fixture method `.git(...)`, a local `git(...)` helper call, or a process call whose first
 * argument is the program `'git'` or a command string starting with `'git '`. The command may be a plain literal or a
 * template with substitutions, such as ``git -C ${dir} init``: only its leading text before the first `${` is read.
 */
function isRawGitCall(call: ts.CallExpression): boolean {
  if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === RAW_GIT_HELPER)
    return true;
  if (ts.isIdentifier(call.expression) && call.expression.text === RAW_GIT_HELPER) return true;
  const first = call.arguments[0];
  if (first === undefined) return false;
  const leading = ts.isTemplateExpression(first)
    ? first.head.text
    : ts.isStringLiteralLike(first)
      ? first.text
      : null;
  return leading !== null && (leading === RAW_GIT_HELPER || leading.startsWith(`${RAW_GIT_HELPER} `));
}

/** Functions of this file that call a Git helper, directly or through another such function. */
function gitFunctionNames(file: ts.SourceFile): Set<string> {
  const direct = gitCallableNames(file);
  const functions = localFunctions(file);
  const git = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, body] of functions) {
      if (git.has(name)) continue;
      let calls = false;
      const visit = (node: ts.Node) => {
        if (calls) return;
        if (ts.isCallExpression(node)) {
          const callee = calleeName(node);
          if (isRawGitCall(node) || (callee !== null && (direct.has(callee) || git.has(callee))))
            calls = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(body);
      if (calls) {
        git.add(name);
        changed = true;
      }
    }
  }
  return new Set([...direct, ...git]);
}

/** `it`, `test`, or one of them with modifiers: `it.only`, `test.skip`, `it.only.concurrent`. */
function isTestCallee(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return TEST_ROOTS.has(expression.text);
  return (
    ts.isPropertyAccessExpression(expression) &&
    TEST_MODIFIERS.has(expression.name.text) &&
    isTestCallee(expression.expression)
  );
}

/**
 * The `each` table of a parametrised test, as a call or a tagged template: `it.each(table)`, ``it.each`table` ``,
 * `test.only.each(table)`. The test arguments are then passed to the table's result.
 */
function isEachTable(expression: ts.Expression): boolean {
  const each = ts.isCallExpression(expression)
    ? expression.expression
    : ts.isTaggedTemplateExpression(expression)
      ? expression.tag
      : null;
  return (
    each !== null &&
    ts.isPropertyAccessExpression(each) &&
    each.name.text === 'each' &&
    isTestCallee(each.expression)
  );
}

/**
 * The test declaration at this node, or null. Covers `it(...)`, `test(...)`, the modifier forms (`it.only`, `it.skip`,
 * `it.concurrent`, `test.only`, `test.skip`), and `each` as a call or a tagged template. A `todo` has no callback and
 * is not a test body, so it is not covered.
 */
function testCall(node: ts.Node): ts.CallExpression | null {
  if (!ts.isCallExpression(node)) return null;
  return isTestCallee(node.expression) || isEachTable(node.expression) ? node : null;
}

export interface TimeoutViolation {
  path: string;
  line: number;
  title: string;
}

/** The `beforeAll`, `beforeEach`, `afterAll` or `afterEach` hook call at this node, or null. */
function hookCall(node: ts.Node): ts.CallExpression | null {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return null;
  return HOOK_NAMES.has(node.expression.text) ? node : null;
}

/**
 * Whether a callback body, or a callback that is a bare identifier naming a Git-calling function of this file, calls a
 * real-Git helper.
 */
function callsRealGit(callback: ts.Node, gitNames: Set<string>): boolean {
  if (ts.isIdentifier(callback)) return gitNames.has(callback.text);
  let callsGit = false;
  const scan = (child: ts.Node) => {
    if (callsGit) return;
    if (ts.isCallExpression(child)) {
      const callee = calleeName(child);
      if (isRawGitCall(child) || (callee !== null && gitNames.has(callee))) callsGit = true;
    }
    ts.forEachChild(child, scan);
  };
  scan(callback);
  return callsGit;
}

/** Real-Git test blocks and hooks in one source that do not pass the shared timeout constant explicitly. */
export function timeoutViolations(path: string, file: ts.SourceFile): TimeoutViolation[] {
  const gitNames = gitFunctionNames(file);
  const violations: TimeoutViolation[] = [];
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const visit = (node: ts.Node) => {
    const call = testCall(node);
    if (call && call.arguments.length >= 2 && callsRealGit(call.arguments[1]!, gitNames)) {
      const third = call.arguments[2];
      const explicit = third !== undefined && ts.isIdentifier(third) && third.text === TIMEOUT_CONSTANT;
      if (!explicit || call.arguments.length !== 3) {
        const title =
          call.arguments[0] && ts.isStringLiteralLike(call.arguments[0])
            ? call.arguments[0].text
            : '(dynamic title)';
        violations.push({ path, line: lineOf(call), title });
      }
    }
    // A hook takes its callback first and its timeout second: `beforeAll(fn, REAL_GIT_TEST_TIMEOUT_MS)`.
    const hook = hookCall(node);
    if (hook && hook.arguments.length >= 1 && callsRealGit(hook.arguments[0]!, gitNames)) {
      const second = hook.arguments[1];
      const explicit = second !== undefined && ts.isIdentifier(second) && second.text === TIMEOUT_CONSTANT;
      if (!explicit || hook.arguments.length !== 2)
        violations.push({
          path,
          line: lineOf(hook),
          title: `${(hook.expression as ts.Identifier).text} hook`,
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

function testSources(dir = SRC_ROOT): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return testSources(full);
    return name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('real-Git timeout guard: helper list', () => {
  it('lists only helpers that its kit module still exports', () => {
    for (const [helper, moduleName] of Object.entries(REAL_GIT_HELPERS))
      expect(kitExports(moduleName), `${helper} in ${moduleName}`).toContain(helper);
  });
});

describe('real-Git timeout guard: every real-Git test has the explicit shared timeout', () => {
  it('reports no real-Git test block without REAL_GIT_TEST_TIMEOUT_MS as its third argument', () => {
    const violations = testSources().flatMap((path) =>
      timeoutViolations(relative(SRC_ROOT, path), sourceFile(path)),
    );
    const report = violations.map(({ path, line, title }) => `${path}:${line} ${title}`);
    expect(report, report.join('\n') || 'no violations').toEqual([]);
  });

  it('catches a real-Git test that omits the timeout, through a direct call and through a local wrapper', () => {
    const source = [
      "import { goalRepoFixture } from './repoKit.js';",
      'function make() { return goalRepoFixture({}); }',
      "it('direct without timeout', async () => { goalRepoFixture({}); });",
      "it('wrapped without timeout', async () => { make(); });",
    ].join('\n');
    const violations = timeoutViolations(
      'goals/synthetic.test.ts',
      ts.createSourceFile('s.ts', source, ts.ScriptTarget.Latest, true),
    );
    expect(violations.map(({ title }) => title)).toEqual([
      'direct without timeout',
      'wrapped without timeout',
    ]);
  });

  it('catches a test that calls a raw Git process directly or through a local git helper', () => {
    const source = [
      "import { execFileSync } from 'node:child_process';",
      "const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd });",
      "it('local git helper without timeout', () => { git('/tmp/x', 'status'); });",
      "it('direct git process without timeout', () => { execFileSync('git', ['status']); });",
      "it('pure without timeout', () => { expect(1).toBe(1); });",
    ].join('\n');
    const violations = timeoutViolations(
      'goals/synthetic.test.ts',
      ts.createSourceFile('s.ts', source, ts.ScriptTarget.Latest, true),
    );
    expect(violations.map(({ title }) => title)).toEqual([
      'local git helper without timeout',
      'direct git process without timeout',
    ]);
  });

  it('catches a real-Git it.each block with a literal or another constant instead of the shared one', () => {
    const source = [
      "import { v2RunningAttestedFixture } from './goalV2TestKit.js';",
      'const HEAVY = 60_000;',
      "it.each(['sha1'])('literal %s', async (format) => { await v2RunningAttestedFixture(format); }, 30_000);",
      "it.each(['sha256'])(\n  'constant %s',\n  async (format) => { await v2RunningAttestedFixture(format); },\n  HEAVY,\n);",
    ].join('\n');
    const violations = timeoutViolations(
      'goals/synthetic.test.ts',
      ts.createSourceFile('s.ts', source, ts.ScriptTarget.Latest, true),
    );
    expect(violations.map(({ title }) => title)).toEqual(['literal %s', 'constant %s']);
  });

  it('does not flag a test that passes the shared timeout, a pure test, or a same-named helper that is not a kit helper', () => {
    const source = [
      "import { goalRepoFixture } from './repoKit.js';",
      "import { REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';",
      "import { harness } from './localHarness.js';",
      "it('with the shared timeout', async () => { goalRepoFixture({}); }, REAL_GIT_TEST_TIMEOUT_MS);",
      "it('pure', () => { expect(1).toBe(1); });",
      "it('local harness', () => { harness(); });",
    ].join('\n');
    const violations = timeoutViolations(
      'goals/synthetic.test.ts',
      ts.createSourceFile('s.ts', source, ts.ScriptTarget.Latest, true),
    );
    expect(violations).toEqual([]);
  });

  it('catches a real-Git hook without the explicit timeout, through a fixture, a raw git call, a local wrapper and an identifier callback', () => {
    const source = [
      "import { execFileSync } from 'node:child_process';",
      "import { goalRepoFixture, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';",
      "import { v2RunningAttestedFixture } from './goalV2TestKit.js';",
      'const HEAVY = 60_000;',
      "const raw = () => execFileSync('git', ['status']);",
      'function make() { return goalRepoFixture({}); }',
      'function setupRepo() { return goalRepoFixture({}); }',
      'beforeAll(async () => { await goalRepoFixture({}); });',
      'beforeEach(() => { make(); }, 30_000);',
      'afterAll(() => { raw(); });',
      "afterEach(() => { v2RunningAttestedFixture('sha1'); }, HEAVY);",
      'beforeAll(setupRepo);',
    ].join('\n');
    const violations = timeoutViolations(
      'goals/synthetic.test.ts',
      ts.createSourceFile('s.ts', source, ts.ScriptTarget.Latest, true),
    );
    expect(violations.map(({ title }) => title)).toEqual([
      'beforeAll hook',
      'beforeEach hook',
      'afterAll hook',
      'afterEach hook',
      'beforeAll hook',
    ]);
  });

  it('does not flag a real-Git hook that passes the shared timeout, and does not flag a pure hook', () => {
    const source = [
      "import { goalRepoFixture, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';",
      "import { v2RunningAttestedFixture } from './goalV2TestKit.js';",
      'function pureSetup() { return 1; }',
      'beforeAll(async () => { await goalRepoFixture({}); }, REAL_GIT_TEST_TIMEOUT_MS);',
      "afterAll(async () => { await v2RunningAttestedFixture('sha1'); }, REAL_GIT_TEST_TIMEOUT_MS);",
      'beforeEach(() => { expect(1).toBe(1); });',
      'afterEach(() => { pureSetup(); });',
    ].join('\n');
    const violations = timeoutViolations(
      'goals/synthetic.test.ts',
      ts.createSourceFile('s.ts', source, ts.ScriptTarget.Latest, true),
    );
    expect(violations).toEqual([]);
  });
});

describe('real-Git timeout guard: seeded violations and negative controls for each coverage hole', () => {
  const titlesOf = (source: string) =>
    timeoutViolations(
      'goals/synthetic.test.ts',
      ts.createSourceFile('s.ts', source, ts.ScriptTarget.Latest, true),
    ).map(({ title }) => title);

  it('flags a test that calls a Git-running kit helper missing from the list (reattestAtCurrentTip, reviewedDigest)', () => {
    const source = [
      "import { reattestAtCurrentTip, reviewedDigest } from './goalV2TestKit.js';",
      "it('reattest without timeout', async () => { await reattestAtCurrentTip(attested); });",
      "it('digest without timeout', async () => { await reviewedDigest(attested); });",
    ].join('\n');
    expect(titlesOf(source)).toEqual(['reattest without timeout', 'digest without timeout']);
  });

  it('does not flag a test that calls a kit helper which runs no Git, with or without the shared timeout', () => {
    const source = [
      "import { approveExternalObservation, appendCorrectionForTest } from './goalV2TestKit.js';",
      "it('approve without timeout', () => { approveExternalObservation(fx, observation); });",
      "it('correction without timeout', () => { appendCorrectionForTest(fx, id, 'dispute'); });",
      "it('approve with timeout', () => { approveExternalObservation(fx, observation); }, REAL_GIT_TEST_TIMEOUT_MS);",
    ].join('\n');
    expect(titlesOf(source)).toEqual([]);
  });

  it('flags every test-declaration form that lacks the shared timeout', () => {
    const source = [
      "import { goalRepoFixture } from './repoKit.js';",
      "test('test form', async () => { await goalRepoFixture({}); });",
      "it.only('only form', async () => { await goalRepoFixture({}); });",
      "it.skip('skip form', async () => { await goalRepoFixture({}); });",
      "it.concurrent('concurrent form', async () => { await goalRepoFixture({}); });",
      "test.only('test only form', async () => { await goalRepoFixture({}); });",
      "test.skip('test skip form', async () => { await goalRepoFixture({}); });",
      "it.only.concurrent('chained form', async () => { await goalRepoFixture({}); });",
      "it.each([1])('each form %s', async () => { await goalRepoFixture({}); });",
      "it.only.each([1])('only each form %s', async () => { await goalRepoFixture({}); });",
      "it.each`\n  a\n  ${1}\n`('tagged each form %s', async () => { await goalRepoFixture({}); });",
      "test.each`\n  a\n  ${1}\n`('tagged test form %s', async () => { await goalRepoFixture({}); });",
    ].join('\n');
    expect(titlesOf(source)).toEqual([
      'test form',
      'only form',
      'skip form',
      'concurrent form',
      'test only form',
      'test skip form',
      'chained form',
      'each form %s',
      'only each form %s',
      'tagged each form %s',
      'tagged test form %s',
    ]);
  });

  it('does not flag the same test-declaration forms with the shared timeout, an it.todo, or a non-test describe', () => {
    const source = [
      "import { goalRepoFixture, REAL_GIT_TEST_TIMEOUT_MS } from './repoKit.js';",
      "test('test form', async () => { await goalRepoFixture({}); }, REAL_GIT_TEST_TIMEOUT_MS);",
      "it.only('only form', async () => { await goalRepoFixture({}); }, REAL_GIT_TEST_TIMEOUT_MS);",
      "it.skip('skip form', async () => { await goalRepoFixture({}); }, REAL_GIT_TEST_TIMEOUT_MS);",
      "it.concurrent('concurrent form', async () => { await goalRepoFixture({}); }, REAL_GIT_TEST_TIMEOUT_MS);",
      "test.only('test only form', async () => { await goalRepoFixture({}); }, REAL_GIT_TEST_TIMEOUT_MS);",
      "test.skip('test skip form', async () => { await goalRepoFixture({}); }, REAL_GIT_TEST_TIMEOUT_MS);",
      "it.each([1])('each form %s', async () => { await goalRepoFixture({}); }, REAL_GIT_TEST_TIMEOUT_MS);",
      "it.each`\n  a\n  ${1}\n`('tagged %s', async () => { await goalRepoFixture({}); }, REAL_GIT_TEST_TIMEOUT_MS);",
      "it.todo('planned form');",
      "describe.only('a group', () => { goalRepoFixture({}); });",
    ].join('\n');
    expect(titlesOf(source)).toEqual([]);
  });

  it('flags a raw Git command written as a template with substitutions, with no helper involved', () => {
    const source = [
      "import { execSync } from 'node:child_process';",
      "it('template git command', () => { execSync(`git -C ${dir} init`); });",
      "it('template git through a runner', () => { runCommand(`git -C ${dir} status`); });",
    ].join('\n');
    expect(titlesOf(source)).toEqual(['template git command', 'template git through a runner']);
  });

  it('does not flag a template command that does not begin with git, or a template with the shared timeout', () => {
    const source = [
      "it('echo template', () => { runCommand(`echo ${dir}`); });",
      "it('git word later', () => { runCommand(`-C ${dir} git status`); });",
      "it('pure', () => { expect(`${1}`).toBe('1'); });",
      "it('template git with timeout', () => { execSync(`git -C ${dir} init`); }, REAL_GIT_TEST_TIMEOUT_MS);",
    ].join('\n');
    expect(titlesOf(source)).toEqual([]);
  });
});
