// @vitest-environment jsdom

// Providers & connections: the guided flow for the four subscription services, saved-connection reuse, honest Unknown
// states, and the Advanced custom route. The api module is mocked: nothing here reaches a network, a CLI or a model.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConnection, makeProvider, makeStage, makeWorkflow } from '../workflows/testFixtures';
import type { ProviderStatus } from '../../../shared/types';

const mocks = vi.hoisted(() => ({
  connectionProfiles: vi.fn(),
  saveConnectionProfile: vi.fn(),
  deleteConnectionProfile: vi.fn(),
  refreshProviders: vi.fn(),
}));
vi.mock('../../api', async (importActual) => ({
  ...(await importActual<typeof import('../../api')>()),
  api: mocks,
}));

import { ProviderSetup, connectionUsage } from './ProviderSetup';

const detected = (id: string, overrides: Partial<ProviderStatus> = {}) => makeProvider(id, [], overrides);
const allProviders = () => [
  detected('opencode', { authentication: 'unknown' }),
  detected('codex-cli', { subscriptionAuthenticated: null }),
  detected('claude-code', { subscriptionAuthenticated: null }),
  detected('cline'),
];

function setup(providers: ProviderStatus[] = allProviders(), workflows = [makeWorkflow()]) {
  const onNotice = vi.fn();
  const onChanged = vi.fn();
  render(
    <ProviderSetup providers={providers} workflows={workflows} onNotice={onNotice} onChanged={onChanged} />,
  );
  return { onNotice, onChanged };
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.connectionProfiles.mockResolvedValue({ profiles: [] });
  mocks.saveConnectionProfile.mockImplementation(async (body: object) => ({
    profile: { ...makeConnection(), ...body, id: 'saved-1' },
  }));
  mocks.deleteConnectionProfile.mockResolvedValue({});
  mocks.refreshProviders.mockResolvedValue({ providers: allProviders() });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Providers & connections', () => {
  it('offers the four recognisable services and no separate connection form elsewhere', async () => {
    setup();
    await screen.findByText(/None yet/);

    for (const name of ['OpenCode Go', 'Codex — ChatGPT subscription', 'Claude Pro / Max', 'ClinePass']) {
      expect(screen.getByRole('radio', { name: new RegExp(name) })).toBeTruthy();
    }
  });

  it.each([
    ['OpenCode Go', 'opencode', 'opencode-go', 'opencode-go-subscription', 'opencode-go'],
    ['Codex — ChatGPT subscription', 'codex-cli', 'openai-codex', 'chatgpt-subscription', 'codex-chatgpt'],
    [
      'Claude Pro / Max',
      'claude-code',
      'anthropic-subscription',
      'claude-subscription',
      'claude-subscription',
    ],
    ['ClinePass', 'cline', 'cline-pass', 'clinepass-subscription', 'clinepass'],
  ])(
    '%s saves a reusable connection on the derived route, with no credential',
    async (label, backendId, providerId, billingLane, serviceId) => {
      const user = userEvent.setup();
      const { onNotice } = setup();
      await screen.findByText(/None yet/);

      await user.click(screen.getByRole('radio', { name: new RegExp(label) }));
      await user.click(screen.getByRole('button', { name: 'Save connection' }));

      await waitFor(() => expect(mocks.saveConnectionProfile).toHaveBeenCalledTimes(1));
      expect(mocks.saveConnectionProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          backendId,
          providerId,
          billingLane,
          credentialStoreRef: null,
          metadata: { serviceId },
        }),
      );
      expect(onNotice.mock.calls[0]![0]).toMatch(/does not sign you in/);
    },
  );

  it('keeps installation, authentication, catalogue and last check separate and shows Unknown honestly', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText(/None yet/);
    await user.click(screen.getByRole('radio', { name: /ClinePass/ }));

    // ClinePass: the CLI is detected, but Turing has no sign-in check and no catalogue for it.
    const steps = screen.getByRole('list', { name: /ClinePass setup steps/ });
    const names = new Set(
      within(steps)
        .getAllByText(/^(Installation|Authentication|Model catalogue|Last check)$/)
        .map((item) => item.textContent),
    );
    expect([...names].sort()).toEqual(['Authentication', 'Installation', 'Last check', 'Model catalogue']);
    const authLine = within(steps).getByText('Authentication').closest('.readiness-line')!;
    expect(authLine.className).toContain('readiness-unknown');
    expect(
      within(authLine as HTMLElement).getByText('Unknown', { selector: '.readiness-word' }),
    ).toBeTruthy();
    const catalogueLine = within(steps).getByText('Model catalogue').closest('.readiness-line')!;
    expect(catalogueLine.className).not.toContain('readiness-ok');
  });

  it('does not treat a detected CLI as a signed-in subscription (Codex without a sign-in answer stays Unknown)', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText(/None yet/);
    await user.click(screen.getByRole('radio', { name: /Codex/ }));

    const steps = screen.getByRole('list', { name: /Codex.*setup steps/ });
    const authLine = within(steps).getByText('Authentication').closest('.readiness-line')!;
    expect(authLine.className).toContain('readiness-unknown');
  });

  it('blocks saving when the tool is not detected and says why', async () => {
    const user = userEvent.setup();
    setup([detected('opencode', { detected: false, version: null }), ...allProviders().slice(1)]);
    await screen.findByText(/None yet/);
    await user.click(screen.getByRole('radio', { name: /OpenCode Go/ }));

    expect((screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/was not detected on this Desktop Master/)).toBeTruthy();
  });

  it('shows commands as text to copy, never runs anything, and says so', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText(/None yet/);
    await user.click(screen.getByRole('radio', { name: /Claude Pro/ }));

    expect(screen.getByText('claude auth login')).toBeTruthy();
    expect(screen.getByText(/Turing never runs these commands/)).toBeTruthy();
    expect(mocks.refreshProviders).not.toHaveBeenCalled();
    expect(mocks.saveConnectionProfile).not.toHaveBeenCalled();
  });

  it('Check again refreshes provider status and sends no prompt', async () => {
    const user = userEvent.setup();
    const { onChanged } = setup([detected('cline', { detected: false }), ...allProviders().slice(0, 3)]);
    await screen.findByText(/None yet/);
    await user.click(screen.getByRole('radio', { name: /ClinePass/ }));
    expect((screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() => expect(mocks.refreshProviders).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/No prompt was sent to any model/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps the previous status and says so when a check fails', async () => {
    const user = userEvent.setup();
    mocks.refreshProviders.mockRejectedValue(new Error('Desktop Master unreachable.'));
    setup();
    await screen.findByText(/None yet/);
    await user.click(screen.getByRole('radio', { name: /OpenCode Go/ }));

    await user.click(screen.getByRole('button', { name: 'Check again' }));

    expect(
      await screen.findByText(/Desktop Master unreachable\. The previous status is still shown/),
    ).toBeTruthy();
  });

  it('stores a plan name only as the user’s own unverified label', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText(/None yet/);
    await user.click(screen.getByRole('radio', { name: /Codex/ }));
    await user.type(screen.getByLabelText(/Plan label/), 'Pro');
    await user.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(mocks.saveConnectionProfile).toHaveBeenCalled());
    expect(mocks.saveConnectionProfile.mock.calls[0]![0].metadata).toEqual({
      serviceId: 'codex-chatgpt',
      planLabel: 'Pro',
    });
    expect(await screen.findByText(/Plan label you entered: Pro \(not verified\)/)).toBeTruthy();
  });

  it('lists saved connections with their friendly service name and the route they record', async () => {
    mocks.connectionProfiles.mockResolvedValue({
      profiles: [
        makeConnection({
          id: 'c1',
          name: 'My Claude',
          backendId: 'claude-code',
          providerId: 'anthropic-subscription',
          billingLane: 'claude-subscription',
        }),
      ],
    });
    setup();

    const row = (await screen.findByText('My Claude')).closest('li')!;
    expect(within(row).getByText(/Claude Pro \/ Max · claude-code \/ anthropic-subscription/)).toBeTruthy();
  });

  it('asks before removing a connection that workflow stages use, and names the count', async () => {
    const user = userEvent.setup();
    mocks.connectionProfiles.mockResolvedValue({ profiles: [makeConnection({ id: 'conn-go', name: 'Go' })] });
    const workflow = makeWorkflow({
      stages: [
        makeStage({ id: 'a', connectionProfileId: 'conn-go' }),
        makeStage({ id: 'b', connectionProfileId: 'conn-go' }),
      ],
    });
    expect(connectionUsage('conn-go', [workflow]).stages).toBe(2);
    const { onChanged } = setup(allProviders(), [workflow]);
    await screen.findByText('Go');

    await user.click(screen.getByRole('button', { name: /Remove Go/ }));
    expect(mocks.deleteConnectionProfile).not.toHaveBeenCalled();
    expect(screen.getByText(/2 workflow settings use it/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove connection' }));
    await waitFor(() => expect(mocks.deleteConnectionProfile).toHaveBeenCalledWith('conn-go'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps a custom route under Advanced and refuses a provider/lane pair the billing gate rejects', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText(/None yet/);

    const advanced = screen.getByText(/Advanced · custom route/).closest('details')!;
    expect(advanced.open).toBe(false);
    await user.click(within(advanced).getByText(/Advanced · custom route/));

    await user.type(within(advanced).getByLabelText('Connection name'), 'Odd route');
    const provider = within(advanced).getByLabelText('Provider ID');
    await user.clear(provider);
    await user.type(provider, 'not-a-real-provider');
    const save = within(advanced).getByRole('button', {
      name: 'Save custom connection',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(advanced).getByText(/cannot bill provider/)).toBeTruthy();

    await user.clear(provider);
    await user.type(provider, 'opencode-go');
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(mocks.saveConnectionProfile).toHaveBeenCalledTimes(1));
    expect(mocks.saveConnectionProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        backendId: 'opencode',
        providerId: 'opencode-go',
        billingLane: 'opencode-go-subscription',
        credentialStoreRef: null,
      }),
    );
  });
});
