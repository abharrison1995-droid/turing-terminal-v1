import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

// Regression: the server rejects `content-type: application/json` with an empty body (FST_ERR_CTP_EMPTY_JSON_BODY),
// which made "Create pairing code" fail, so no code or QR appeared.
describe('bodyless requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ request: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const headersOf = (fetchMock: ReturnType<typeof stub>) =>
    new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers);

  it('does not declare a JSON content type when creating a pairing request (no body)', async () => {
    const fetchMock = stub();
    await api.createPairingRequest();
    expect(headersOf(fetchMock).has('content-type')).toBe(false);
  });

  it('does not declare a JSON content type for approve or deny', async () => {
    const approve = stub();
    await api.approvePairingRequest('id-1');
    expect(headersOf(approve).has('content-type')).toBe(false);
    const deny = stub();
    await api.denyPairingRequest('id-1');
    expect(headersOf(deny).has('content-type')).toBe(false);
  });

  it('still declares JSON when a body is sent', async () => {
    const fetchMock = stub();
    await api.claimPairing('ABCDEF0123456789', 'My phone');
    expect(headersOf(fetchMock).get('content-type')).toBe('application/json');
  });
});
