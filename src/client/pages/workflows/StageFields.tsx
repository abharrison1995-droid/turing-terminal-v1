import type {
  WorkflowCondition,
  WorkflowConditionPath,
  WorkflowDefinition,
  WorkflowStage,
} from '../../../shared/types';
import { OrchestratorBranchesEditor } from '../../phase36';
import { isAiStage } from '../shared/stageMeta';

type Change = (patch: Partial<WorkflowStage>) => void;

const globs = (value: string) =>
  value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

/** Fields that belong to one stage kind. AI stages also get their instructions here; the model lives in StageAssignment. */
export function StageTypeFields({
  stage,
  laterStages,
  onChange,
}: {
  stage: WorkflowStage;
  laterStages: WorkflowStage[];
  onChange: Change;
}) {
  const updateCondition = (condition: NonNullable<WorkflowStage['condition']>) => onChange({ condition });
  return (
    <>
      {stage.kind === 'orchestrator' && (
        <OrchestratorBranchesEditor stage={stage} laterStages={laterStages} onChange={onChange} />
      )}
      {stage.kind === 'parallelReview' && (
        <label className="form-field small-number-field">
          <span>Reviewer count</span>
          <input
            type="number"
            min={1}
            max={8}
            value={stage.parallelism ?? 1}
            onChange={(event) =>
              onChange({ parallelism: Math.min(8, Math.max(1, Number(event.target.value))) })
            }
          />
        </label>
      )}
      {stage.kind === 'shellCommand' && (
        <label className="form-field">
          <span>Project command</span>
          <input
            value={stage.command?.join(' ') ?? ''}
            onChange={(event) =>
              onChange({ command: event.target.value.trim().split(/\s+/).filter(Boolean) })
            }
            placeholder="npm run test"
          />
          <small>Only package scripts named build, test, or lint are supported.</small>
        </label>
      )}
      {stage.kind === 'notification' && (
        <label className="form-field">
          <span>Notification message</span>
          <textarea
            value={stage.notificationMessage ?? ''}
            maxLength={1_000}
            onChange={(event) => onChange({ notificationMessage: event.target.value })}
            placeholder="A workflow notification stage was reached."
            rows={3}
          />
          <small>Delivered to connected browser clients with notification permission.</small>
        </label>
      )}
      {stage.kind === 'gitCommit' && (
        <label className="form-field">
          <span>Commit message</span>
          <input
            value={stage.commitMessage ?? ''}
            maxLength={120}
            onChange={(event) => onChange({ commitMessage: event.target.value })}
            placeholder="Turing Terminal run commit"
          />
          <small>Only changes under the registered project folder are included.</small>
        </label>
      )}
      {stage.kind === 'gitPush' && (
        <>
          <label className="form-field">
            <span>Remote</span>
            <input
              value={stage.pushRemote ?? 'origin'}
              maxLength={61}
              onChange={(event) => onChange({ pushRemote: event.target.value })}
              placeholder="origin"
            />
          </label>
          <label className="form-field">
            <span>Remote branch</span>
            <input
              value={stage.pushBranch ?? ''}
              maxLength={100}
              onChange={(event) => onChange({ pushBranch: event.target.value })}
              placeholder="Same as the Turing run branch"
            />
            <small>Force push is never used. Push always waits for approval, including in ENIGMA.</small>
          </label>
        </>
      )}
      {stage.kind === 'gitRollback' && (
        <label className="form-field">
          <span>Restore point</span>
          <select
            value={stage.rollbackTarget ?? 'runStart'}
            onChange={(event) =>
              onChange({ rollbackTarget: event.target.value as WorkflowStage['rollbackTarget'] })
            }
          >
            <option value="runStart">Run start</option>
            <option value="latestCheckpoint">Latest earlier checkpoint</option>
          </select>
          <small>Always asks before changing the isolated run worktree.</small>
        </label>
      )}
      {stage.kind === 'conditionalBranch' && (
        <>
          <label className="form-field">
            <span>Condition field</span>
            <select
              value={stage.condition?.path ?? 'build.success'}
              onChange={(event) => {
                const path = event.target.value as WorkflowConditionPath;
                updateCondition({
                  path,
                  operator: 'equals',
                  value: path === 'build.success' ? true : path === 'finalGate.status' ? 'PASS' : 0,
                });
              }}
            >
              <option value="build.success">Build succeeded</option>
              <option value="tests.failed">Failed test stages</option>
              <option value="review.openCritical">Open critical findings</option>
              <option value="review.openHigh">Open high findings</option>
              <option value="finalGate.status">Final gate status</option>
            </select>
          </label>
          <label className="form-field">
            <span>Comparison</span>
            <select
              value={stage.condition?.operator ?? 'equals'}
              onChange={(event) =>
                stage.condition &&
                updateCondition({
                  ...stage.condition,
                  operator: event.target.value as WorkflowCondition['operator'],
                })
              }
            >
              <option value="equals">equals</option>
              <option value="notEquals">does not equal</option>
              {stage.condition?.path !== 'finalGate.status' && (
                <>
                  <option value="greaterThan">greater than</option>
                  <option value="lessThan">less than</option>
                </>
              )}
            </select>
          </label>
          <label className="form-field">
            <span>Expected value</span>
            {stage.condition?.path === 'build.success' ? (
              <select
                value={String(stage.condition.value)}
                onChange={(event) =>
                  stage.condition &&
                  updateCondition({ ...stage.condition, value: event.target.value === 'true' })
                }
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : stage.condition?.path === 'finalGate.status' ? (
              <select
                value={String(stage.condition.value)}
                onChange={(event) =>
                  stage.condition && updateCondition({ ...stage.condition, value: event.target.value })
                }
              >
                <option value="PASS">PASS</option>
                <option value="FAIL">FAIL</option>
              </select>
            ) : (
              <input
                type="number"
                min={0}
                value={Number(stage.condition?.value ?? 0)}
                onChange={(event) =>
                  stage.condition &&
                  updateCondition({ ...stage.condition, value: Number(event.target.value) })
                }
              />
            )}
          </label>
          <fieldset className="condition-skip-targets">
            <legend>Skip these later stages when the condition is false</legend>
            {laterStages.map((later) => (
              <label className="rule-flag" key={later.id}>
                <input
                  type="checkbox"
                  checked={(stage.skipStageIds ?? []).includes(later.id)}
                  onChange={(event) =>
                    onChange({
                      skipStageIds: event.target.checked
                        ? [...(stage.skipStageIds ?? []), later.id]
                        : (stage.skipStageIds ?? []).filter((id) => id !== later.id),
                    })
                  }
                />
                {later.label}
              </label>
            ))}
          </fieldset>
        </>
      )}
      {['build', 'test', 'shellCommand'].includes(stage.kind) && (
        <label className="rule-flag">
          <input
            type="checkbox"
            checked={Boolean(stage.continueOnFailure)}
            onChange={(event) => onChange({ continueOnFailure: event.target.checked })}
          />
          Continue to conditional stages after failure
        </label>
      )}
      {isAiStage(stage.kind) && (
        <label className="form-field stage-wide">
          <span>Custom stage instructions</span>
          <textarea
            rows={3}
            maxLength={8_000}
            value={stage.customInstructions ?? ''}
            onChange={(event) => onChange({ customInstructions: event.target.value })}
            placeholder="Optional. These stay below mandatory security, Global Rules, Project Rules, and Turing role instructions."
          />
        </label>
      )}
    </>
  );
}

/** Per-stage overrides for time, retries and context. Each shows the workflow value it would otherwise inherit. */
export function StageLimitsFields({
  stage,
  workflowContextPolicy,
  onChange,
}: {
  stage: WorkflowStage;
  workflowContextPolicy: WorkflowDefinition['contextPolicy'];
  onChange: Change;
}) {
  const ai = isAiStage(stage.kind);
  const policy = stage.contextPolicy;
  const setPolicy = (patch: Partial<NonNullable<WorkflowStage['contextPolicy']>>) =>
    onChange({ contextPolicy: { ...policy, ...patch } });
  return (
    <details className="settings-disclosure stage-advanced">
      <summary>
        Limits and context
        <small>
          {stage.timeoutMinutes ? `${stage.timeoutMinutes} min timeout` : 'Workflow timeout'}
          {ai ? ` · ${policy?.strategy ?? workflowContextPolicy.strategy} context` : ''}
        </small>
      </summary>
      <div className="stage-advanced-grid">
        <label className="form-field small-number-field">
          <span>Stage timeout (minutes)</span>
          <input
            type="number"
            min={1}
            max={360}
            value={stage.timeoutMinutes ?? ''}
            placeholder="Workflow default"
            onChange={(event) =>
              onChange({
                timeoutMinutes: event.target.value
                  ? Math.min(360, Math.max(1, Number(event.target.value)))
                  : undefined,
              })
            }
          />
        </label>
        {ai && (
          <label className="form-field small-number-field">
            <span>Retry override</span>
            <input
              type="number"
              min={0}
              max={5}
              value={stage.retryPolicy?.maxRetries ?? ''}
              placeholder="Workflow default"
              onChange={(event) =>
                onChange({
                  retryPolicy: {
                    ...stage.retryPolicy,
                    maxRetries: event.target.value
                      ? Math.min(5, Math.max(0, Number(event.target.value)))
                      : undefined,
                  },
                })
              }
            />
          </label>
        )}
        {ai && (
          <>
            <label className="form-field">
              <span>Context strategy</span>
              <select
                value={policy?.strategy ?? workflowContextPolicy.strategy}
                onChange={(event) =>
                  setPolicy({
                    strategy: event.target.value as WorkflowDefinition['contextPolicy']['strategy'],
                  })
                }
              >
                <option value="focused">AUTO / Focused</option>
                <option value="changed-files">Changed Files</option>
                <option value="artifacts-only">Artifacts Only</option>
                <option value="full-project">Full Project / Broad</option>
              </select>
            </label>
            <label className="form-field small-number-field">
              <span>Estimated token limit</span>
              <input
                type="number"
                min={1000}
                max={500000}
                value={policy?.maxEstimatedTokens ?? workflowContextPolicy.maxEstimatedTokens}
                onChange={(event) =>
                  setPolicy({
                    maxEstimatedTokens: Math.min(500000, Math.max(1000, Number(event.target.value))),
                  })
                }
              />
            </label>
            <label className="form-field small-number-field">
              <span>Maximum files</span>
              <input
                type="number"
                min={1}
                max={500}
                value={policy?.maxFiles ?? workflowContextPolicy.maxFiles}
                onChange={(event) =>
                  setPolicy({ maxFiles: Math.min(500, Math.max(1, Number(event.target.value))) })
                }
              />
            </label>
            <label className="form-field small-number-field">
              <span>Maximum file size (bytes)</span>
              <input
                type="number"
                min={1024}
                max={2000000}
                value={policy?.maxFileBytes ?? workflowContextPolicy.maxFileBytes}
                onChange={(event) =>
                  setPolicy({ maxFileBytes: Math.min(2000000, Math.max(1024, Number(event.target.value))) })
                }
              />
            </label>
            <label className="form-field">
              <span>Include globs (one per line)</span>
              <textarea
                rows={2}
                value={(policy?.includeGlobs ?? workflowContextPolicy.includeGlobs).join('\n')}
                onChange={(event) => setPolicy({ includeGlobs: globs(event.target.value) })}
                placeholder="src/**/*.ts"
              />
            </label>
            <label className="form-field">
              <span>Exclude globs (one per line)</span>
              <textarea
                rows={2}
                value={(policy?.excludeGlobs ?? workflowContextPolicy.excludeGlobs).join('\n')}
                onChange={(event) => setPolicy({ excludeGlobs: globs(event.target.value) })}
                placeholder="node_modules/**"
              />
            </label>
            <div className="context-inclusion-flags stage-wide">
              {(
                [
                  ['includeCurrentDiff', 'Include current diff'],
                  ['includeTestOutput', 'Include structured test summary'],
                  ['includeBuildOutput', 'Include structured build summary'],
                  ['includePreviousArtifact', 'Include previous stage artifact'],
                ] as const
              ).map(([key, label]) => (
                <label className="rule-flag" key={key}>
                  <input
                    type="checkbox"
                    checked={
                      policy?.[key] ??
                      (key === 'includeCurrentDiff'
                        ? ['reviewer', 'parallelReview', 'finalGate', 'consolidate'].includes(stage.kind) &&
                          workflowContextPolicy[key]
                        : workflowContextPolicy[key])
                    }
                    onChange={(event) => setPolicy({ [key]: event.target.checked })}
                  />
                  {label}
                </label>
              ))}
              <label className="rule-flag">
                <input
                  type="checkbox"
                  checked={
                    policy?.includePreviousTranscript ?? workflowContextPolicy.includePreviousTranscript
                  }
                  onChange={(event) => setPolicy({ includePreviousTranscript: event.target.checked })}
                />
                Include prior AI stage responses (larger context)
              </label>
              <label className="form-field">
                <span>Over budget</span>
                <select
                  value={policy?.onLimitExceeded ?? workflowContextPolicy.onLimitExceeded}
                  onChange={(event) =>
                    setPolicy({ onLimitExceeded: event.target.value as 'compact' | 'ask' | 'stop' })
                  }
                >
                  <option value="compact">Compact optional context</option>
                  <option value="ask">Require user review</option>
                  <option value="stop">Stop stage</option>
                </select>
              </label>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
