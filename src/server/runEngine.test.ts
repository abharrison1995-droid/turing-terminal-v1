import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKFLOWS } from '../shared/workflows.js';
import type { WorkflowDefinition, WorkflowStage } from '../shared/types.js';
import { openDatabase, type Db } from './db.js';
import { parsePromptRefinement, RunEngine } from './runEngine.js';

describe('prompt refinement parsing', () => {
  it('accepts JSON fences and redacts prompt content', () => {
    expect(
      parsePromptRefinement(
        '```json\n{"specification":"Implement it; token=ghp_123456789012345678901234","ambiguities":["Which path?"],"questions":["Which path should change?"]}\n```',
      ),
    ).toEqual({
      specification: 'Implement it; token=[REDACTED]',
      ambiguities: ['Which path?'],
      questions: ['Which path should change?'],
    });
  });

  it('rejects missing or empty specifications', () => {
    expect(() => parsePromptRefinement('{"questions":[]}')).toThrow('readable specification');
    expect(() => parsePromptRefinement('{"specification":"  "}')).toThrow('empty specification');
  });
});

const folders: string[] = [];
let database: Db | null = null;
afterEach(() => {
  database?.close();
  database = null;
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function createGitStageFixture(permissionMode: WorkflowDefinition['permissionMode'] = 'yolo') {
  const root = mkdtempSync(join(tmpdir(), 'turing-git-stage-'));
  folders.push(root);
  const sourceRoot = join(root, 'repository');
  const projectPath = join(sourceRoot, 'apps', 'service');
  mkdirSync(projectPath, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', sourceRoot]);
  execFileSync('git', ['-C', sourceRoot, 'config', 'user.email', 'turing-test@example.invalid']);
  execFileSync('git', ['-C', sourceRoot, 'config', 'user.name', 'Turing Test']);
  writeFileSync(join(projectPath, 'app.txt'), 'start\n');
  execFileSync('git', ['-C', sourceRoot, 'add', '.']);
  execFileSync('git', ['-C', sourceRoot, 'commit', '-qm', 'initial']);
  const startingCommit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  database = openDatabase(join(root, 'state'));
  const machineId = (
    database.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
  ).value;
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO projects (id, machine_id, name, path, git_root, branch, dirty, created_at)
       VALUES ('project', ?, 'Service', ?, ?, 'main', 0, ?)`,
    )
    .run(machineId, projectPath, sourceRoot, now);
  database
    .prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile,
       permission_mode, status, created_at)
       VALUES ('git-run', ?, 'project', 'quick-fix', '{}', 'exercise Git stage', 'balanced', ?, 'running', ?)`,
    )
    .run(machineId, permissionMode, now);

  const workflow: WorkflowDefinition = {
    ...DEFAULT_WORKFLOWS[0]!,
    createdAt: now,
    updatedAt: now,
    permissionMode,
    stages: [],
  };
  const previousDataDir = process.env.TT_DATA_DIR;
  process.env.TT_DATA_DIR = join(root, 'engine-data');
  let workingCopy: { path: string; worktreePath: string | null; branch: string | null };
  try {
    const engine = new RunEngine(database, () => undefined);
    const prepare = (
      engine as unknown as {
        prepareWorkingCopy: (
          runId: string,
          workflow: WorkflowDefinition,
          projectPath: string,
        ) => Promise<{ path: string; worktreePath: string | null; branch: string | null }>;
      }
    ).prepareWorkingCopy.bind(engine);
    workingCopy = await prepare('git-run', workflow, projectPath);
    return { root, sourceRoot, projectPath, startingCommit, workflow, engine, workingCopy, database };
  } finally {
    if (previousDataDir === undefined) delete process.env.TT_DATA_DIR;
    else process.env.TT_DATA_DIR = previousDataDir;
  }
}

async function invokeGitStage(
  fixture: Awaited<ReturnType<typeof createGitStageFixture>>,
  stage: WorkflowStage,
): Promise<Record<string, unknown>> {
  const id = `stage-${stage.id}`;
  fixture.database
    .prepare(
      `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, logs)
       VALUES (?, 'git-run', ?, ?, ?, 0, 'running', '')`,
    )
    .run(id, stage.id, stage.kind, stage.label);
  const controller = new AbortController();
  const execute = (
    fixture.engine as unknown as {
      executeGitStage: (
        runId: string,
        stageId: string,
        stage: WorkflowStage,
        workflow: WorkflowDefinition,
        signal: AbortSignal,
      ) => Promise<Record<string, unknown>>;
    }
  ).executeGitStage.bind(fixture.engine);
  const previousDataDir = process.env.TT_DATA_DIR;
  process.env.TT_DATA_DIR = join(fixture.root, 'engine-data');
  try {
    return await execute('git-run', id, stage, fixture.workflow, controller.signal);
  } finally {
    if (previousDataDir === undefined) delete process.env.TT_DATA_DIR;
    else process.env.TT_DATA_DIR = previousDataDir;
  }
}

async function approveGitStage(
  fixture: Awaited<ReturnType<typeof createGitStageFixture>>,
  stage: WorkflowStage,
): Promise<Record<string, unknown>> {
  const id = `stage-${stage.id}`;
  const execution = invokeGitStage(fixture, stage);
  await vi.waitFor(() => {
    const row = fixture.database.prepare('SELECT status FROM git_operations WHERE stage_id = ?').get(id) as
      { status: string } | undefined;
    expect(row?.status).toBe('waiting_for_approval');
  });
  const approval = fixture.database
    .prepare("SELECT id FROM approvals WHERE stage_id = ? AND status = 'pending'")
    .get(id) as { id: string };
  expect(fixture.engine.decideApproval(approval.id, true)).toBe(true);
  return execution;
}

describe('isolated run working copies', () => {
  it('preserves the registered subfolder and reuses its worktree on resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turing-worktree-'));
    folders.push(root);
    const repository = join(root, 'repository');
    const projectPath = join(repository, 'apps', 'service');
    mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'turing-test@example.invalid']);
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'Turing Test']);
    writeFileSync(join(projectPath, 'index.ts'), 'export const start = true;\n');
    execFileSync('git', ['-C', repository, 'add', '.']);
    execFileSync('git', ['-C', repository, 'commit', '-qm', 'initial']);

    database = openDatabase(join(root, 'state'));
    const machineId = (
      database.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO projects (id, machine_id, name, path, git_root, branch, dirty, created_at)
      VALUES ('project', ?, 'Service', ?, ?, 'main', 0, ?)`,
      )
      .run(machineId, projectPath, repository, now);
    database
      .prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at)
      VALUES ('run', ?, 'project', 'quick-fix', '{}', 'implement', 'balanced', 'normal', 'queued', ?)`,
      )
      .run(machineId, now);

    const previousDataDir = process.env.TT_DATA_DIR;
    process.env.TT_DATA_DIR = join(root, 'engine-data');
    try {
      const engine = new RunEngine(database, () => undefined);
      const prepare = (
        engine as unknown as {
          prepareWorkingCopy: (
            runId: string,
            workflow: (typeof DEFAULT_WORKFLOWS)[number],
            projectPath: string,
          ) => Promise<{ path: string; worktreePath: string | null; branch: string | null }>;
        }
      ).prepareWorkingCopy.bind(engine);
      const workflow = DEFAULT_WORKFLOWS.find((item) => item.id === 'quick-fix')!;
      const first = await prepare('run', workflow, projectPath);
      expect(first.worktreePath).toBe(join(root, 'engine-data', 'worktrees', 'run'));
      expect(first.path).toBe(join(first.worktreePath!, 'apps', 'service'));
      expect(first.branch).toBe('turing/run');

      const agentChange = join(first.path, 'agent-change.ts');
      writeFileSync(agentChange, 'export const changed = true;\n');
      const resumed = await prepare('run', workflow, projectPath);
      expect(resumed.worktreePath).toBe(first.worktreePath);
      expect(resumed.path).toBe(first.path);
      expect(resumed.branch).toBe(first.branch);
      expect(existsSync(agentChange)).toBe(true);
    } finally {
      if (previousDataDir === undefined) delete process.env.TT_DATA_DIR;
      else process.env.TT_DATA_DIR = previousDataDir;
    }
  });
});

describe('first-class Git workflow stages', () => {
  it('records a checkpoint, commits on the run branch, and restores only that project subtree', async () => {
    const fixture = await createGitStageFixture('yolo');
    const worktree = fixture.workingCopy.worktreePath!;
    const project = fixture.workingCopy.path;
    const preCommitHook = join(fixture.sourceRoot, '.git', 'hooks', 'pre-commit');
    writeFileSync(preCommitHook, '#!/bin/sh\nexit 99\n');
    chmodSync(preCommitHook, 0o755);
    writeFileSync(join(project, 'app.txt'), 'checkpoint\n');
    writeFileSync(join(project, 'checkpoint-only.txt'), 'keep at checkpoint\n');

    const checkpoint = await invokeGitStage(fixture, {
      id: 'checkpoint',
      label: 'Checkpoint',
      kind: 'gitCheckpoint',
    });
    expect(checkpoint.treeHash).toMatch(/^[a-f0-9]{40,64}$/);
    expect(checkpoint.committed).toBe(false);
    expect(execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(
      fixture.startingCommit,
    );

    writeFileSync(join(project, 'app.txt'), 'later change\n');
    writeFileSync(join(project, 'later-only.txt'), 'remove after restore\n');
    const commit = await invokeGitStage(fixture, {
      id: 'commit',
      label: 'Commit',
      kind: 'gitCommit',
      commitMessage: 'Turing fixture change',
    });
    expect(commit.commit).not.toBe(fixture.startingCommit);

    const rollbackExecution = approveGitStage(fixture, {
      id: 'rollback',
      label: 'Rollback',
      kind: 'gitRollback',
      rollbackTarget: 'latestCheckpoint',
    });
    expect(await vi.waitFor(() => readFileSync(join(project, 'app.txt'), 'utf8'))).toBe('later change\n');
    const rollback = await rollbackExecution;
    expect(rollback.target).toBe('latestCheckpoint');
    expect(readFileSync(join(project, 'app.txt'), 'utf8')).toBe('checkpoint\n');
    expect(readFileSync(join(project, 'checkpoint-only.txt'), 'utf8')).toBe('keep at checkpoint\n');
    expect(existsSync(join(project, 'later-only.txt'))).toBe(false);
    expect(execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(
      fixture.startingCommit,
    );
    expect(
      fixture.database.prepare('SELECT operation, status FROM git_operations ORDER BY created_at').all(),
    ).toEqual([
      { operation: 'gitCheckpoint', status: 'completed' },
      { operation: 'gitCommit', status: 'completed' },
      { operation: 'gitRollback', status: 'completed' },
    ]);
  });

  it('requires approval for merge in ENIGMA and shows the diff before fast-forwarding', async () => {
    const fixture = await createGitStageFixture('enigma');
    const project = fixture.workingCopy.path;
    const worktree = fixture.workingCopy.worktreePath!;
    const postMergeHook = join(fixture.sourceRoot, '.git', 'hooks', 'post-merge');
    writeFileSync(postMergeHook, '#!/bin/sh\nexit 99\n');
    chmodSync(postMergeHook, 0o755);
    writeFileSync(join(project, 'app.txt'), 'reviewed change\n');
    await invokeGitStage(fixture, { id: 'commit', label: 'Commit', kind: 'gitCommit' });
    const runHead = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    const execution = invokeGitStage(fixture, { id: 'merge', label: 'Merge', kind: 'gitMerge' });
    await vi.waitFor(() => {
      const row = fixture.database
        .prepare("SELECT status FROM git_operations WHERE operation = 'gitMerge'")
        .get() as { status: string } | undefined;
      expect(row?.status).toBe('waiting_for_approval');
    });
    expect(
      execFileSync('git', ['-C', fixture.sourceRoot, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(),
    ).toBe(fixture.startingCommit);
    const approval = fixture.database
      .prepare("SELECT id, reason FROM approvals WHERE operation = 'Merge Turing run branch'")
      .get() as { id: string; reason: string };
    expect(approval.reason).toContain('reviewed change');
    expect(fixture.engine.decideApproval(approval.id, true)).toBe(true);
    const merged = await execution;
    expect(merged.commit).toBe(runHead);
    expect(
      execFileSync('git', ['-C', fixture.sourceRoot, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(),
    ).toBe(runHead);
    expect(
      fixture.database
        .prepare("SELECT approval_required, status, target FROM git_operations WHERE operation = 'gitMerge'")
        .get(),
    ).toMatchObject({ approval_required: 1, status: 'completed', target: 'main' });
  });

  it('pushes only after the permission policy approval and never uses force', async () => {
    const fixture = await createGitStageFixture('normal');
    const remote = join(fixture.root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    execFileSync('git', ['-C', fixture.sourceRoot, 'remote', 'add', 'origin', remote]);
    const prePushHook = join(fixture.sourceRoot, '.git', 'hooks', 'pre-push');
    writeFileSync(prePushHook, '#!/bin/sh\nexit 99\n');
    chmodSync(prePushHook, 0o755);
    writeFileSync(join(fixture.workingCopy.path, 'app.txt'), 'push me\n');

    const commitExecution = invokeGitStage(fixture, { id: 'commit', label: 'Commit', kind: 'gitCommit' });
    await vi.waitFor(() => {
      const row = fixture.database
        .prepare("SELECT status FROM git_operations WHERE operation = 'gitCommit'")
        .get() as { status: string } | undefined;
      expect(row?.status).toBe('waiting_for_approval');
    });
    const commitApproval = fixture.database
      .prepare("SELECT id FROM approvals WHERE operation = 'Create Git commit'")
      .get() as { id: string };
    expect(fixture.engine.decideApproval(commitApproval.id, true)).toBe(true);
    await commitExecution;

    const pushExecution = invokeGitStage(fixture, { id: 'push', label: 'Push', kind: 'gitPush' });
    await vi.waitFor(() => {
      const row = fixture.database
        .prepare("SELECT status FROM git_operations WHERE operation = 'gitPush'")
        .get() as { status: string } | undefined;
      expect(row?.status).toBe('waiting_for_approval');
    });
    expect(
      execFileSync(
        'git',
        ['--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/turing/git-run'],
        {
          encoding: 'utf8',
        },
      ).trim(),
    ).toBe('');
    const pushApproval = fixture.database
      .prepare("SELECT id FROM approvals WHERE operation = 'Push Git branch'")
      .get() as { id: string };
    expect(fixture.engine.decideApproval(pushApproval.id, true)).toBe(true);
    const pushed = await pushExecution;
    expect(pushed.remote).toBe('origin');
    expect(
      execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/turing/git-run'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(pushed.commit);
  });

  it('blocks commits when the run has changes outside the registered subfolder', async () => {
    const fixture = await createGitStageFixture('yolo');
    writeFileSync(join(fixture.workingCopy.path, 'app.txt'), 'inside\n');
    writeFileSync(join(fixture.workingCopy.worktreePath!, 'outside.txt'), 'outside\n');
    await expect(
      invokeGitStage(fixture, { id: 'outside', label: 'Commit outside', kind: 'gitCommit' }),
    ).rejects.toThrow('out-of-project path');
    expect(existsSync(join(fixture.workingCopy.worktreePath!, 'outside.txt'))).toBe(true);
  });

  it('blocks secret-looking content and keeps it out of Git operation history', async () => {
    const fixture = await createGitStageFixture('enigma');
    const secret = 'hidden-credential-material-123456';
    writeFileSync(join(fixture.workingCopy.path, 'settings.txt'), `api_key=${secret}\n`);
    await expect(
      invokeGitStage(fixture, { id: 'commit-secret', label: 'Commit secret', kind: 'gitCommit' }),
    ).rejects.toThrow('known credential pattern');
    const audit = fixture.database
      .prepare("SELECT status, result_json FROM git_operations WHERE operation = 'gitCommit'")
      .get() as { status: string; result_json: string };
    expect(audit.status).toBe('failed');
    expect(audit.result_json).not.toContain(secret);
    expect(
      execFileSync('git', ['-C', fixture.workingCopy.worktreePath!, 'diff', '--cached', '--name-only'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
  });
});

describe('brokered workflow commands', () => {
  it('waits for Supervised approval before starting a configured build command and audits the result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turing-command-broker-'));
    folders.push(root);
    const projectPath = join(root, 'project');
    mkdirSync(projectPath);
    writeFileSync(join(projectPath, 'package.json'), JSON.stringify({ scripts: { build: 'echo build-ok' } }));
    database = openDatabase(join(root, 'state'));
    const machineId = (
      database.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const now = new Date().toISOString();
    database
      .prepare('INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('project', machineId, 'Command test', projectPath, now);
    database
      .prepare(
        `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at)
         VALUES ('run', ?, 'project', 'quick-fix', '{}', 'build', 'balanced', 'supervised', 'running', ?)`,
      )
      .run(machineId, now);
    database
      .prepare(
        `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, logs)
         VALUES ('stage', 'run', 'build', 'build', 'Build', 0, 'running', '')`,
      )
      .run();

    const engine = new RunEngine(database, () => undefined);
    const executeCommand = (
      engine as unknown as {
        executeCommand: (
          runId: string,
          stageId: string,
          stage: { id: string; label: string; kind: 'build' },
          command: string[],
          cwd: string,
          signal: AbortSignal,
        ) => Promise<Record<string, unknown>>;
      }
    ).executeCommand.bind(engine);
    const controller = new AbortController();
    const execution = executeCommand(
      'run',
      'stage',
      { id: 'build', label: 'Build', kind: 'build' },
      ['npm', 'run', 'build'],
      projectPath,
      controller.signal,
    );
    await vi.waitFor(() => {
      expect(
        (database!.prepare("SELECT status FROM runs WHERE id = 'run'").get() as { status: string }).status,
      ).toBe('waiting_for_approval');
    });
    expect(
      (
        database.prepare("SELECT status FROM execution_operations WHERE run_id = 'run'").get() as {
          status: string;
        }
      ).status,
    ).toBe('requested');
    const approval = database
      .prepare("SELECT id FROM approvals WHERE run_id = 'run' AND status = 'pending'")
      .get() as { id: string };
    expect(engine.decideApproval(approval.id, true)).toBe(true);
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(
      database
        .prepare(
          "SELECT status, approval_required, approval_id, exit_code FROM execution_operations WHERE run_id = 'run'",
        )
        .get(),
    ).toMatchObject({ status: 'completed', approval_required: 1, approval_id: approval.id, exit_code: 0 });
  });

  it('cancels a run paused for prompt refinement without an active controller', async () => {
    const fixture = await createGitStageFixture();
    fixture.database.prepare("UPDATE runs SET status = 'waiting_for_user' WHERE id = 'git-run'").run();
    fixture.database
      .prepare(
        `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, logs)
         VALUES ('refinement-stage', 'git-run', 'refine', 'promptRefinement', 'Refine task', 0, 'waiting_for_user', '')`,
      )
      .run();
    new RunEngine(fixture.database, () => undefined).reconcileInterruptedRuns();
    expect(fixture.database.prepare("SELECT status FROM runs WHERE id = 'git-run'").get()).toMatchObject({
      status: 'waiting_for_user',
    });

    expect(fixture.engine.cancel('git-run')).toBe(true);
    expect(fixture.database.prepare("SELECT status FROM runs WHERE id = 'git-run'").get()).toMatchObject({
      status: 'cancelled',
    });
    expect(
      fixture.database.prepare("SELECT status FROM stages WHERE id = 'refinement-stage'").get(),
    ).toMatchObject({
      status: 'cancelled',
    });
    expect(
      fixture.database.prepare("SELECT type FROM run_events WHERE run_id = 'git-run'").get(),
    ).toMatchObject({ type: 'run_cancelled' });
  });

  it('runs a forward conditional branch and skips downstream shell work after a failed build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'turing-condition-run-'));
    folders.push(root);
    database = openDatabase(join(root, 'state'));
    const machineId = (
      database.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const now = new Date().toISOString();
    const engine = new RunEngine(database, () => undefined);
    const stages: WorkflowStage[] = [
      { id: 'build', label: 'Build', kind: 'build', continueOnFailure: true },
      {
        id: 'branch',
        label: 'Build succeeded?',
        kind: 'conditionalBranch',
        condition: { path: 'build.success', operator: 'equals', value: true },
        skipStageIds: ['marker'],
      },
      { id: 'marker', label: 'Write marker', kind: 'shellCommand', command: ['npm', 'run', 'lint'] },
    ];
    const workflow: WorkflowDefinition = {
      id: 'fixture',
      name: 'Conditional fixture',
      description: 'Branch on build result.',
      template: 'test',
      executionProfile: 'balanced',
      permissionMode: 'normal',
      promptRefinementDefault: false,
      maxRemediationRounds: 0,
      maxParallelAgents: 1,
      maxDurationMinutes: 120,
      retryPolicy: { maxRetries: 1, initialDelayMs: 1_000, maxDelayMs: 30_000 },
      isolatedWorktree: false,
      stages,
      version: 1,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };

    const createFixtureRun = (runId: string, buildScript: string) => {
      const projectPath = join(root, runId);
      mkdirSync(projectPath);
      writeFileSync(
        join(projectPath, 'package.json'),
        JSON.stringify({ scripts: { build: buildScript, lint: 'echo ran > marker.txt' } }),
      );
      database!
        .prepare(
          `INSERT INTO projects (id, machine_id, name, path, build_command_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(`project-${runId}`, machineId, runId, projectPath, JSON.stringify(['npm', 'run', 'build']), now);
      database!
        .prepare(
          `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile, permission_mode, status, created_at)
           VALUES (?, ?, ?, 'quick-fix', ?, 'test condition', 'balanced', 'normal', 'queued', ?)`,
        )
        .run(runId, machineId, `project-${runId}`, JSON.stringify(workflow), now);
      const insertStage = database!.prepare(
        `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, status, logs)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', '')`,
      );
      stages.forEach((stage, sequence) =>
        insertStage.run(`${runId}-${stage.id}`, runId, stage.id, stage.kind, stage.label, sequence),
      );
      return projectPath;
    };

    const failedPath = createFixtureRun('failed-build', 'exit 1');
    engine.start('failed-build');
    await vi.waitFor(() => {
      expect(
        (database!.prepare("SELECT status FROM runs WHERE id = 'failed-build'").get() as { status: string })
          .status,
      ).toBe('completed');
    });
    expect(existsSync(join(failedPath, 'marker.txt'))).toBe(false);
    expect(
      database
        .prepare("SELECT status FROM stages WHERE run_id = 'failed-build' AND stage_key = 'build'")
        .get(),
    ).toMatchObject({ status: 'failed' });
    expect(
      database
        .prepare("SELECT status FROM stages WHERE run_id = 'failed-build' AND stage_key = 'marker'")
        .get(),
    ).toMatchObject({ status: 'skipped' });
    expect(
      database
        .prepare("SELECT status FROM stages WHERE run_id = 'failed-build' AND stage_key = 'branch'")
        .get(),
    ).toMatchObject({ status: 'passed' });
  });
});
