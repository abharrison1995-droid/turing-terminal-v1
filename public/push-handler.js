self.addEventListener('push', (event) => {
  let input = {};
  try {
    input = event.data ? event.data.json() : {};
  } catch {
    input = {};
  }
  const title = typeof input.title === 'string' ? input.title.slice(0, 120) : 'Turing Terminal';
  const body = typeof input.body === 'string' ? input.body.slice(0, 240) : 'A workflow needs your attention.';
  const tag = typeof input.tag === 'string' ? input.tag.slice(0, 180) : 'turing-terminal';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: '/turing.svg',
      data: { url: '/' },
      renotify: false,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find((client) => 'focus' in client);
      if (existing) return existing.focus();
      return self.clients.openWindow('/');
    }),
  );
});
