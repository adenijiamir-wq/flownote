// Menmory Service Worker v5 — FCM Web Push + background schedule

const CACHE_NAME = 'menmory-schedule-v2';
const VAPID_PUBLIC = 'BCTkEftgNa1f-rVf3ebgpoSNcjic7N-WfuDfBRt6_otPEZADDuxTZeLeRH97nFDm9-Ip7o3SkjRbWcK476xBLiY';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// ── OS notification tap → open app ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if (c.url && 'focus' in c) return c.focus(); }
      return clients.openWindow('/');
    })
  );
});

// ── FCM/Web Push received — this fires even when app is closed ──
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) { data = { title: 'Menmory', body: e.data ? e.data.text() : '' }; }

  const title = data.title || 'Menmory Reminder';
  const opts = {
    body: data.body || 'You have a reminder',
    icon: self.location.origin + '/icon-192.png',
    badge: self.location.origin + '/icon-192.png',
    tag: data.tag || 'menmory-reminder',
    vibrate: [200, 100, 200],
    requireInteraction: true,
    data: { url: '/' }
  };

  e.waitUntil(self.registration.showNotification(title, opts));
});

// ── Persist schedule for fallback interval check ──
async function saveSchedule(schedule) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put('/sw-schedule', new Response(JSON.stringify(schedule), { headers: { 'Content-Type': 'application/json' } }));
  } catch(e) {}
}

async function loadSchedule() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match('/sw-schedule');
    if (res) return await res.json();
  } catch(e) {}
  return [];
}

let schedule = [];
let scheduleLoaded = false;

async function ensureScheduleLoaded() {
  if (!scheduleLoaded) { schedule = await loadSchedule(); scheduleLoaded = true; }
}

self.addEventListener('message', async e => {
  if (!e.data) return;
  if (e.data.type === 'SCHEDULE') {
    schedule = e.data.schedule || [];
    scheduleLoaded = true;
    await saveSchedule(schedule);
  }
  if (e.data.type === 'PING') { await ensureScheduleLoaded(); checkSchedule(); }
});

function getNowHHMM() {
  const n = new Date();
  return String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
}

// Fallback: fire notification directly from SW if app is in foreground/recent
async function checkSchedule() {
  await ensureScheduleLoaded();
  const now = getNowHHMM();
  const today = new Date().toISOString().split('T')[0];
  let changed = false;

  for (const item of schedule) {
    if (item.fired) continue;
    if (item.time !== now) continue;
    item.fired = true;
    changed = true;

    try {
      await self.registration.showNotification(item.title, {
        body: item.body || 'Tap to open Menmory',
        icon: self.location.origin + '/icon-192.png',
        badge: self.location.origin + '/icon-192.png',
        tag: item.tag,
        vibrate: [200, 100, 200],
        requireInteraction: true,
        data: { url: '/' }
      });
    } catch(err) {}

    const allClients = await clients.matchAll({ includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'FIRED', tag: item.tag, title: item.title, body: item.body, date: today });
    }
  }
  if (changed) await saveSchedule(schedule);
}

setInterval(checkSchedule, 60000);
