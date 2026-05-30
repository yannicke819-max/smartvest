// LISA refonte B.4.c — Service worker push event handler.
//
// Servi statiquement par Next.js depuis /sw-lisa-push.js.
// Scope = root (le client enregistre avec scope '/').
//
// Reçoit des pushes "trigger-only" du backend (payload vide). Affiche une
// notification générique ; le contenu réel est récupéré via fetch sur
// /api/lisa/notifications par l'UI au prochain focus.

self.addEventListener('install', (event) => {
  // Activate immédiatement (skip waiting) — pas de cache à warm-up.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let title = '🤖 LISA';
  let body = 'Nouvelle notification';
  let tag = 'lisa-default';
  try {
    if (event.data) {
      const payload = event.data.json();
      if (payload.title) title = payload.title;
      if (payload.body) body = payload.body;
      if (payload.tag) tag = payload.tag;
    }
  } catch (e) {
    // Trigger-only push (pas de payload) — affiche la notif générique.
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: '/icon-192.png', // optional — Next ignore silencieusement si absent
      badge: '/badge-72.png',
      vibrate: [100, 50, 100],
      data: { url: '/lisa' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/lisa';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    }),
  );
});
