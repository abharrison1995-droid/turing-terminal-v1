export function decodeVapidPublicKey(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const raw = window.atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  new Uint8Array(buffer).set(Array.from(raw, (character) => character.charCodeAt(0)));
  return buffer;
}

export function pushSubscriptionStorageKey(origin: string): string {
  return `turing-terminal.push-subscription-id:${origin}`;
}
