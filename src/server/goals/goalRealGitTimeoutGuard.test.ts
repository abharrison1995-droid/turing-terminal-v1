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

/** Each real-Git kit helper and the kit module that exports it. Checked against the kit sources below. */
const REAL_GIT_HELPERS: Record<string, string> = {
  acceptedFixture: 'goalV2TestKit',
  buildFixtureRepository: 'routeProbeFixture',
  ensureFixture: 'routeProbeFixture',
  goalRepoFixture: 'repoKit',
  harness: 'supervisorKit',
  integratedExternalFixture: 'goalV2TestKit',
  passDeterministic: 'repoKit',
  realRunHarness: 'turingRunKit',
  repositoryState: 'goalV2TestKit',
  v2AttestedFixture: 'goalV2TestKit',
  v2RunningAttestedFixture: 'goalV2TestKit',
  verifyFixture: 'routeProbeFixture',
};
const RAW_GIT_HELPER = 'git';

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
 * argument is the literal program `'git'` or a command string starting with `'git '`.
 */
function isRawGitCall(call: ts.CallExpression): boolean {
  if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === RAW_GIT_HELPER)
    return true;
  if (ts.isIdentifier(call.expression) && call.expression.text === RAW_GIT_HELPER) return true;
  const first = call.arguments[0];
  return (
    first !== undefined &&
    ts.isStringLiteralLike(first) &&
    (first.text === RAW_GIT_HELPER || first.text.startsWith(`${RAW_GIT_HELPER} `))
  );
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

/** The `it(...)` or `it.each(...)(...)` call expression at this node, or null. */
function itCall(node: ts.Node): ts.CallExpression | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isIdentifier(callee) && callee.text === 'it') return node;
  if (
    ts.isCallExpression(callee) &&
    ts.isPropertyAccessExpression(callee.expression) &&
    ts.isIdentifier(callee.expression.expression) &&
    callee.expression.expression.text === 'it' &&
    callee.expression.name.text === 'each'
  )
    return node;
  return null;
}

export interface TimeoutViolation {
  path: string;
  line: number;
  title: string;
}

/** Real-Git test blocks in one source that do not pass the shared timeout constant as their explicit third argument. */
export function timeoutViolations(path: string, file: ts.SourceFile): TimeoutViolation[] {
  const gitNames = gitFunctionNames(file);
  const violations: TimeoutViolation[] = [];
  const visit = (node: ts.Node) => {
    const call = itCall(node);
    if (call && call.arguments.length >= 2) {
      const body = call.arguments[1]!;
      let callsGit = false;
      const scan = (child: ts.Node) => {
        if (callsGit) return;
        if (ts.isCallExpression(child)) {
          const callee = calleeName(child);
          if (isRawGitCall(child) || (callee !== null && gitNames.has(callee))) callsGit = true;
        }
        ts.forEachChild(child, scan);
      };
      scan(body);
      if (callsGit) {
        const third = call.arguments[2];
        const explicit = third !== undefined && ts.isIdentifier(third) && third.text === TIMEOUT_CONSTANT;
        if (!explicit || call.arguments.length !== 3) {
          const title =
            call.arguments[0] && ts.isStringLiteralLike(call.arguments[0])
              ? call.arguments[0].text
              : '(dynamic title)';
          const { line } = file.getLineAndCharacterOfPosition(call.getStart(file));
          violations.push({ path, line: line + 1, title });
        }
      }
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
});
