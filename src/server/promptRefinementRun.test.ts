import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '../shared/types.js';
import { openDatabase } from './db.js';
import { executeProvider } from './providers.js';
import { RunEngine } from './runEngine.js';

vi.mock('./providers.js', () => ({ executeProvider: vi.fn() }));

describe('prompt refinement run handoff', () => {
  let root = '';
  afterEach(() => {
    vi.clearAllMocks();
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('persists the proposal, waits for confirmation, then hands the approved task to later stages', async () => {
    root = mkdtempSync(join(tmpdir(), 'turing-refinement-run-'));
    const projectPath = join(root, 'project');
    mkdirSync(projectPath);
    const db = openDatabase(join(root, 'state'));
    const machineId = (
      db.prepare("SELECT value FROM settings WHERE key = 'local_machine_id'").get() as { value: string }
    ).value;
    const now = new Date().toISOString();
    const workflow: WorkflowDefinition = {
      id: 'refinement-test',
      name: 'Refinement test',
      description: 'Test user-confirmed prompt handoff.',
      template: 'test',
      executionProfile: 'balanced',
      permissionMode: 'normal',
      promptRefinementDefault: false,
      maxRemediationRounds: 0,
      maxParallelAgents: 1,
      maxDurationMinutes: 120,
      retryPolicy: { maxRetries: 1, initialDelayMs: 100, maxDelayMs: 100 },
      isolatedWorktree: false,
      version: 1,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      stages: [
        {
          id: 'refine',
          label: 'Refine request',
          kind: 'promptRefinement',
          role: 'implementer',
          backendId: 'test',
          providerId: 'test-provider',
          modelId: 'test-model',
        },
        {
          id: 'implement',
          label: 'Implement',
          kind: 'implementer',
          role: 'implementer',
          backendId: 'test',
          providerId: 'test-provider',
          modelId: 'test-model',
        },
      ],
    };
    db.prepare('INSERT INTO projects (id, machine_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'project',
      machineId,
      'Test project',
      projectPath,
      now,
    );
    db.prepare(
      `INSERT INTO workflows (id, name, description, template, config_json, version, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(
      workflow.id,
      workflow.name,
      workflow.description,
      workflow.template,
      JSON.stringify(workflow),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO runs (id, machine_id, project_id, workflow_id, workflow_snapshot_json, prompt, profile,
       permission_mode, refinement_requested, status, created_at)
       VALUES ('run', ?, 'project', ?, ?, 'Add a preference setting.', 'balanced', 'normal', 1, 'queued', ?)`,
    ).run(machineId, workflow.id, JSON.stringify(workflow), now);
    const insertStage = db.prepare(
      `INSERT INTO stages (id, run_id, stage_key, kind, title, sequence, backend_id, provider_id, model_id, status, input_json, logs)
       VALUES (?, 'run', ?, ?, ?, ?, ?, ?, ?, 'pending', '{}', '')`,
    );
    workflow.stages.forEach((stage, sequence) =>
      insertStage.run(
        `stage-${stage.id}`,
        stage.id,
        stage.kind,
        stage.label,
        sequence,
        stage.backendId,
        stage.providerId,
        stage.modelId,
      ),
    );

    vi.mocked(executeProvider)
      .mockRejectedValueOnce(new Error('temporary service unavailable (503)'))
      .mockResolvedValueOnce({
        text: JSON.stringify({
          specification: 'Add a user preference setting with a persistent value.',
          ambiguities: ['Should this use an existing settings screen?'],
          questions: ['Should this use an existing settings screen?'],
        }),
        inputTokens: 10,
        outputTokens: 12,
        usageProvenance: 'provider_reported',
        exitCode: 0,
        stdout: '',
      })
      .mockResolvedValueOnce({
        text: 'Implementation complete.',
        inputTokens: 20,
        outputTokens: 8,
        usageProvenance: 'provider_reported',
        exitCode: 0,
        stdout: '',
      });

    const engine = new RunEngine(db, () => undefined);
    engine.start('run');
    await vi.waitFor(() => expect(executeProvider).toHaveBeenCalledTimes(2));
    expect(vi.mocked(executeProvider).mock.calls[0]?.[0].role).toBe('prompt-refinement');
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status FROM runs WHERE id = 'run'").get()).toMatchObject({
        status: 'waiting_for_user',
      });
    });
    expect(db.prepare("SELECT status FROM stages WHERE id = 'stage-refine'").get()).toMatchObject({
      status: 'waiting_for_user',
    });
    expect(db.prepare("SELECT refined_specification FROM runs WHERE id = 'run'").get()).toMatchObject({
      refined_specification: 'Add a user preference setting with a persistent value.',
    });
    expect(
      db
        .prepare('SELECT attempt, status, category FROM stage_attempts WHERE stage_id = ? ORDER BY attempt')
        .all('stage-refine'),
    ).toEqual([
      { attempt: 1, status: 'retrying', category: 'provider_transient' },
      { attempt: 2, status: 'succeeded', category: null },
    ]);

    db.prepare("UPDATE runs SET refined_specification = ?, status = 'queued' WHERE id = 'run'").run(
      'Add a persistent setting to the existing Preferences screen.',
    );
    db.prepare("UPDATE stages SET status = 'passed', output_json = ? WHERE id = 'stage-refine'").run(
      JSON.stringify({
        specification: 'Add a user preference setting with a persistent value.',
        confirmedSpecification: 'Add a persistent setting to the existing Preferences screen.',
        clarification: 'Use the existing Preferences screen.',
      }),
    );
    engine.start('run', true);
    await vi.waitFor(() => {
      expect(db.prepare("SELECT status FROM runs WHERE id = 'run'").get()).toMatchObject({
        status: 'completed',
      });
    });

    const implementerPrompt = vi.mocked(executeProvider).mock.calls[2]?.[0].prompt;
    expect(implementerPrompt).toContain('Add a persistent setting to the existing Preferences screen.');
    expect(implementerPrompt).toContain('User clarification:\nUse the existing Preferences screen.');
    db.close();
  });
});
