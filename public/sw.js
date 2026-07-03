// Activate new SW immediately on install (don't wait for all tabs to close)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
    data: { url: data.url, conversationId: data.conversationId },
    requireInteraction: true,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url;
  const conversationId = event.notification.data?.conversationId;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If an AG2R window is already open, tell it to navigate and focus it
      if (windowClients.length > 0) {
        const target = windowClients[0];
        target.postMessage({
          type: conversationId ? 'navigate-conversation' : 'open-sidebar',
          conversationId,
        });
        return target.focus();
      }

      // No open window — open one (URL already has ?sidebar=open&conversationId=<id>)
      if (url) return clients.openWindow(url);
    })
  );
});
