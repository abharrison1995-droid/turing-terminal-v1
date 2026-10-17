// @vitest-environment jsdom

// Regression for the QR completion poll: in QR mode the page never sets `code`, and the completion effect used to return
// early on an empty code, so completePairing was never called after a QR claim and the phone never finished pairing.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicePairingPage } from './DevicePairingPage';

const { claimPairingRequest, completePairing } = vi.hoisted(() => ({
  claimPairingRequest: vi.fn(),
  completePairing: vi.fn(),
}));
vi.mock('../api', async (importActual) => ({
  ...(await importActual<typeof import('../api')>()),
  api: { claimPairing: vi.fn(), claimPairingRequest, completePairing },
}));

const QR_REQUEST = '3f2c9a10-5b7e-4d2a-9c1e-8a7b6c5d4e3f';

async function settle() {
  for (let index = 0; index < 3; index += 1) await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  claimPairingRequest.mockResolvedValue({ requestId: 'pairing-42' });
  window.history.replaceState({}, '', `/pair?pairRequest=${QR_REQUEST}`);
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('QR pairing completion', () => {
  it('polls completePairing with the request id and no code after a QR claim, then calls onPaired', async () => {
    const onPaired = vi.fn();
    completePairing.mockResolvedValueOnce({ deviceId: 'device-1', machineId: 'machine-1', expiresAt: 'x' });
    render(<DevicePairingPage onPaired={onPaired} />);

    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
    await settle();

    expect(claimPairingRequest).toHaveBeenCalledWith(QR_REQUEST, 'My phone');
    expect(completePairing).toHaveBeenCalledWith('pairing-42', undefined);
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it('does not poll before the claim has produced a request id', async () => {
    render(<DevicePairingPage onPaired={vi.fn()} />);
    await settle();
    expect(completePairing).not.toHaveBeenCalled();
  });
});
