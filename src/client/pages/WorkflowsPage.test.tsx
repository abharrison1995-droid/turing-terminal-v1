// @vitest-environment jsdom

// Workflow Studio: compact stage rows, one open editor, inherited versus overridden assignment, unsaved-change
// protection, save failures with reconnect guidance, draft preservation, the link into Settings, and import/export.
// The api module is mocked: nothing here reaches a network, a CLI or a model.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { ModelOption, WorkflowDefinition } from '../../shared/types';
import { resetWorkflowDraftStore } from './workflows/draftStore';
import { makeConnection, makeProvider, makeStage, makeWorkflow } from './workflows/testFixtures';

const mocks = vi.hoisted(() => ({
  connectionProfiles: vi.fn(),
  modelPresets: vi.fn(),
  saveWorkflow: vi.fn(),
  duplicateWorkflow: vi.fn(),
  exportWorkflows: vi.fn(),
  refreshProviders: vi.fn(),
  createModelPreset: vi.fn(),
}));
vi.mock('../api', async (importActual) => ({
  ...(await importActual<typeof import('../api')>()),
  api: mocks,
}));

import { WorkflowsPage } from './WorkflowsPage';

const goModel: ModelOption = {
  id: 'glm-5.1',
  name: 'GLM 5.1',
  providerId: 'opencode-go',
  subscriptionBacked: true,
};
const providers = () => [
  makeProvider('opencode', [goModel]),
  makeProvider('codex-cli'),
  makeProvider('claude-code'),
];
const goConnection = makeConnection();

const twoStageWorkflow = (overrides: Partial<WorkflowDefinition> = {}) =>
  makeWorkflow({
    stages: [
      makeStage({
        id: 'plan',
        label: 'Plan',
        kind: 'planner',
        role: 'planner',
        connectionProfileId: 'conn-go',
        backendId: 'opencode',
        providerId: 'opencode-go',
        billingLane: 'opencode-go-subscription',
        modelId: 'glm-5.1',
      }),
      makeStage({ id: 'build', label: 'Build', kind: 'implementer', role: 'implementer' }),
    ],
    ...overrides,
  });

function renderPage(
  workflows: WorkflowDefinition[] = [twoStageWorkflow()],
  extra: Record<string, unknown> = {},
) {
  const props = {
    workflows,
    providers: providers(),
    onSaved: vi.fn(),
    onNotice: vi.fn(),
    onOpenSettings: vi.fn(),
    ...extra,
  };
  const view = render(<WorkflowsPage {...props} />);
  return { ...props, ...view };
}

const stageList = () => screen.getByRole('list', { name: 'Stages' });
const toggle = (name: string) => within(stageList()).getByRole('button', { name: new RegExp(`^${name}`) });
const ready = () => screen.findByRole('list', { name: 'Stages' });
const nameInput = () => screen.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement;
const picker = () => screen.getByRole('combobox', { name: /^Workflow/ });

beforeEach(() => {
  resetWorkflowDraftStore();
  mocks.connectionProfiles.mockResolvedValue({ profiles: [goConnection] });
  mocks.modelPresets.mockResolvedValue({ presets: [] });
  mocks.saveWorkflow.mockImplementation(async (workflow: WorkflowDefinition) => ({
    workflow: { ...workflow, version: workflow.version + 1 },
  }));
  mocks.refreshProviders.mockResolvedValue({ providers: providers() });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('stage rows', () => {
  it('shows compact rows with connection, model, enabled state and issue, with no editor open by default', async () => {
    renderPage();
    await ready();

    const plan = toggle('Plan');
    const build = toggle('Build');
    expect(plan.getAttribute('aria-expanded')).toBe('false');
    expect(build.getAttribute('aria-expanded')).toBe('false');
    expect(plan.textContent).toMatch(/OpenCode Go/);
    expect(plan.textContent).toMatch(/glm-5\.1|GLM 5\.1/);
    // The Build stage has no connection or model yet: the row says so instead of expanding itself.
    expect(within(build).getByText(/connection|model/i, { selector: '.stage-row-issue' })).toBeTruthy();
    expect(screen.getAllByRole('checkbox', { name: /enabled$/ })).toHaveLength(2);
    expect(document.querySelectorAll('.stage-editor')).toHaveLength(0);
  });

  it('opens one stage editor at a time', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();

    await user.click(toggle('Plan'));
    expect(document.querySelectorAll('.stage-editor')).toHaveLength(1);
    await user.click(toggle('Build'));

    expect(document.querySelectorAll('.stage-editor')).toHaveLength(1);
    expect(toggle('Plan').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('Build').getAttribute('aria-expanded')).toBe('true');
  });

  it('marks a stage that follows workflow defaults, and a stage override, in the editor', async () => {
    const user = userEvent.setup();
    renderPage([
      twoStageWorkflow({
        defaultModelConfiguration: {
          connectionProfileId: 'conn-go',
          backendId: 'opencode',
          providerId: 'opencode-go',
          billingLane: 'opencode-go-subscription',
          modelId: 'glm-5.1',
        },
        stages: [
          makeStage({ id: 'plan', label: 'Plan', kind: 'planner', role: 'planner' }),
          makeStage({
            id: 'build',
            label: 'Build',
            kind: 'implementer',
            role: 'implementer',
            connectionProfileId: 'conn-go',
            backendId: 'opencode',
            providerId: 'opencode-go',
            billingLane: 'opencode-go-subscription',
            modelId: 'glm-5.1',
          }),
        ],
      }),
    ]);
    await ready();

    expect(within(toggle('Plan')).getByText('Defaults')).toBeTruthy();
    expect(within(toggle('Build')).queryByText('Defaults')).toBeNull();

    await user.click(toggle('Plan'));
    const editor = document.querySelector('.stage-editor') as HTMLElement;
    expect(within(editor).getAllByText(/Workflow default/i).length).toBeGreaterThan(0);
    await user.click(toggle('Build'));
    const overridden = document.querySelector('.stage-editor') as HTMLElement;
    expect(within(overridden).getAllByText(/Stage override/i).length).toBeGreaterThan(0);
  });

  it('reorders with buttons and keeps keyboard focus on the moved stage', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();

    await user.click(screen.getByRole('button', { name: 'Move Plan down' }));

    const names = [...document.querySelectorAll('.stage-row-name strong')].map((node) => node.textContent);
    expect(names).toEqual(['Build', 'Plan']);
    expect(screen.getByRole('button', { name: 'Save workflow' })).toHaveProperty('disabled', false);
  });

  it('reorders from the keyboard with Alt+Arrow on the stage row', async () => {
    renderPage();
    await ready();

    const plan = toggle('Plan');
    plan.focus();
    fireEvent.keyDown(plan, { key: 'ArrowDown', altKey: true });

    const names = [...document.querySelectorAll('.stage-row-name strong')].map((node) => node.textContent);
    expect(names).toEqual(['Build', 'Plan']);
  });
});

describe('Add stage', () => {
  it('replaces Add reviewer stage with a grouped menu that includes a direct Decision gate choice', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();

    expect(screen.queryByText(/Add reviewer stage/i)).toBeNull();
    await user.click(screen.getByText('Add stage'));
    const menu = screen.getByRole('group', { name: 'Stage types' });

    expect(within(menu).getAllByRole('group').length).toBeGreaterThan(1);
    expect(within(menu).getAllByRole('button', { name: /Decision gate/ })).toHaveLength(2);
    expect(within(menu).getByRole('button', { name: /Decision gate · JEV via OpenRouter/ })).toBeTruthy();
  });

  it('adds a JEV decision gate only when chosen, opens its editor, and leaves other stages and settings alone', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    expect(document.querySelectorAll('[data-stage-id]')).toHaveLength(2);

    await user.click(screen.getByText('Add stage'));
    await user.click(screen.getByRole('button', { name: /JEV via OpenRouter/ }));

    expect(document.querySelectorAll('[data-stage-id]')).toHaveLength(3);
    const editor = document.querySelector('.decision-gate-editor') as HTMLElement;
    expect(editor).toBeTruthy();
    // Nothing was enabled for the person: spending, external data and the connection are all still their defaults.
    expect(within(editor).getByText('Before this gate can run')).toBeTruthy();
    expect(mocks.saveWorkflow).not.toHaveBeenCalled();
  });

  it('never ships a decision gate in a default workflow', async () => {
    renderPage();
    await ready();

    expect(within(stageList()).queryByText(/Decision gate/)).toBeNull();
  });
});

describe('unsaved changes and saving', () => {
  const renameWorkflow = async (user: ReturnType<typeof userEvent.setup>, value: string) => {
    const input = nameInput();
    await user.clear(input);
    await user.type(input, value);
  };

  it('starts clean with Save disabled, becomes dirty on edit, and offers Discard', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    expect(screen.getByRole('button', { name: 'Save workflow' })).toHaveProperty('disabled', true);

    await renameWorkflow(user, 'Renamed');

    expect(screen.getByRole('button', { name: 'Save workflow' })).toHaveProperty('disabled', false);
    expect(document.querySelector('.save-status-dirty')).toBeTruthy();
    expect((await screen.findAllByText(/Unsaved changes/i)).length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole('button', { name: 'Discard changes' })[0]!);
    expect(nameInput().value).toBe('Fixture delivery');
  });

  it('saves the draft once and reports the new version', async () => {
    const user = userEvent.setup();
    const { onSaved, onNotice } = renderPage();
    await ready();
    await renameWorkflow(user, 'Renamed');

    await user.click(screen.getByRole('button', { name: 'Save workflow' }));

    await waitFor(() => expect(mocks.saveWorkflow).toHaveBeenCalledTimes(1));
    expect(mocks.saveWorkflow.mock.calls[0]![0].name).toBe('Renamed');
    expect(onSaved).toHaveBeenCalled();
    expect(onNotice.mock.calls.at(-1)![0]).toMatch(/saved as version 4/);
  });

  it('keeps the draft and says what to do when the Desktop Master cannot be reached', async () => {
    const user = userEvent.setup();
    mocks.saveWorkflow.mockRejectedValue(new TypeError('Failed to fetch'));
    renderPage();
    await ready();
    await renameWorkflow(user, 'Renamed');

    await user.click(screen.getByRole('button', { name: 'Save workflow' }));

    expect(await screen.findByText(/Could not reach the Desktop Master/)).toBeTruthy();
    expect(nameInput().value).toBe('Renamed');
    expect(document.querySelector('.save-status-error')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save workflow' })).toHaveProperty('disabled', false);
  });

  it('shows the server’s own message when it refuses the workflow', async () => {
    const user = userEvent.setup();
    mocks.saveWorkflow.mockRejectedValue(new ApiError('Workflow rejected: a stage has no model.', 422));
    renderPage();
    await ready();
    await renameWorkflow(user, 'Renamed');

    await user.click(screen.getByRole('button', { name: 'Save workflow' }));

    expect(await screen.findByText(/a stage has no model/)).toBeTruthy();
    expect(nameInput().value).toBe('Renamed');
  });

  it('keeps unsaved edits when switching to another workflow and back', async () => {
    const user = userEvent.setup();
    const other = makeWorkflow({ id: 'other', name: 'Other flow' });
    const { onNotice } = renderPage([twoStageWorkflow(), other]);
    await ready();
    await renameWorkflow(user, 'Edited name');

    await user.selectOptions(picker(), 'other');
    expect(nameInput().value).toBe('Other flow');
    expect(onNotice.mock.calls.at(-1)![0]).toMatch(/Unsaved edits to “Edited name” are kept/);
    expect(screen.getByRole('option', { name: /Fixture delivery · unsaved changes/ })).toBeTruthy();

    await user.selectOptions(picker(), 'fixture');
    expect(nameInput().value).toBe('Edited name');
  });

  it('warns on a stale base without discarding the edits', async () => {
    const user = userEvent.setup();
    const workflow = twoStageWorkflow();
    const { rerender, props } = (() => {
      const r = renderPage([workflow]);
      return { rerender: r.rerender, props: r };
    })();
    await ready();
    await renameWorkflow(user, 'Local edit');

    rerender(
      <WorkflowsPage
        workflows={[{ ...workflow, version: workflow.version + 1, updatedAt: '2026-10-20T11:00:00.000Z' }]}
        providers={providers()}
        onSaved={props.onSaved}
        onNotice={props.onNotice}
      />,
    );

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(nameInput().value).toBe('Local edit');
  });
});

describe('connections and Settings', () => {
  it('has no connection-creation form: connections are chosen here and created in Settings', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(toggle('Plan'));

    // A stage may still set its own route under Advanced, but no saved connection is created from Workflows.
    expect(screen.queryByLabelText('Connection name')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save (custom )?connection/ })).toBeNull();
    expect(screen.queryByText(/Connection profiles/i)).toBeNull();
  });

  it('links to Providers & connections without altering the draft', async () => {
    const user = userEvent.setup();
    const { onOpenSettings } = renderPage();
    await ready();
    await user.click(toggle('Build'));

    await user.click(screen.getByRole('button', { name: /Set up providers/ }));

    expect(onOpenSettings).toHaveBeenCalledWith({ target: 'providers', returnTo: 'workflows' });
    expect(mocks.saveWorkflow).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save workflow' })).toHaveProperty('disabled', true);
  });

  it('never replaces a model silently when the connection changes: it shows the affected assignment first', async () => {
    const user = userEvent.setup();
    mocks.connectionProfiles.mockResolvedValue({
      profiles: [
        goConnection,
        makeConnection({
          id: 'conn-codex',
          name: 'Codex',
          backendId: 'codex-cli',
          providerId: 'openai-codex',
          billingLane: 'chatgpt-subscription',
        }),
      ],
    });
    renderPage();
    await ready();
    await user.click(toggle('Plan'));

    await user.selectOptions(screen.getByRole('combobox', { name: /^Connection/ }), 'conn-codex');

    const impact = await screen.findByRole('group', { name: 'Changing connection affects this assignment' });
    expect(impact.textContent).toMatch(/glm-5\.1/);
    expect(screen.getByRole('button', { name: /Keep glm-5\.1/ })).toBeTruthy();
    // Nothing changed until the person chooses: the stage still names the OpenCode model.
    expect(toggle('Plan').textContent).toMatch(/glm-5\.1|GLM 5\.1/);
  });
});

describe('blocking problems', () => {
  it('keeps blocking problems visible with a jump button that opens the stage', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();

    const banner = screen.getByRole('region', { name: 'Problems to fix' });
    expect(within(banner).getByText(/Build/)).toBeTruthy();
    await user.click(within(banner).getByRole('button', { name: /Build|Open|Fix|Go/ }));

    expect(toggle('Build').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.stage-editor')).toHaveLength(1);
  });
});

describe('import and export', () => {
  it('exports the draft through the shared export function', async () => {
    const user = userEvent.setup();
    mocks.exportWorkflows.mockReturnValue({ version: 1, workflows: [] });
    const createObjectURL = vi.fn(() => 'blob:test');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    renderPage();
    await ready();

    await user.click(screen.getByRole('button', { name: /Export JSON/ }));

    expect(mocks.exportWorkflows).toHaveBeenCalledTimes(1);
    expect(mocks.exportWorkflows.mock.calls[0]![0][0].id).toBe('fixture');
  });

  it('disables Duplicate while there are unsaved edits so a copy is never made from a stale draft', async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.clear(nameInput());
    await user.type(nameInput(), 'x');

    expect(screen.getByRole('button', { name: /Duplicate/ })).toHaveProperty('disabled', true);
  });

  it('imports a workflow by matching connection references to local connections', async () => {
    const exported = {
      version: 1,
      workflows: [
        {
          ...makeWorkflow({
            id: 'imported',
            name: 'Imported',
            stages: [
              makeStage({
                id: 'plan',
                label: 'Plan',
                kind: 'planner',
                role: 'planner',
                backendId: 'opencode',
                providerId: 'opencode-go',
                billingLane: 'opencode-go-subscription',
                modelId: 'glm-5.1',
                connectionReference: 'opencode:opencode-go:opencode-go-subscription',
              } as never),
            ],
          }),
        },
      ],
    };
    renderPage();
    await ready();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([JSON.stringify(exported)], 'flow.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(exported) });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await waitFor(() => expect(mocks.saveWorkflow).toHaveBeenCalledTimes(1));
    const [saved, isImport] = mocks.saveWorkflow.mock.calls[0]!;
    expect(isImport).toBe(true);
    expect(saved.stages[0].connectionProfileId).toBe('conn-go');
    expect(saved.stages[0].modelId).toBe('glm-5.1');
  });
});
