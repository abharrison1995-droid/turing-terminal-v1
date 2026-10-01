const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function makePairingQrUrl(originInput: string, requestId: string): string | null {
  if (!UUID_PATTERN.test(requestId)) return null;
  try {
    const origin = new URL(originInput.trim());
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      return null;
    const qr = new URL('/', origin.origin);
    qr.searchParams.set('pairRequest', requestId.toLowerCase());
    return qr.toString();
  } catch {
    return null;
  }
}

export function parsePairingRequestId(value: string): string | null {
  try {
    const id = new URL(value, 'https://pair.invalid').searchParams.get('pairRequest');
    return id && UUID_PATTERN.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}
