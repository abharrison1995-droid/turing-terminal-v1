import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('PWA push service worker', () => {
  it('shows sanitized notification text and ignores untrusted payload links', async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const showNotification = vi.fn(async () => undefined);
    const self = {
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) =>
        listeners.set(type, listener),
      registration: { showNotification },
      clients: {
        matchAll: vi.fn(async () => []),
        openWindow: vi.fn(async () => undefined),
      },
    };
    runInNewContext(readFileSync('public/push-handler.js', 'utf8'), { self });
    const pushEvent = {
      data: {
        json: () => ({ title: 'Approval required', body: 'Review the action.', url: 'javascript:alert(1)' }),
      },
      waitUntil: vi.fn(),
    };
    listeners.get('push')!(pushEvent);
    await pushEvent.waitUntil.mock.calls[0]![0];
    expect(showNotification).toHaveBeenCalledWith('Approval required', {
      body: 'Review the action.',
      tag: 'turing-terminal',
      icon: '/turing.svg',
      data: { url: '/' },
      renotify: false,
    });

    const clickEvent = {
      notification: { close: vi.fn() },
      waitUntil: vi.fn(),
    };
    listeners.get('notificationclick')!(clickEvent);
    await clickEvent.waitUntil.mock.calls[0]![0];
    expect(clickEvent.notification.close).toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith('/');
  });
});
