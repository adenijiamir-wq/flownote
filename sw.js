// FlowNotes Service Worker
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(list) {
      for (var i=0; i<list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      return clients.openWindow('/');
    })
  );
});

// Page sends SHOW_NOTIF message → SW shows it (works when app is in background)
self.addEventListener('message', function(e) {
  if (!e.data || e.data.type !== 'SHOW_NOTIF') return;
  self.registration.showNotification(e.data.title, {
    body: e.data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: e.data.tag || 'flownotes',
    vibrate: [200, 100, 200],
    requireInteraction: false
  });
});

self.addEventListener('fetch', function(e) { /* keep SW alive */ });
