import { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Shield } from 'lucide-react';
import type { RunPreview } from '../../../shared/types';
import { billingLaneLabel, billingModeLabel } from '../../../shared/billing';
import { classifyModelIdentity } from '../../../shared/modelSettings';
import { RoutingSummaryPanel, decisionAssignmentLine } from '../../phase36';
import { RuleListDetails } from '../shared/RuleListDetails';
import { capitalize } from '../shared/runStatus';

export function RunPreviewPanel({ preview }: { preview: RunPreview }) {
  const plan = preview.workflow.stages.filter((stage) => stage.enabled !== false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // This panel mounts only when a preview appears, so focus moves to its heading on appearance. Home's first render
  // never mounts it, so focus is not taken there.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <section className="run-preview-panel surface-panel" aria-label="Run preview">
      <div className="preview-heading">
        <div>
          <span className="preview-label">
            <CheckCircle2 size={15} /> RUN PREVIEW
          </span>
          <h2 ref={headingRef} tabIndex={-1}>
            {preview.canStart ? 'Ready to hand off' : 'Setup needed before this can start'}
          </h2>
        </div>
        <span className={`status-pill ${preview.canStart ? 'status-ready' : 'status-waiting_for_user'}`}>
          {preview.canStart ? 'Ready to start' : 'Needs setup'}
        </span>
      </div>
      <div className="preview-summary">
        <div>
          <span>Task</span>
          <strong>{preview.task}</strong>
        </div>
        <div>
          <span>Machine</span>
          <strong>{preview.machine.name}</strong>
        </div>
        <div>
          <span>Project</span>
          <strong>{preview.project.name}</strong>
          <small>{preview.project.path}</small>
        </div>
        <div>
          <span>Workflow</span>
          <strong>{preview.workflow.name}</strong>
          <small>
            {capitalize(preview.profile)} depth · {capitalize(preview.permissionMode)} permissions
          </small>
        </div>
        <div>
          <span>Git strategy</span>
          <strong>
            {preview.branchStrategy === 'worktree' ? 'Create isolated worktree' : 'Use project working tree'}
          </strong>
          <small>
            {preview.project.branch ?? 'No current branch detected'}
            {preview.project.dirty ? ' · uncommitted changes' : ''}
          </small>
        </div>
        <div>
          <span>Prompt refinement</span>
          <strong>{preview.refinePrompt ? 'On · confirmation required' : 'Off'}</strong>
          <small>
            {preview.refinePrompt
              ? 'The workflow pauses until you accept the refined task.'
              : 'The configured workflow starts directly.'}
          </small>
        </div>
      </div>
      <div className="stage-plan">
        <div className="stage-plan-head">
          <span>STAGE SEQUENCE</span>
          <span>{preview.expectedAiStages} configured AI stages</span>
        </div>
        <div className="stage-chips">
          {plan.map((stage, index) => (
            <span className="stage-chip" key={stage.id}>
              <i>{index + 1}</i>
              <span>
                {stage.label}
                <small>
                  {stage.timeoutMinutes ? `${stage.timeoutMinutes} min timeout` : 'run limit'} ·{' '}
                  {stage.retryPolicy?.maxRetries ?? preview.workflow.retryPolicy.maxRetries} retries
                </small>
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="preview-bounds">
        <span>
          <strong>Billing mode</strong>{' '}
          {billingModeLabel(
            preview.billingMode ?? (preview.subscriptionOnly ? 'subscriptions-only' : 'custom'),
          )}
        </span>
        <span>
          <strong>Provider lock</strong> {preview.lockProviders ? 'On · exact configured routes' : 'Off'}
        </span>
        <span>
          <strong>Run limit</strong> {preview.workflow.maxDurationMinutes} minutes
        </span>
        <span>
          <strong>Transient retries</strong> up to {preview.workflow.retryPolicy.maxRetries} · starts at{' '}
          {preview.workflow.retryPolicy.initialDelayMs} ms, capped at{' '}
          {preview.workflow.retryPolicy.maxDelayMs} ms
        </span>
        <span>
          <strong>Remediation</strong> up to {preview.workflow.maxRemediationRounds} rounds
        </span>
        <span>
          <strong>Parallelism</strong> up to {preview.workflow.maxParallelAgents} agents
        </span>
        <span>
          <strong>Approval gates</strong>{' '}
          {
            plan.filter((stage) =>
              ['humanApproval', 'gitPush', 'gitMerge', 'gitRollback'].includes(stage.kind),
            ).length
          }
        </span>
        <span>
          <strong>Target</strong> {preview.machine.name} · {preview.project.name} ·{' '}
          {preview.branchStrategy === 'worktree' ? 'isolated worktree' : 'project working tree'}
        </span>
      </div>
      <RoutingSummaryPanel preview={preview} />
      <RuleListDetails rules={preview.effectiveRules} title="Effective run rules" />
      {preview.providerAssignments.length > 0 && (
        <div className="assignment-summary">
          {preview.providerAssignments.map((item) => (
            <div key={`${item.stage}-${item.backendId}`}>
              <span className={item.ready ? 'assignment-dot-ready' : 'assignment-dot-error'} />
              {item.stage}
              <strong>
                {item.decision
                  ? `Decision Gate · ${item.modelId ?? 'Deterministic Rules'}${item.connectionProfileName ? ` · ${item.connectionProfileName}` : ''}`
                  : item.ready
                    ? `${item.backendId} · ${item.providerId}/${item.modelId}${item.variantId ? ` · variant ${item.variantId}` : ''}${item.connectionProfileName ? ` · ${item.connectionProfileName}` : ''}`
                    : 'Needs provider/model setup'}
              </strong>
              {item.decision && (
                <small className="assignment-native-config">{decisionAssignmentLine(item)}</small>
              )}
              {item.billingAllowed === false && (
                <small className="assignment-native-config">BLOCKED · {item.billingReason}</small>
              )}
              {item.ready && (
                <small className="assignment-native-config">
                  {item.workload === 'deterministic'
                    ? 'decision-gate · local deterministic rules · no provider, no billing lane'
                    : `${item.role ? `${item.role} · ` : ''}${billingLaneLabel(item.billingLane ?? 'unknown')}${item.catalogStatus ? ` · ${item.catalogStatus.toUpperCase().replace('-', ' ')}` : ''} · ${(item.identity ?? classifyModelIdentity(item.backendId ?? undefined, item.modelId ?? undefined)) === 'floating' ? 'FLOATING / ROUTED' : 'PINNED'}`}
                  {item.reasoning ? ` · provider reasoning ${item.reasoning}` : ''}
                  {item.nativeSettings && Object.keys(item.nativeSettings).length
                    ? ` · ${Object.entries(item.nativeSettings)
                        .map(([key, value]) => `${key}=${value}`)
                        .join(', ')}`
                    : ''}
                </small>
              )}
              <small>
                {item.context.label} · ESTIMATED initial input ~
                {item.context.estimatedInputTokens.toLocaleString()} tokens · configured limit{' '}
                {item.context.maxEstimatedTokens.toLocaleString()}
              </small>
            </div>
          ))}
        </div>
      )}
      {preview.warnings.length > 0 && (
        <ul className="preview-warnings">
          {preview.warnings.map((warning) => (
            <li key={warning}>
              <AlertTriangle size={14} />
              {warning}
            </li>
          ))}
        </ul>
      )}
      <p className="preview-footnote">
        <Shield size={14} /> Credentials remain in desktop-side storage and are never sent to this device.
        Turing never falls back to API, PAYG, or OpenRouter billing on its own; provider-side PAYG fallback is
        shown as unknown because no supported check can verify it. Token figures are ESTIMATED.
      </p>
    </section>
  );
}
