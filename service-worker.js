// RVnB service worker
//
// Purpose (for now): receive Web Push messages and show them as native
// notifications, and handle taps on those notifications by opening/focusing
// the right page. Does NOT do offline caching — that's a separate feature
// we can add later if wanted, and skipping it keeps this simple and low-risk.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'RVnB', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'RVnB';
  const options = {
    body: data.body || '',
    icon: '/logo-192.png',
    badge: '/logo-128.png',
    data: { link: data.link || '/' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(link) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(link);
    })
  );
});
