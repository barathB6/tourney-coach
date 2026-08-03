// TourneyCoach Web Push service worker.
// Kept deliberately tiny: show the notification, focus the portal on click.
self.addEventListener('push', (event) => {
  let data = { title: 'TourneyCoach', body: '' };
  try { data = event.data.json(); } catch { /* non-JSON payload */ }
  event.waitUntil(self.registration.showNotification(data.title || 'TourneyCoach', {
    body: data.body || '',
    icon: '/favicon.ico',
    data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow(url);
  }));
});
