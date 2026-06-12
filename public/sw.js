self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    // Fall through to defaults
  }

  const title = data.title || 'AG2R';
  const options = {
    body: data.body || 'Session needs your attention',
    icon: '/ag2r-icon.png',
    badge: '/ag2r-badge.png',
    tag: data.tag,
    data: { url: data.url },
    requireInteraction: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      if (url) {
        const existing = windowClients.find((client) => client.url === url);
        if (existing) {
          return existing.focus();
        }
        return clients.openWindow(url);
      }

      if (windowClients.length > 0) {
        return windowClients[0].focus();
      }
    })
  );
});
