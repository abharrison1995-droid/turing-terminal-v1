// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalOpportunityAdmissionTarget } from '../../../shared/goalApi';
import type { ModelOpportunityObservation } from '../../../shared/types';
import type { RouteMember } from '../../../shared/goals';

const mocks = vi.hoisted(() => ({
  modelOpportunities: vi.fn(),
  opportunityAdmissionTargets: vi.fn(),
  refreshProviders: vi.fn(),
  startRouteValidation: vi.fn(),
  requestOpportunityAdmission: vi.fn(),
}));

vi.mock('../../api', () => ({ api: mocks }));

import { ModelOpportunityBoard } from './ModelOpportunityBoard';

const savedObservation: ModelOpportunityObservation = {
  id: 'observation-1',
  refreshId: 'refresh-1',
  backendId: 'openrouter',
  providerId: 'openrouter',
  modelId: 'provider/model-x',
  claimKind: 'provider-advertised',
  sourceClass: 'live',
  refreshOutcome: 'success',
  observedAt: '2026-10-24T12:00:00.000Z',
  checkedAt: '2026-10-24T12:00:00.000Z',
  payloadDigest: 'a'.repeat(64),
  displayName: 'Model X',
  adapterVersion: null,
  costClass: 'free',
  valid: true,
};

const routeMember: RouteMember = {
  configuration: {
    backendId: 'openrouter',
    providerId: 'openrouter',
    billingLane: 'openrouter-metered',
    modelId: 'provider/model-x',
    modelDisplayName: 'Model X',
  },
  identityKind: 'pinned',
  freshnessClass: 'opportunity',
};

function admissionTarget(
  overrides: Partial<GoalOpportunityAdmissionTarget> = {},
): GoalOpportunityAdmissionTarget {
  return {
    goalId: '00000000-0000-4000-8000-000000000001',
    goalTitle: 'Goal X',
    definitionVersion: 3,
    definitionHash: 'b'.repeat(64),
    poolId: 'pool-x',
    poolLabel: 'Main pool',
    memberIndex: 0,
    modelId: 'provider/model-x',
    backendId: 'openrouter',
    providerId: 'openrouter',
    billingLane: 'metered',
    costClass: 'free',
    displayName: 'Model X',
    observationIds: ['observation-1'],
    roles: ['implementer'],
    member: routeMember,
    evidencePath: 'locally-discovered',
    eligibility: 'validation_required',
    admissionStatus: 'none',
    ...overrides,
  };
}

const observationsResponse = {
  observations: [savedObservation],
  retentionDays: 90,
  refreshRequired: true,
};

function setup() {
  const onNotice = vi.fn();
  const onChanged = vi.fn();
  render(<ModelOpportunityBoard onNotice={onNotice} onChanged={onChanged} />);
  return { onNotice, onChanged };
}

beforeEach(() => {
  mocks.modelOpportunities.mockResolvedValue(observationsResponse);
  mocks.opportunityAdmissionTargets.mockResolvedValue({ targets: [admissionTarget()] });
  mocks.refreshProviders.mockResolvedValue({ providers: [] });
  mocks.startRouteValidation.mockResolvedValue({
    probeId: 'probe-1',
    runId: 'run-1',
    identityHash: 'c'.repeat(64),
    profiles: ['openrouter'],
  });
  mocks.requestOpportunityAdmission.mockResolvedValue({
    approvalId: 'approval-1',
    status: 'pending',
    definitionVersion: 3,
    verifiedPath: 'pool.x',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Model Opportunity Board', () => {
  it('loads saved observations without refreshing providers and exposes the narrow table to keyboard users', async () => {
    const { onNotice } = setup();

    expect(await screen.findByRole('table', { name: 'Model observations' })).toBeTruthy();
    expect(screen.getByRole('table').textContent).toContain('Model X');
    expect(
      screen.getByRole('region', { name: 'Scrollable model observations' }).getAttribute('tabindex'),
    ).toBe('0');
    expect(mocks.refreshProviders).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('does not announce a successful refresh when the saved-observations board cannot reload', async () => {
    mocks.modelOpportunities
      .mockResolvedValueOnce(observationsResponse)
      .mockRejectedValueOnce(new Error('Observation read failed.'));
    const { onNotice, onChanged } = setup();

    await screen.findByRole('table', { name: 'Model observations' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh observations' }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        'Provider discovery finished, but saved observations could not be reloaded.',
      ),
    );
    expect(screen.getByRole('alert').textContent).toBe('Observation read failed.');
    expect(onNotice).not.toHaveBeenCalledWith(
      'Provider discovery finished and its observations were recorded.',
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('requests admission for the exact Goal definition, pool and member', async () => {
    const target = admissionTarget({ eligibility: 'ready', evidencePath: 'provider-advertised' });
    mocks.opportunityAdmissionTargets.mockResolvedValue({ targets: [target] });
    const { onNotice, onChanged } = setup();

    await screen.findByRole('button', { name: 'Request admission' });
    fireEvent.click(screen.getByRole('button', { name: 'Request admission' }));

    await waitFor(() =>
      expect(mocks.requestOpportunityAdmission).toHaveBeenCalledWith(
        target.goalId,
        target.definitionVersion,
        {
          poolId: target.poolId,
          memberIndex: target.memberIndex,
        },
      ),
    );
    expect(onNotice).toHaveBeenCalledWith(
      'Admission requested. Approve the exact pool-member request in Goal approvals.',
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('reports when an admission request succeeds but the updated board cannot reload', async () => {
    const target = admissionTarget({ eligibility: 'ready', evidencePath: 'provider-advertised' });
    mocks.opportunityAdmissionTargets.mockResolvedValue({ targets: [target] });
    mocks.modelOpportunities
      .mockResolvedValueOnce(observationsResponse)
      .mockRejectedValueOnce(new Error('Observation read failed.'));
    const { onNotice, onChanged } = setup();

    fireEvent.click(await screen.findByRole('button', { name: 'Request admission' }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        'Admission request was created, but the board could not reload. Approve it in Goal approvals.',
      ),
    );
    expect(screen.getByRole('alert').textContent).toBe('Observation read failed.');
    expect(onNotice).not.toHaveBeenCalledWith(
      'Admission requested. Approve the exact pool-member request in Goal approvals.',
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
