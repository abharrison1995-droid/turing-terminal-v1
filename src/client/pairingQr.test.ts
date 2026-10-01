import { describe, expect, it } from 'vitest';
import { makePairingQrUrl, parsePairingRequestId } from './pairingQr.js';

const requestId = 'b6d4143b-0c1d-4c58-87c3-d8202c8c2ad1';

describe('safe pairing QR payloads', () => {
  it('encodes only the HTTPS Serve origin and short-lived request UUID', () => {
    const value = makePairingQrUrl('https://desktop.tailnet-example.ts.net', requestId);
    expect(value).toBe(`https://desktop.tailnet-example.ts.net/?pairRequest=${requestId}`);
    expect(value).not.toContain('code');
    expect(value).not.toContain('token');
    expect(parsePairingRequestId(value!)).toBe(requestId);
  });

  it.each([
    'http://desktop.tailnet-example.ts.net',
    'https://user:password@desktop.tailnet-example.ts.net',
    'https://desktop.tailnet-example.ts.net/path',
    'https://desktop.tailnet-example.ts.net/?token=secret',
    'javascript:alert(1)',
  ])('rejects unsafe QR origins: %s', (origin) => {
    expect(makePairingQrUrl(origin, requestId)).toBeNull();
  });

  it('rejects malformed request identifiers', () => {
    expect(makePairingQrUrl('https://desktop.tailnet-example.ts.net', 'token=secret')).toBeNull();
    expect(parsePairingRequestId('?pairRequest=../../secret')).toBeNull();
  });
});
