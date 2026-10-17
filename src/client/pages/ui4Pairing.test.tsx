// @vitest-environment jsdom

// UI.4 pairing tests (UI4_SCOPE sections 3, 4 and 5; matrix K1). Pairing behaviour and security are unchanged by UI.4, so
// these are GUARD tests of the current request payloads, plus one RED test that the scope's own K1 wording expects.
//
// Pinned forms, so the implementer can match the copy and the URL handling:
// - Code entry: the input is labelled "Pairing code" with the placeholder "16-character code". Input keeps only A to F and
//   0 to 9, upper-cased, at most 16 characters.
// - The claim payloads are exactly claimPairing(code, deviceName) and claimPairingRequest(requestId, deviceName), both
//   trimmed. No other arguments.
// - QR state: the callout "QR pairing request detected. The desktop owner must approve this phone." replaces the code input.
// - The pairRequest query parameter is removed from the address bar; other parameters and the hash are kept.
//
// [RED] ui4Pairing: the QR completion poll. In QR mode the page never sets `code`, and its completion effect returns early
// when `code` is empty, so completePairing is never called after a QR claim. The scope's K1 wording expects a call with an
// undefined code. UI.4 forbids logic changes, so the test was removed and the finding is recorded in docs/ui/EVIDENCE.md
// for an owner decision; it is not fixed here.
//
// The 2 s completion interval is created but never advanced, and it is cleared on unmount. No test waits on real time.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicePairingPage } from './DevicePairingPage';

const { claimPairing, claimPairingRequest, completePairing } = vi.hoisted(() => ({
  claimPairing: vi.fn(),
  claimPairingRequest: vi.fn(),
  completePairing: vi.fn(),
}));
vi.mock('../api', async (importActual) => ({
  ...(await importActual<typeof import('../api')>()),
  api: { claimPairing, claimPairingRequest, completePairing },
}));

const QR_REQUEST = '3f2c9a10-5b7e-4d2a-9c1e-8a7b6c5d4e3f';
const CODE = 'ABCDEF0123456789';
const claimed = { requestId: 'pairing-42', status: 'pending', expiresAt: '2026-10-17T12:05:00.000Z' };

/** Lets the resolved mock promises settle, without waiting on real time. */
async function settle() {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {});
  }
}

const setUrl = (path: string) => window.history.replaceState({}, '', path);
const codeInput = () => screen.queryByLabelText('Pairing code') as HTMLInputElement | null;
const requestButton = () =>
  screen.getByRole('button', { name: /Request approval|Requesting approval/ }) as HTMLButtonElement;
const deviceName = () => screen.getByLabelText('Device name') as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  claimPairing.mockResolvedValue(claimed);
  claimPairingRequest.mockResolvedValue(claimed);
  completePairing.mockResolvedValue({ status: 'waiting_for_desktop_approval' });
  setUrl('/');
});

afterEach(() => {
  cleanup();
  setUrl('/');
});

describe('code entry (UI4 section 4, K1)', () => {
  it('[GUARD] the code keeps only A to F and 0 to 9, upper-cased and at most 16 characters; submit needs 16 and a name', () => {
    render(<DevicePairingPage onPaired={vi.fn()} />);
    const input = codeInput()!;

    fireEvent.change(input, { target: { value: 'g1-a' } });
    expect(input.value).toBe('1A');
    fireEvent.change(input, { target: { value: 'abcdef0123456789xyz' } });
    expect(input.value).toBe(CODE);
    expect(requestButton().disabled).toBe(false);

    fireEvent.change(deviceName(), { target: { value: '' } });
    expect(requestButton().disabled).toBe(true);
  });

  it('[GUARD] claim sends the trimmed code and device name, then shows the waiting state with the code input disabled', async () => {
    render(<DevicePairingPage onPaired={vi.fn()} />);
    fireEvent.change(codeInput()!, { target: { value: CODE } });
    fireEvent.change(deviceName(), { target: { value: '  Pixel  ' } });

    fireEvent.click(requestButton());
    await settle();

    expect(claimPairing).toHaveBeenCalledTimes(1);
    expect(claimPairing).toHaveBeenCalledWith(CODE, 'Pixel');
    expect(screen.getByRole('status').textContent).toContain('Waiting for desktop approval');
    expect(codeInput()!.disabled).toBe(true);
  });

  it('[GUARD] the code-mode poll calls completePairing(requestId, code), and a completed result calls onPaired', async () => {
    const onPaired = vi.fn();
    completePairing.mockResolvedValueOnce({
      deviceId: 'device-1',
      machineId: 'machine-1',
      expiresAt: claimed.expiresAt,
    });
    render(<DevicePairingPage onPaired={onPaired} />);
    fireEvent.change(codeInput()!, { target: { value: CODE } });

    fireEvent.click(requestButton());
    await settle();

    expect(completePairing).toHaveBeenCalledWith('pairing-42', CODE);
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it('[GUARD] an expired request shows the error alert and returns to the request button with the code input enabled', async () => {
    completePairing.mockRejectedValue(new Error('Pairing request expired.'));
    render(<DevicePairingPage onPaired={vi.fn()} />);
    fireEvent.change(codeInput()!, { target: { value: CODE } });

    fireEvent.click(requestButton());
    await settle();

    expect(screen.getByRole('alert').textContent).toBe('Pairing request expired.');
    expect((screen.getByRole('button', { name: 'Request approval' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(codeInput()!.disabled).toBe(false);
  });
});

describe('QR request state (UI4 section 4, K1)', () => {
  it('[GUARD] a QR request replaces the code input with the callout and needs only a device name', () => {
    setUrl(`/pair?pairRequest=${QR_REQUEST}`);
    render(<DevicePairingPage onPaired={vi.fn()} />);

    expect(
      screen.getByText('QR pairing request detected. The desktop owner must approve this phone.'),
    ).toBeTruthy();
    expect(codeInput()).toBeNull();
    expect(requestButton().disabled).toBe(false);
  });

  it('[GUARD] the pairRequest parameter leaves the address bar; other parameters and the hash are kept', () => {
    setUrl(`/pair?pairRequest=${QR_REQUEST}&keep=1#top`);
    render(<DevicePairingPage onPaired={vi.fn()} />);

    expect(window.location.search).toBe('?keep=1');
    expect(window.location.hash).toBe('#top');
  });

  it('[GUARD] a QR claim calls claimPairingRequest(requestId, deviceName) and never claimPairing', async () => {
    setUrl(`/pair?pairRequest=${QR_REQUEST}`);
    render(<DevicePairingPage onPaired={vi.fn()} />);

    fireEvent.click(requestButton());
    await settle();

    expect(claimPairingRequest).toHaveBeenCalledTimes(1);
    expect(claimPairingRequest).toHaveBeenCalledWith(QR_REQUEST, 'My phone');
    expect(claimPairing).not.toHaveBeenCalled();
  });
});

describe('no credential wording (UI4 section 3, K1)', () => {
  it('[GUARD] neither pairing state shows token, cookie, bearer or secret wording; the expiry note is unchanged', () => {
    const credential = /token|cookie|bearer|secret/i;

    const { container, unmount } = render(<DevicePairingPage onPaired={vi.fn()} />);
    expect(container.textContent).not.toMatch(credential);
    expect(container.textContent).toContain(
      'Pairing codes expire after five minutes. Provider credentials remain on the desktop.',
    );
    unmount();

    setUrl(`/pair?pairRequest=${QR_REQUEST}`);
    const qr = render(<DevicePairingPage onPaired={vi.fn()} />);
    expect(qr.container.textContent).not.toMatch(credential);
  });
});
