// FlowNotes Service Worker v2
// More reliable background notifications

const CACHE = 'flownotes-v2';

// ── Install / Activate ───────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// ── Notification click → open / focus app ───────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow('/');
    })
  );
});

// ── Schedule storage ────────────────────────────────
let schedule = [];
let _lastMinute = '';

function getNowHHMM() {
  const n = new Date();
  return String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
}
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

async function checkSchedule() {
  if (!schedule.length) return;
  const now = getNowHHMM();
  if (now === _lastMinute) return;
  _lastMinute = now;
  const today = todayStr();

  for (const item of schedule) {
    if (item.time !== now) continue;
    if (item.firedDate === today) continue;

    try {
      await self.registration.showNotification(item.title, {
        body: item.body,
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%231a6b3c'/><text y='.9em' font-size='72' x='12'>📚</text></svg>",
        tag: item.tag,
        vibrate: [200, 100, 200],
        requireInteraction: false,
        data: { url: '/' }
      });

      // Tell the main page this fired
      const allClients = await clients.matchAll({ includeUncontrolled: true });
      for (const client of allClients) {
        client.postMessage({ type: 'FIRED', tag: item.tag, date: today });
      }
    } catch (err) {
      // Notification permission may have been revoked
      console.warn('SW notification failed:', err);
    }
  }
}

// ── Message handler ──────────────────────────────────
self.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'SCHEDULE') {
    schedule = e.data.schedule || [];
  }
  if (e.data.type === 'PING') {
    // Keepalive ping from the main page — use this to check schedule
    checkSchedule();
  }
});

// ── Fetch handler — keeps SW alive by handling requests ─
// This is the KEY trick: a SW that handles fetch events stays alive much longer
self.addEventListener('fetch', e => {
  // Only intercept navigation requests — pass everything else through normally
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => {
        // Offline fallback — just return the cached page if available
        return caches.match('/') || fetch(e.request);
      })
    );
    // Also take this opportunity to check the notification schedule
    checkSchedule();
  }
  // All other requests: do nothing (browser handles them normally)
});

// ── Periodic check using SW timer ───────────────────
// Run every 30 seconds while SW is alive (may be throttled by browser)
setInterval(checkSchedule, 30000);
