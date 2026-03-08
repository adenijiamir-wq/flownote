// FlowNotes Service Worker v1
// Handles background notifications, notification clicks, and app install

const CACHE = 'flownotes-v1';

// ── Install ──────────────────────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// ── Notification click → open / focus app ───────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If app is already open, focus it
      for (const client of list) {
        if (client.url && 'focus' in client) return client.focus();
      }
      // Otherwise open it
      return clients.openWindow(self.location.origin + '/');
    })
  );
});

// ── Background notification scheduler ───────────────────
// The main page posts the schedule here; we check it every minute
let schedule = [];
let _lastMinute = '';

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SCHEDULE') {
    schedule = e.data.schedule || [];
  }
  if (e.data && e.data.type === 'PING') {
    // Keepalive from main page
    checkSchedule();
  }
});

function getNowHHMM() {
  const n = new Date();
  return String(n.getHours()).padStart(2,'0') + ':' + String(n.getMinutes()).padStart(2,'0');
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

async function checkSchedule() {
  const now = getNowHHMM();
  if (now === _lastMinute) return;
  _lastMinute = now;
  const today = todayStr();

  for (const item of schedule) {
    if (item.time !== now) continue;
    if (item.firedDate === today) continue; // already fired today

    await self.registration.showNotification(item.title, {
      body: item.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: item.tag,
      vibrate: [200, 100, 200],
      data: { url: '/' }
    });

    // Tell main page this one fired so it can persist the state
    const allClients = await clients.matchAll({ includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'FIRED', tag: item.tag, date: today });
    }
  }
}

// Run check every 30 seconds while SW is alive
setInterval(checkSchedule, 30000);
