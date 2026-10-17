self.addEventListener('push', (event) => {
  let input = {};
  try {
    input = event.data ? event.data.json() : {};
  } catch {
    input = {};
  }
  const title = typeof input.title === 'string' ? input.title.slice(0, 120) : 'Turing Terminal';
  const body = typeof input.body === 'string' ? input.body.slice(0, 240) : 'A workflow needs your attention.';
  const tag =
    typeof input.tag === 'string' && /^[A-Za-z0-9:_-]{1,180}$/.test(input.tag)
      ? input.tag
      : 'turing-terminal';
  const url = safeTarget(input.url);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: '/turing.svg',
      data: { url },
      renotify: false,
    }),
  );
});

function safeTarget(value) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  )
    return '/';
  try {
    const target = new URL(value, self.location.origin);
    if (target.origin !== self.location.origin) return '/';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const target = safeTarget(event.notification.data?.url);
      const existing = windows.find((client) => {
        try {
          return new URL(client.url).origin === self.location.origin && 'focus' in client;
        } catch {
          return false;
        }
      });
      if (existing) {
        if (typeof existing.navigate === 'function') {
          try {
            await existing.navigate(target);
          } catch {
            /* Focus is still useful when this browser cannot navigate an existing client. */
          }
        }
        return existing.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
