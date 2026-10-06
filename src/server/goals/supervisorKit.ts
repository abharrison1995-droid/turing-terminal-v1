import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import type { GoalDefinition } from '../../shared/goals.js';
import type { IntegrationHooks } from '../goalGit.js';
import { ActiveTimeTracker } from './activeTime.js';
import { FakeGoalExecutor, type FakeRunRequest } from './fakeExecutor.js';
import { goalRepoFixture, milestone, simpleDefinition, type GoalRepoFixture } from './repoKit.js';
import { GoalSupervisor, type StartRunResult, type TickAction } from './supervisor.js';

/** Test harness: a real temporary Git repository, a Goal with an approved definition, a fake executor and fake time. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

export const GOOD_TASK = {
  milestoneKey: 'm1',
  title: 'Add a',
  instructions: 'Create src/a.ts exporting a.',
  targetCriteria: ['build'],
  expectedPaths: ['src/a.ts'],
  rationale: 'The build criterion needs the module.',
};

/** One scripted provider answer for a proposal run. */
export type ProposalScript =
  { ok: true; proposal: unknown } | { ok: false; code: string } | { raw: string } | { noOutput: true };

export interface Harness {
  fx: GoalRepoFixture;
  supervisor: GoalSupervisor;
  executor: FakeGoalExecutor;
  tracker: ActiveTimeTracker;
  clock: { ms: number };
  startRun: ReturnType<typeof vi.fn<(runId: string) => StartRunResult>>;
  resumeRun: ReturnType<typeof vi.fn<(runId: string) => void>>;
  /** The stand-in for the provider: scripted answers, consumed only when a proposal run is answered. */
  model: { script: ProposalScript[]; calls: number };
  /** Completes (or fails) a started proposal run from the next script entry, persisting its output as a stage. */
  answerProposal(runId: string): void;
  /** Creates a supervisor + executor pair on the same database, as after a process restart. */
  /** Mutable test hooks forwarded to `advanceGoalRef` by every supervisor of this harness. */
  integrationHooks: IntegrationHooks;
  restart(): { supervisor: GoalSupervisor; executor: FakeGoalExecutor };
  /** Files the next queued run commits in its worktree. */
  files: { current: Record<string, string | null> };
  tick(): Promise<TickAction>;
  /** Ticks until the predicate on the returned action holds (at most `max` ticks); returns all actions. */
  until(stop: TickAction, max?: number): Promise<TickAction[]>;
  status(): { status: string; reason: string | null };
  cycle(): { id: string; status: string; kind: string; outcome: Record<string, unknown> | null } | undefined;
  /** The execution/remediation runs (proposal runs are listed by `proposalRuns`). */
  runs(): Array<{ id: string; status: string; goal_cycle_id: string | null }>;
  /** Number of `startRun` calls made for execution/remediation runs (proposal runs are counted separately). */
  workStarts(): number;
  proposalStarts(): number;
  proposalRuns(): Array<{ id: string; status: string; goal_cycle_id: string | null }>;
  setRunStatus(runId: string, status: string): void;
  start(): Promise<void>;
}

export function harness(
  options: {
    definition?: GoalDefinition;
    tune?: (definition: GoalDefinition) => void;
    /** When true (default) a started proposal run is answered immediately; tests that drive crash points turn it off. */
    autoAnswer?: boolean;
    /** Give proposal runs a real worktree and run branch (retention tests). */
    proposalWorktrees?: boolean;
  } = {},
): Harness {
  const definition =
    options.definition ??
    simpleDefinition({ milestones: [milestone('m1', ['build']), milestone('m2', ['tests'])] });
  delete definition.review.periodic;
  delete definition.review.onRepeatedFailure;
  // Automatic review triggers are off by default so lifecycle tests stay about their own subject; trigger tests opt in
  // through `tune`.
  delete definition.review.onScopeChange;
  definition.review.onMilestoneComplete = false;
  if (!definition.contract.completionPolicy.requireFinalReview) definition.review.final = false;
  options.tune?.(definition);
  const fx = goalRepoFixture({ definition });
  const { db } = fx;
  const clock = { ms: 5_000_000_000 };
  const tracker = new ActiveTimeTracker(db, { nowMs: () => clock.ms }, 15_000);
  const files = { current: { 'src/a.ts': 'export const a = 1;\n' } as Record<string, string | null> };

  const machineId = () =>
    (db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string })
      .value;

  const makeProposalRun = (request: FakeRunRequest, runId: string): string => {
    // With `proposalWorktrees` the run owns a real (clean) worktree on its run branch, like an isolated engine run.
    let branch: string | null = null;
    let worktree: string | null = null;
    if (options.proposalWorktrees) {
      branch = `turing/${runId.slice(0, 8)}`;
      worktree = join(dirname(fx.repo), `wt-${runId.slice(0, 8)}`);
      git(fx.repo, 'worktree', 'add', '-q', '-b', branch, worktree, request.baseCommit);
    }
    db.prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status,
         created_at, branch, worktree_path, goal_cycle_id, goal_run_purpose, goal_base_commit)
       VALUES (?, ?, ?, (SELECT id FROM workflows LIMIT 1), '{}', 'propose', 'economy', 'normal', 'queued', ?, ?, ?, ?, 'proposal', ?)`,
    ).run(
      runId,
      machineId(),
      fx.projectId,
      new Date().toISOString(),
      branch,
      worktree,
      request.cycleId,
      request.baseCommit,
    );
    return runId;
  };

  const model = { script: [] as ProposalScript[], calls: 0 };
  const answerProposal = (runId: string): void => {
    model.calls += 1;
    const answer = model.script.shift() ?? { ok: false as const, code: 'no_scripted_proposal' };
    if ('ok' in answer && !answer.ok) {
      db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId);
      return;
    }
    if (!('noOutput' in answer)) {
      const text = 'raw' in answer ? answer.raw : JSON.stringify(answer.proposal);
      db.prepare(
        `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, output_json)
         VALUES (?, ?, 'proposal', 'agent', 'Proposal', 1, 'passed', ?)`,
      ).run(randomUUID(), runId, JSON.stringify({ text }));
    }
    db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(runId);
  };

  const makeRun = (request: FakeRunRequest): string => {
    const runId = randomUUID();
    if (request.purpose === 'proposal') return makeProposalRun(request, runId);
    const branch = `turing/${runId.slice(0, 8)}`;
    const worktree = join(dirname(fx.repo), `wt-${runId.slice(0, 8)}`);
    git(fx.repo, 'worktree', 'add', '-q', '-b', branch, worktree, request.baseCommit);
    // A review run reads the Goal head exactly as it is; only work runs commit files.
    for (const [path, content] of request.purpose === 'review' ? [] : Object.entries(files.current)) {
      const full = join(worktree, path);
      if (content === null) rmSync(full, { force: true });
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    git(worktree, 'add', '-A');
    if (git(worktree, 'status', '--porcelain'))
      git(worktree, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'work');
    const machine = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    db.prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status,
         created_at, branch, worktree_path, summary, goal_cycle_id, goal_run_purpose, goal_base_commit)
       VALUES (?, ?, ?, (SELECT id FROM workflows LIMIT 1), '{}', 'task', 'economy', 'normal', 'queued', ?, ?, ?, 'Did the work', ?, ?, ?)`,
    ).run(
      runId,
      machine,
      fx.projectId,
      new Date().toISOString(),
      branch,
      worktree,
      request.cycleId,
      request.purpose,
      request.baseCommit,
    );
    return runId;
  };

  const executor = new FakeGoalExecutor(db, makeRun);
  // Mirrors `startQueuedRun`: only a persisted queued run starts, and the structured result is returned.
  const startRun = vi.fn<(runId: string) => StartRunResult>((runId) => {
    const row = db.prepare('SELECT status, goal_run_purpose AS purpose FROM runs WHERE id = ?').get(runId) as
      { status: string; purpose: string | null } | undefined;
    if (!row) return { started: false, reason: 'not-found' };
    if (row.status !== 'queued') return { started: false, reason: 'not-queued' };
    db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
    if (row.purpose === 'proposal' && options.autoAnswer !== false) answerProposal(runId);
    return { started: true };
  });
  const countStarts = (proposal: boolean): number =>
    startRun.mock.calls.filter(([runId]) => {
      const row = db.prepare('SELECT goal_run_purpose AS purpose FROM runs WHERE id = ?').get(runId) as
        { purpose: string | null } | undefined;
      return (row?.purpose === 'proposal') === proposal;
    }).length;
  const resumeRun = vi.fn<(runId: string) => void>();
  const integrationHooks: IntegrationHooks = {};
  const supervisor = new GoalSupervisor({
    db,
    executor,
    startRun,
    resumeRun,
    activeTime: tracker,
    integrationHooks,
  });
  const h: Harness = {
    fx,
    supervisor,
    executor,
    model,
    answerProposal,
    integrationHooks,
    restart() {
      const fresh = new FakeGoalExecutor(db, makeRun);
      return {
        executor: fresh,
        supervisor: new GoalSupervisor({
          db,
          executor: fresh,
          startRun,
          resumeRun,
          activeTime: tracker,
          integrationHooks,
        }),
      };
    },
    tracker,
    clock,
    startRun,
    resumeRun,
    files,
    async tick() {
      return (await supervisor.tickGoal(fx.goalId)).action;
    },
    async until(stop, max = 30) {
      const seen: TickAction[] = [];
      for (let index = 0; index < max; index++) {
        const action = await h.tick();
        seen.push(action);
        if (action === stop) return seen;
      }
      throw new Error(`never reached ${stop}: ${seen.join(', ')}`);
    },
    status: () =>
      db.prepare('SELECT status, status_reason_code AS reason FROM goals WHERE id = ?').get(fx.goalId) as {
        status: string;
        reason: string | null;
      },
    cycle: () =>
      (
        db
          .prepare(
            `SELECT id, status, kind, outcome_json FROM goal_cycles WHERE goal_id = ? ORDER BY sequence DESC LIMIT 1`,
          )
          .all(fx.goalId) as Array<{ id: string; status: string; kind: string; outcome_json: string | null }>
      ).map((row) => ({
        id: row.id,
        status: row.status,
        kind: row.kind,
        outcome: row.outcome_json ? (JSON.parse(row.outcome_json) as Record<string, unknown>) : null,
      }))[0],
    runs: () =>
      db
        .prepare(
          "SELECT id, status, goal_cycle_id FROM runs WHERE goal_cycle_id IS NOT NULL AND goal_run_purpose <> 'proposal' ORDER BY rowid",
        )
        .all() as Array<{
        id: string;
        status: string;
        goal_cycle_id: string | null;
      }>,
    workStarts: () => countStarts(false),
    proposalStarts: () => countStarts(true),
    proposalRuns: () =>
      db
        .prepare(
          "SELECT id, status, goal_cycle_id FROM runs WHERE goal_run_purpose = 'proposal' ORDER BY rowid",
        )
        .all() as Array<{ id: string; status: string; goal_cycle_id: string | null }>,
    setRunStatus: (runId, status) => {
      db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, runId);
    },
    async start() {
      const result = await supervisor.startGoal(fx.goalId);
      if (!result.ok) throw new Error(`start failed: ${result.code}`);
    },
  };
  return h;
}
