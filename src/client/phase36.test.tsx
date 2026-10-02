// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunPreview, WorkflowDefinition } from '../shared/types';
import { DEFAULT_WORKFLOWS } from '../shared/workflows';
import { api } from './api';
import { formatMetric, RoutingSummaryPanel, decisionAssignmentLine } from './phase36';

afterEach(cleanup);

describe('workflow export security', () => {
  it('keeps model, decision, threshold, and budget configuration but no credentials or local profile IDs', () => {
    const workflow: WorkflowDefinition = {
      ...DEFAULT_WORKFLOWS[0]!,
      createdAt: '',
      updatedAt: '',
      billingMode: 'subscriptions-plus-decision-budget',
      meteredBudget: { perRunUsd: 0.05, unknownCostPolicy: 'block' },
      stages: [
        { id: 'plan', label: 'Plan', kind: 'planner', backendId: 'opencode', providerId: 'opencode-go', billingLane: 'opencode-go-subscription', connectionProfileId: 'local-profile-1', modelId: 'opencode-go/kimi-k3', variantId: 'high', customInstructions: 'Use token=abcdef1234567890 never' },
        {
          id: 'gate',
          label: 'Gate',
          kind: 'decisionGate',
          decision: {
            engine: 'jev-openrouter',
            modelId: 'typesafe/jev-1.13',
            connectionProfileId: 'local-openrouter-profile',
            questionType: 'boolean',
            question: 'Done?',
            inputs: ['task'],
            routing: { field: 'probability', passAtOrAbove: 0.95, failAtOrBelow: 0.15, onPass: { action: 'continue' }, onFail: { action: 'fail-run' }, onUncertain: { action: 'human-approval' } },
          },
        },
      ],
    };
    const exported = api.exportWorkflows([workflow]);
    const text = JSON.stringify(exported);
    expect(text).not.toContain('local-profile-1');
    expect(text).not.toContain('local-openrouter-profile');
    expect(text).not.toContain('abcdef1234567890');
    const [stagePlan, stageGate] = exported.workflows[0]!.stages as Array<Record<string, unknown> & { decision?: Record<string, unknown> }>;
    expect(stagePlan).toMatchObject({ modelId: 'opencode-go/kimi-k3', variantId: 'high', connectionReference: 'opencode:opencode-go:opencode-go-subscription' });
    expect(stageGate!.decision).toMatchObject({ modelId: 'typesafe/jev-1.13', connectionReference: 'openrouter:openrouter:openrouter-metered', routing: { passAtOrAbove: 0.95, failAtOrBelow: 0.15 } });
    expect(exported.workflows[0]).toMatchObject({ billingMode: 'subscriptions-plus-decision-budget', meteredBudget: { perRunUsd: 0.05 } });
  });
});

describe('mobile-safe run preview', () => {
  it('shows subscriptions consumed, metered decision stages, caps, PAYG status, and unknown provider-side fallback', () => {
    const preview = {
      billingMode: 'subscriptions-plus-decision-budget',
      routingSummary: {
        subscriptions: [
          { billingLane: 'opencode-go-subscription', label: 'OpenCode Go subscription', stages: ['Plan', 'Implement', 'Review'] },
          { billingLane: 'claude-subscription', label: 'Claude subscription', stages: [] },
        ],
        metered: [{ billingLane: 'openrouter-metered', label: 'OpenRouter metered', generativeStages: [], decisionStages: ['Gate'] }],
        meteredNone: false,
        runMeteredCapUsd: 0.05,
        dailyBudgetUsd: 1,
        monthlyBudgetUsd: null,
        unknownCostPolicy: 'block',
        paygFallback: 'none',
        externalDecisionDataPolicy: 'ask-first',
      },
      providerFallbackStatus: [{ backendId: 'opencode', billingLane: 'opencode-go-subscription', status: 'unknown', message: 'Provider-side PAYG fallback status cannot be verified by Turing Terminal.' }],
    } as unknown as RunPreview;
    render(<RoutingSummaryPanel preview={preview} />);
    expect(screen.getByText('Billing routing · Subscriptions + Decision Budget')).toBeTruthy();
    expect(screen.getByText('3 stages · Plan, Implement, Review')).toBeTruthy();
    expect(screen.getByText('1 Decision stage (Gate)')).toBeTruthy();
    expect(screen.getByText('$0.05 · daily $1.00')).toBeTruthy();
    expect(screen.getByText('NONE')).toBeTruthy();
    expect(screen.getByText(/UNKNOWN — Provider-side PAYG fallback status cannot be verified/)).toBeTruthy();
    expect(
      decisionAssignmentLine({
        decision: { engine: 'jev-openrouter', questionType: 'boolean', question: 'Done?', routingField: 'probability', inputs: ['task', 'tests'], external: true, externalDataPolicy: 'ask-first', configHash: 'abcdef0123456789', escalation: null },
      } as RunPreview['providerAssignments'][number]),
    ).toBe('Jev via OpenRouter Decisions · boolean · routes on probability · inputs Task specification, Test result · config abcdef0123');
  });

  it('renders unavailable metrics as Unavailable, never as zero', () => {
    expect(formatMetric({ value: null, reported: 0, missing: 3 })).toBe('Unavailable');
    expect(formatMetric({ value: 0, reported: 2, missing: 0 })).toBe('0');
    expect(formatMetric({ value: 0.00421, reported: 1, missing: 0 }, 'usd')).toBe('$0.0042');
  });
});
