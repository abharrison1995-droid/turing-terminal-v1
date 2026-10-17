import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('public/push-handler.js', 'utf8');

function harness(windows: Array<Record<string, unknown>> = []) {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const showNotification = vi.fn(async () => undefined);
  const matchAll = vi.fn(async () => windows);
  const openWindow = vi.fn(async () => undefined);
  const self = {
    location: { origin: 'https://turing.test' },
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
      listeners.set(type, listener),
    registration: { showNotification },
    clients: { matchAll, openWindow },
  };
  runInNewContext(source, { self, URL });
  return { listeners, showNotification, matchAll, openWindow };
}

async function push(
  listeners: Map<string, (event: Record<string, unknown>) => void>,
  payload: Record<string, unknown>,
) {
  const event = {
    data: { json: () => payload },
    waitUntil: vi.fn(),
  };
  listeners.get('push')!(event);
  await event.waitUntil.mock.calls[0]![0];
}

async function click(
  listeners: Map<string, (event: Record<string, unknown>) => void>,
  data: Record<string, unknown>,
) {
  const event = { notification: { close: vi.fn(), data }, waitUntil: vi.fn() };
  listeners.get('notificationclick')!(event);
  await event.waitUntil.mock.calls[0]![0];
  return event;
}

describe('PWA push service worker', () => {
  it('accepts safe Goal links and uses the bounded server dedup tag', async () => {
    const sw = harness();
    await push(sw.listeners, {
      title: 'Grand Project needs approval',
      body: 'Review the Goal gate.',
      url: '/?page=goals&goalId=goal-a',
      tag: 'goal-approval:approval-a',
    });
    expect(sw.showNotification).toHaveBeenCalledWith('Grand Project needs approval', {
      body: 'Review the Goal gate.',
      tag: 'goal-approval:approval-a',
      icon: '/turing.svg',
      data: { url: '/?page=goals&goalId=goal-a' },
      renotify: false,
    });
  });

  it.each([
    ['javascript URL', 'javascript:alert(1)'],
    ['external URL', 'https://attacker.example/'],
    ['protocol-relative URL', '//attacker.example/'],
    ['backslash URL', '/\\attacker.example/'],
    ['oversized URL', `/${'x'.repeat(2048)}`],
  ])('falls back to the app root for an unsafe %s', async (_label, url) => {
    const sw = harness();
    await push(sw.listeners, { title: 'Notice', body: 'Body', url, tag: 'safe-tag' });
    expect(sw.showNotification.mock.calls[0]?.[1]).toMatchObject({ data: { url: '/' } });
  });

  it('rejects malformed or oversized server tags and bounds notification copy', async () => {
    const malformed = harness();
    await push(malformed.listeners, {
      title: 'T'.repeat(130),
      body: 'B'.repeat(250),
      tag: 'bad tag',
      url: '/',
    });
    expect(malformed.showNotification.mock.calls[0]?.[0]).toHaveLength(120);
    expect(malformed.showNotification.mock.calls[0]?.[1]).toMatchObject({
      body: 'B'.repeat(240),
      tag: 'turing-terminal',
    });

    const oversized = harness();
    await push(oversized.listeners, { tag: 'a'.repeat(181) });
    expect(oversized.showNotification.mock.calls[0]?.[1]).toMatchObject({ tag: 'turing-terminal' });
  });

  it('navigates and focuses an existing same-origin Turing window', async () => {
    const client = {
      url: 'https://turing.test/',
      navigate: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
    };
    const sw = harness([client]);
    const event = await click(sw.listeners, { url: '/?page=goals&goalId=goal-a' });
    expect(event.notification.close).toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith('/?page=goals&goalId=goal-a');
    expect(client.focus).toHaveBeenCalled();
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('opens a safe relative URL when no Turing window exists and rejects unsafe click data', async () => {
    const sw = harness();
    await click(sw.listeners, { url: '/?page=goals&goalId=goal-a' });
    await click(sw.listeners, { url: 'javascript:alert(1)' });
    expect(sw.openWindow.mock.calls).toEqual([['/?page=goals&goalId=goal-a'], ['/']]);
  });
});
