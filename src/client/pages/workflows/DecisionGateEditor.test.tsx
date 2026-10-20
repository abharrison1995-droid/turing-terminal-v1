// @vitest-environment jsdom

// Optional JEV decision gate: prerequisites together, explicit fix actions that never enable anything on their own,
// plain-language routing with UNCERTAIN kept explicit, and a local check that is separate from the external test that
// may spend money. The api module is mocked: no request is sent to OpenRouter.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelOption, WorkflowDefinition } from '../../../shared/types';
import { WorkflowsPage } from '../WorkflowsPage';
import { resetWorkflowDraftStore } from './draftStore';
import { defaultJevConfig } from './stageFactory';
import { makeConnection, makeProvider, makeStage, makeWorkflow } from './testFixtures';

const mocks = vi.hoisted(() => ({
  connectionProfiles: vi.fn(),
  modelPresets: vi.fn(),
  saveWorkflow: vi.fn(),
  refreshProviders: vi.fn(),
  testDecisionGate: vi.fn(),
}));
vi.mock('../../api', async (importActual) => ({
  ...(await importActual<typeof import('../../api')>()),
  api: mocks,
}));

const jev: ModelOption = {
  id: 'typesafe/jev-1.13',
  name: 'Jev 1.13',
  providerId: 'openrouter',
  family: 'decision',
};
const openRouterConnection = makeConnection({
  id: 'conn-or',
  name: 'OpenRouter decisions',
  backendId: 'openrouter',
  providerId: 'openrouter',
  billingLane: 'openrouter-metered',
  credentials: { inference: true, management: false },
});

function renderPage(workflow: WorkflowDefinition = makeWorkflow(), withOpenRouter = false) {
  const props = {
    workflows: [workflow],
    providers: [
      makeProvider('opencode'),
      ...(withOpenRouter ? [makeProvider('openrouter', [jev], { catalogSource: 'live' })] : []),
    ],
    onSaved: vi.fn(),
    onNotice: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  render(<WorkflowsPage {...props} />);
  return props;
}

const addJev = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByRole('list', { name: 'Stages' });
  await user.click(screen.getByText('Add stage'));
  await user.click(screen.getByRole('button', { name: /JEV via OpenRouter/ }));
  return document.querySelector('.decision-gate-editor') as HTMLElement;
};
const prerequisite = (editor: HTMLElement, label: string) =>
  within(editor).getByText(label, { selector: 'strong' }).closest('li') as HTMLElement;

beforeEach(() => {
  resetWorkflowDraftStore();
  mocks.connectionProfiles.mockResolvedValue({ profiles: [openRouterConnection] });
  mocks.modelPresets.mockResolvedValue({ presets: [] });
  mocks.refreshProviders.mockResolvedValue({ providers: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('JEV is optional', () => {
  it('is absent from a default workflow and is only added by choosing it', async () => {
    const user = userEvent.setup();
    renderPage();
    const list = await screen.findByRole('list', { name: 'Stages' });
    expect(list.querySelectorAll('[data-stage-id]')).toHaveLength(1);
    expect(list.querySelector('.decision-gate-editor')).toBeNull();

    await addJev(user);

    expect(list.querySelectorAll('[data-stage-id]')).toHaveLength(2);
  });

  it('is not added, enabled or authorised by connecting OpenRouter: the Settings link only navigates', async () => {
    const user = userEvent.setup();
    mocks.connectionProfiles.mockResolvedValue({ profiles: [] });
    const props = renderPage();
    const editor = await addJev(user);

    await user.click(within(editor).getByRole('button', { name: 'Set up OpenRouter in Settings' }));

    expect(props.onOpenSettings).toHaveBeenCalledWith({ target: 'openrouter', returnTo: 'workflows' });
    expect(mocks.saveWorkflow).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[data-stage-id]')).toHaveLength(2);
  });
});

describe('prerequisites', () => {
  it('lists all five together with a word for each state, not colour alone', async () => {
    const user = userEvent.setup();
    renderPage();
    const editor = await addJev(user);

    expect(within(editor).getByText('Before this gate can run')).toBeTruthy();
    const labels = [
      'OpenRouter connection',
      'Exact compatible model',
      'Decision spending cap',
      'Billing mode',
      'External-data permission',
    ];
    for (const label of labels) {
      const item = prerequisite(editor, label);
      expect(within(item).getByText(/^(Met|Missing|Needs attention|Unknown)$/)).toBeTruthy();
    }
    expect(within(prerequisite(editor, 'OpenRouter connection')).getByText('Missing')).toBeTruthy();
    expect(within(prerequisite(editor, 'Billing mode')).getByText('Missing')).toBeTruthy();
  });

  it('setting a cap does not change the billing mode, and the billing fix is a separate explicit action', async () => {
    const user = userEvent.setup();
    renderPage();
    const editor = await addJev(user);

    await user.type(within(editor).getByLabelText('Per-run cap in US dollars'), '0.25');
    await user.click(within(editor).getByRole('button', { name: 'Set cap' }));

    expect(screen.getByLabelText('Safety and billing summary').textContent).toMatch(/Cap \$0\.25 per run/);
    expect(screen.getByLabelText('Safety and billing summary').textContent).toMatch(/Subscriptions Only/);
    expect(within(prerequisite(editor, 'Billing mode')).getByText('Missing')).toBeTruthy();

    await user.click(within(editor).getByRole('button', { name: 'Use Subscriptions + Decision Budget' }));

    expect(screen.getByLabelText('Safety and billing summary').textContent).toMatch(/Decision Budget/);
    expect(within(prerequisite(editor, 'Billing mode')).getByText('Met')).toBeTruthy();
  });

  it('does not pretend a saved model is usable when no catalogue can confirm it, and keeps the exact ID', async () => {
    const user = userEvent.setup();
    renderPage();
    const editor = await addJev(user);

    const model = within(prerequisite(editor, 'Exact compatible model'));
    expect(model.getByText('Unknown')).toBeTruthy();
    expect((within(editor).getByLabelText(/Exact model/) as HTMLInputElement).value).toBe(
      'typesafe/jev-1.13',
    );
  });
});

describe('question, evidence and outcome', () => {
  it('keeps Yes/no, Choose an option and Score as separate question types', async () => {
    const user = userEvent.setup();
    renderPage();
    const editor = await addJev(user);

    const types = within(editor).getAllByRole('radio');
    expect(types.map((radio) => (radio.closest('label') as HTMLElement).textContent)).toEqual([
      expect.stringMatching(/Yes \/ no/),
      expect.stringMatching(/Choose an option/),
      expect.stringMatching(/Score/),
    ]);
    await user.click(within(editor).getByLabelText(/Score/));
    expect(within(editor).getByLabelText(/Score/)).toHaveProperty('checked', true);
  });

  it('names exactly what is sent externally and updates when a category is toggled', async () => {
    const user = userEvent.setup();
    renderPage();
    const editor = await addJev(user);

    const summary = () => within(editor).getByText(/Sent externally/).textContent ?? '';
    const before = summary();
    await user.click(within(editor).getByLabelText('Task specification'));

    expect(summary()).not.toBe(before);
  });

  it('shows a plain-language routing summary with UNCERTAIN explicit, and keeps probability and confidence distinct', async () => {
    const user = userEvent.setup();
    renderPage();
    const editor = await addJev(user);

    const routing = within(editor).getByLabelText('Routing summary');
    expect(within(routing).getByText('UNCERTAIN')).toBeTruthy();
    expect(within(routing).getByText('PASS')).toBeTruthy();
    expect(within(routing).getByText('FAIL')).toBeTruthy();
    expect(routing.textContent).toMatch(/Probability/);

    await user.selectOptions(within(editor).getByLabelText(/Routing reads/), 'confidence');
    expect(within(editor).getByLabelText('Routing summary').textContent).toMatch(/Confidence/);
    expect(within(editor).getByLabelText('Routing summary').textContent).not.toMatch(/Probability is/);
  });

  it('lets UNCERTAIN ask a person or escalate, and never offers a silent pass for it by default', async () => {
    const user = userEvent.setup();
    renderPage();
    const editor = await addJev(user);

    const uncertain = within(editor).getByLabelText('On UNCERTAIN') as HTMLSelectElement;
    expect(uncertain.selectedOptions[0]!.textContent).toMatch(/Ask a person/);
    expect([...uncertain.options].map((option) => option.textContent)).toContain('Escalate to second engine');
    await user.selectOptions(uncertain, 'escalate');
    expect(within(editor).getByLabelText('Routing summary').textContent).toMatch(/second engine|escalat/i);
  });
});

describe('checks', () => {
  it('Check configuration is local: it never calls the external test endpoint', async () => {
    const user = userEvent.setup();
    renderPage();
    const editor = await addJev(user);

    await user.click(within(editor).getByRole('button', { name: 'Check configuration' }));

    expect(mocks.testDecisionGate).not.toHaveBeenCalled();
    expect(
      within(editor).getByText(/Not available yet|configuration/i, { selector: '[role="status"]' }),
    ).toBeTruthy();
  });

  it('keeps the external test disabled while prerequisites are unmet', async () => {
    const user = userEvent.setup();
    renderPage();
    const editor = await addJev(user);

    await user.click(within(editor).getByText(/External test · may spend money/));
    await user.type(within(editor).getByLabelText(/Sample evidence/), 'The change adds a button.');
    await user.type(within(editor).getByLabelText(/Spending cap for this test/), '0.05');
    await user.click(within(editor).getByLabelText(/I confirm this test sends the sample/));

    expect(within(editor).getByRole('button', { name: 'Run external test' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(editor).getByText(/Not available yet/)).toBeTruthy();
    expect(mocks.testDecisionGate).not.toHaveBeenCalled();
  });

  it('runs the external test only after sample, cap and confirmation, and shows the distinct fields it returns', async () => {
    const user = userEvent.setup();
    mocks.testDecisionGate.mockResolvedValue({
      results: [{ outcome: 'uncertain', probability: 0.5, confidence: 0.2, score: null }],
      actualCostUsd: 0.0012,
      costProvenance: 'provider-reported',
    });
    renderPage(
      makeWorkflow({
        billingMode: 'subscriptions-plus-decision-budget',
        meteredBudget: { perRunUsd: 0.25, unknownCostPolicy: 'block' },
      }),
      true,
    );
    const editor = await addJev(user);
    await user.selectOptions(within(editor).getByLabelText('OpenRouter connection'), 'conn-or');

    await user.click(within(editor).getByText(/External test · may spend money/));
    const run = () => within(editor).getByRole('button', { name: 'Run external test' }) as HTMLButtonElement;
    expect(run().disabled).toBe(true);
    await user.type(within(editor).getByLabelText(/Sample evidence/), 'The change adds a button.');
    await user.type(within(editor).getByLabelText(/Spending cap for this test/), '0.05');
    expect(run().disabled).toBe(true);
    await user.click(within(editor).getByLabelText(/I confirm this test sends the sample/));
    expect(run().disabled).toBe(false);

    await user.click(run());

    await waitFor(() => expect(mocks.testDecisionGate).toHaveBeenCalledTimes(1));
    expect(mocks.testDecisionGate.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ confirmExternal: true, maxCostUsd: 0.05 }),
    );
    const result = await within(editor).findByLabelText('External test result');
    expect(within(result).getByText('UNCERTAIN')).toBeTruthy();
    expect(within(result).getByText('Probability').nextElementSibling!.textContent).toBe('0.5');
    expect(within(result).getByText('Confidence').nextElementSibling!.textContent).toBe('0.2');
    expect(within(result).getByText('Score').nextElementSibling!.textContent).toBe('not reported');
  });
});

describe('saved versions', () => {
  it('keeps a saved exact model version instead of moving it to a latest alias', async () => {
    const user = userEvent.setup();
    const saved = makeWorkflow({
      stages: [
        makeStage({ id: 'plan', label: 'Plan', kind: 'planner', role: 'planner' }),
        makeStage({
          id: 'gate',
          label: 'Gate',
          kind: 'decisionGate',
          role: 'decisionGate',
          decision: { ...defaultJevConfig(), modelId: 'typesafe/jev-1.12', connectionProfileId: 'conn-or' },
        } as never),
      ],
    });
    renderPage(saved, true);
    await screen.findByRole('list', { name: 'Stages' });

    await user.click(
      within(screen.getByRole('list', { name: 'Stages' })).getByRole('button', { name: /^Gate/ }),
    );

    const editor = document.querySelector('.decision-gate-editor') as HTMLElement;
    const model = within(editor).getByLabelText(/Exact model/) as HTMLInputElement | HTMLSelectElement;
    expect(model.value).toBe('typesafe/jev-1.12');
  });
});
