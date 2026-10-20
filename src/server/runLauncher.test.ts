import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { RunEngine } from './runEngine.js';
import {
  buildPreview,
  cancelOrdinaryQueuedRun,
  cancelQueuedRun,
  createRun,
  queueRun,
  recoverQueuedRunsAfterRestart,
  startQueuedRun,
  type RunPreview,
} from './runLauncher.js';

describe('run launcher', () => {
  let root = '';
  let db: ReturnType<typeof openDatabase>;
  let engine: RunEngine;
  let app: ReturnType<typeof createApp>;
  let projectId = '';
  let workflowId = '';

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'turing-launcher-'));
    const projectPath = join(root, 'project');
    mkdirSync(projectPath);
    writeFileSync(join(projectPath, 'package.json'), '{}');
    db = openDatabase(join(root, 'state'));
    engine = new RunEngine(db, () => undefined);
    app = createApp({ database: db, engine });
    await app.ready();
    const added = await app.inject({ method: 'POST', url: '/api/projects', payload: { path: projectPath } });
    projectId = added.json().project.id as string;
    const workflow = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        name: 'Launcher test',
        description: 'Single approval gate.',
        template: 'test',
        executionProfile: 'economy',
        permissionMode: 'normal',
        maxRemediationRounds: 0,
        maxParallelAgents: 1,
        isolatedWorktree: false,
        stages: [{ id: 'gate', label: 'Gate', kind: 'humanApproval' }],
      },
    });
    workflowId = workflow.json().workflow.id as string;
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const preview = async (): Promise<RunPreview> => {
    const result = await buildPreview(db, { task: 'Launcher task.', projectId, workflowId });
    expect(result).not.toBeNull();
    return result!;
  };
  const runCount = () => (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;

  it('builds a preview without persisting a run and returns null for unknown project or workflow', async () => {
    const result = await preview();
    expect(result.canStart).toBe(true);
    expect(result.task).toBe('Launcher task.');
    expect(result.workflow.id).toBe(workflowId);
    expect(runCount()).toBe(0);
    expect(await buildPreview(db, { task: 'x', projectId: 'missing', workflowId })).toBeNull();
    expect(await buildPreview(db, { task: 'x', projectId, workflowId: 'missing' })).toBeNull();
  });

  it('queues a run with stages and a run_queued event without starting execution', async () => {
    const start = vi.spyOn(engine, 'start');
    const { runId } = queueRun(db, await preview());
    expect(start).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status, prompt FROM runs WHERE id = ?').get(runId)).toMatchObject({
      status: 'queued',
      prompt: 'Launcher task.',
    });
    expect(db.prepare('SELECT stage_key, status FROM stages WHERE run_id = ?').all(runId)).toEqual([
      { stage_key: 'gate', status: 'pending' },
    ]);
    const events = db
      .prepare('SELECT type, payload_json FROM run_events WHERE run_id = ?')
      .all(runId) as Array<{
      type: string;
      payload_json: string;
    }>;
    expect(events.map((event) => event.type)).toEqual(['run_queued']);
    expect(JSON.parse(events[0]!.payload_json)).toMatchObject({ projectId, workflowId });
    expect(db.prepare('SELECT rules_snapshot_json FROM runs WHERE id = ?').get(runId)).toMatchObject({
      rules_snapshot_json: expect.any(String),
    });
  });

  it('honours replay options for the rules snapshot and event type', async () => {
    const { runId } = queueRun(db, await preview(), {
      rulesSnapshot: [{ id: 'saved' }],
      eventType: 'run_replayed',
      eventDetails: { sourceRunId: 'source' },
    });
    const row = db.prepare('SELECT rules_snapshot_json FROM runs WHERE id = ?').get(runId) as {
      rules_snapshot_json: string;
    };
    expect(JSON.parse(row.rules_snapshot_json)).toEqual([{ id: 'saved' }]);
    const event = db.prepare('SELECT type, payload_json FROM run_events WHERE run_id = ?').get(runId) as {
      type: string;
      payload_json: string;
    };
    expect(event.type).toBe('run_replayed');
    expect(JSON.parse(event.payload_json)).toMatchObject({ sourceRunId: 'source' });
  });

  it('starts a queued run only when startQueuedRun is called', async () => {
    const start = vi.spyOn(engine, 'start');
    const { runId } = queueRun(db, await preview());
    startQueuedRun(db, engine, runId);
    expect(start).toHaveBeenCalledExactlyOnceWith(runId);
    await vi.waitFor(() => {
      expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toMatchObject({
        status: 'waiting_for_approval',
      });
    });
  });

  it('createRun queues then starts immediately and returns the run summary', async () => {
    const start = vi.spyOn(engine, 'start');
    const run = createRun(db, engine, await preview());
    expect(start).toHaveBeenCalledExactlyOnceWith(run.id);
    expect(run).toMatchObject({ prompt: 'Launcher task.', projectId });
    expect(runCount()).toBe(1);
    await vi.waitFor(() => {
      expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(run.id)).toMatchObject({
        status: 'waiting_for_approval',
      });
    });
  });

  it('leaves Goal origin columns NULL on ordinary runs', async () => {
    const run = createRun(db, engine, await preview());
    expect(
      db
        .prepare('SELECT goal_cycle_id, goal_run_purpose, goal_base_commit FROM runs WHERE id = ?')
        .get(run.id),
    ).toEqual({ goal_cycle_id: null, goal_run_purpose: null, goal_base_commit: null });
  });

  describe('queued ordinary run recovery after a restart (HR-Q4)', () => {
    const queuedIds = () =>
      (
        db.prepare("SELECT id FROM runs WHERE status = 'queued' ORDER BY created_at, id").all() as Array<{
          id: string;
        }>
      ).map((row) => row.id);
    const statusOf = (runId: string) =>
      (db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status;
    const recoveredEvents = (runId: string) =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'run_recovered_after_restart'",
          )
          .get(runId) as { n: number }
      ).n;

    it('forged-state: starts an ordinary run left queued by a crash between queueRun and start, exactly once', async () => {
      // Forged crash: createRun commits the queued row, then the process dies before the engine starts it.
      const prepared = await preview();
      vi.spyOn(engine, 'start').mockImplementation(() => {
        throw new Error('simulated crash before start');
      });
      expect(() => createRun(db, engine, prepared)).toThrow('simulated crash before start');
      expect(queuedIds()).toHaveLength(1);
      const runId = queuedIds()[0]!;

      const restarted = new RunEngine(db, () => undefined);
      const start = vi.spyOn(restarted, 'start');
      restarted.reconcileInterruptedRuns();
      recoverQueuedRunsAfterRestart(db, restarted);
      expect(start).toHaveBeenCalledExactlyOnceWith(runId);
      expect(queuedIds()).toEqual([]);
      expect(recoveredEvents(runId)).toBe(1);
      await vi.waitFor(() => expect(statusOf(runId)).toBe('waiting_for_approval'));
    });

    it('does not start a queued run that was cancelled before the restart', async () => {
      const { runId } = queueRun(db, await preview());
      expect(cancelQueuedRun(db, runId, 'Cancelled before the restart.')).toEqual({ cancelled: true });
      const restarted = new RunEngine(db, () => undefined);
      const start = vi.spyOn(restarted, 'start');
      restarted.reconcileInterruptedRuns();
      recoverQueuedRunsAfterRestart(db, restarted);
      expect(start).not.toHaveBeenCalled();
      expect(statusOf(runId)).toBe('cancelled');
      expect(recoveredEvents(runId)).toBe(0);
    });

    it('two fresh engines over one database start a queued run once; the owner path then reports not-queued', async () => {
      const { runId } = queueRun(db, await preview());
      const first = new RunEngine(db, () => undefined);
      const second = new RunEngine(db, () => undefined);
      const firstStart = vi.spyOn(first, 'start');
      const secondStart = vi.spyOn(second, 'start');
      first.reconcileInterruptedRuns();
      recoverQueuedRunsAfterRestart(db, first);
      expect(firstStart).toHaveBeenCalledExactlyOnceWith(runId);
      expect(startQueuedRun(db, second, runId)).toEqual({ started: false, reason: 'not-queued' });
      await vi.waitFor(() => expect(statusOf(runId)).toBe('waiting_for_approval'));
      // The second reconcile's existing interrupted-run pass may pause the live run; it must never start it again.
      second.reconcileInterruptedRuns();
      recoverQueuedRunsAfterRestart(db, second);
      expect(secondStart).not.toHaveBeenCalled();
      expect(firstStart).toHaveBeenCalledExactlyOnceWith(runId);
      expect(recoveredEvents(runId)).toBe(1);
    });

    it('a second engine reconciling from inside the first start cannot start the same run again', async () => {
      const { runId } = queueRun(db, await preview());
      const first = new RunEngine(db, () => undefined);
      const second = new RunEngine(db, () => undefined);
      const realStart = first.start.bind(first);
      const firstStart = vi.spyOn(first, 'start').mockImplementation((id: string) => {
        // Re-entrant recovery: the claim must already be persisted, or this pass would see the run as queued.
        second.reconcileInterruptedRuns();
        recoverQueuedRunsAfterRestart(db, second);
        realStart(id);
      });
      const secondStart = vi.spyOn(second, 'start');
      first.reconcileInterruptedRuns();
      recoverQueuedRunsAfterRestart(db, first);
      expect(firstStart).toHaveBeenCalledExactlyOnceWith(runId);
      expect(secondStart).not.toHaveBeenCalled();
      expect(recoveredEvents(runId)).toBe(1);
    });
  });
  describe('user cancellation of a queued ordinary run (Stop before start)', () => {
    const statusOf = (runId: string) =>
      (db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status;
    const cancelledEvents = (runId: string) =>
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'run_cancelled'")
          .get(runId) as { n: number }
      ).n;
    const cancel = (runId: string) => app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel` });

    it('cancels a queued ordinary run without starting it, records one event, and marks its pending stages cancelled', async () => {
      const { runId } = queueRun(db, await preview());
      const start = vi.spyOn(engine, 'start');
      const published = vi.spyOn(engine, 'publishRunStatus');
      const response = await cancel(runId);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: true, status: 'cancelled' });
      expect(published).toHaveBeenCalledExactlyOnceWith(runId, 'cancelled');
      expect(statusOf(runId)).toBe('cancelled');
      expect(start).not.toHaveBeenCalled();
      expect(cancelledEvents(runId)).toBe(1);
      const stages = db.prepare('SELECT status FROM stages WHERE run_id = ?').all(runId) as Array<{
        status: string;
      }>;
      expect(stages.length).toBeGreaterThan(0);
      expect(stages.every((stage) => stage.status === 'cancelled')).toBe(true);
    });

    it('is idempotent: a repeated cancel reports the run cancelled and records no second event', async () => {
      const { runId } = queueRun(db, await preview());
      expect((await cancel(runId)).statusCode).toBe(200);
      const published = vi.spyOn(engine, 'publishRunStatus');
      const again = await cancel(runId);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ accepted: true, status: 'cancelled' });
      expect(published).not.toHaveBeenCalled();
      expect(statusOf(runId)).toBe('cancelled');
      expect(cancelledEvents(runId)).toBe(1);
    });

    it('a run cancelled before a restart is never started by recovery, and a later start is refused', async () => {
      const { runId } = queueRun(db, await preview());
      expect((await cancel(runId)).statusCode).toBe(200);
      const restarted = new RunEngine(db, () => undefined);
      const start = vi.spyOn(restarted, 'start');
      expect(recoverQueuedRunsAfterRestart(db, restarted)).toEqual([]);
      expect(start).not.toHaveBeenCalled();
      expect(startQueuedRun(db, restarted, runId)).toEqual({ started: false, reason: 'not-queued' });
      expect(statusOf(runId)).toBe('cancelled');
    });

    it('a run that recovery already claimed and started is never cancelled through the queued path', async () => {
      const { runId } = queueRun(db, await preview());
      const restarted = new RunEngine(db, () => undefined);
      // Recovery commits the `preparing` claim before start, so execution is stubbed: it must not outlive the database.
      const start = vi.spyOn(restarted, 'start').mockImplementation(() => {});
      expect(recoverQueuedRunsAfterRestart(db, restarted)).toEqual([runId]);
      expect(start).toHaveBeenCalledExactlyOnceWith(runId);
      expect(statusOf(runId)).toBe('preparing');
      // The new guard refuses on status alone, before any engine check, so the claimed run is protected directly.
      expect(cancelOrdinaryQueuedRun(db, restarted, runId)).toEqual({
        cancelled: false,
        reason: 'not-queued',
      });
      const response = await cancel(runId);
      expect(response.json()).not.toEqual({ accepted: true, status: 'cancelled' });
      expect(statusOf(runId)).not.toBe('cancelled');
      expect(cancelledEvents(runId)).toBe(0);
    });
  });
});
