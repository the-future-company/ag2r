self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    // Fall through to defaults
  }

  const title = data.title || 'AG2R';
  const tag = data.tag || 'ag2r-attention';
  const options = {
    body: data.body || 'Session needs your attention',
    icon: data.icon || '/ag2r-icon.png',
    badge: '/ag2r-badge.png',
    tag,
    renotify: true,
    data: { url: data.url },
    requireInteraction: true,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If an AG2R window is already open, tell it to open the sidebar and focus it
      if (windowClients.length > 0) {
        const target = windowClients[0];
        target.postMessage({ type: 'open-sidebar' });
        return target.focus();
      }

      // No open window — open one (with ?sidebar=open in the URL)
      if (url) return clients.openWindow(url);
    })
  );
});
