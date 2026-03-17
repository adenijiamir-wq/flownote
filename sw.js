// ── Menmory Service Worker ──────────────────────────────
// Handles: push notifications, scheduled reminders, timer live notification

const CACHE_NAME = 'menmory-v1';

// ── Lifecycle ──────────────────────────────────────────
self.addEventListener('install', () => {
  self.skipWaiting(); // activate immediately, don't wait for old SW to die
});

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim()); // take control of all open pages instantly
});

// ── Persistent store for reminder schedule ─────────────
let schedule = [];
let scheduleLoaded = false;

async function saveSchedule(s) {
  try {
    const db = await openDB();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ key: 'schedule', value: s });
    await tx.complete;
  } catch (e) {
    // IndexedDB not available — keep in memory only
  }
}

async function loadSchedule() {
  try {
    const db = await openDB();
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get('schedule');
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result ? req.result.value : []);
      req.onerror  = () => res([]);
    });
  } catch (e) {
    return [];
  }
}

async function ensureScheduleLoaded() {
  if (!scheduleLoaded) {
    schedule = await loadSchedule();
    scheduleLoaded = true;
  }
}

// ── IndexedDB helper ───────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('menmory-sw', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv', { keyPath: 'key' });
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

// ── Reminder scheduler ─────────────────────────────────
function checkSchedule() {
  if (!schedule || !schedule.length) return;
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  const hhmm  = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');

  schedule.forEach(item => {
    if (!item || !item.time) return;
    const matchDate =
      item.date === today ||
      item.date === 'everyday' ||
      (item.date === 'everyweek' && now.getDay() === new Date(item.createdDate || today).getDay());
    if (!matchDate) return;
    if (item.time.slice(0, 5) !== hhmm) return;

    const tag = 'reminder-' + (item.id || item.text);
    self.registration.showNotification('⏰ ' + (item.text || 'Reminder'), {
      body: item.date === 'everyday' ? 'Daily reminder' : 'Tap to open Menmory',
      icon: self.location.origin + '/icon-192.png',
      badge: self.location.origin + '/icon-192.png',
      tag,
      renotify: true,
      data: { url: self.location.origin + '/' }
    });

    // Tell the page it fired so it can mark it
    self.clients.matchAll({ type: 'window' }).then(clients => {
      clients.forEach(c => c.postMessage({ type: 'FIRED', tag, title: item.text, body: '' }));
    });
  });
}

// ── Message handler ────────────────────────────────────
self.addEventListener('message', async e => {
  if (!e.data) return;

  // Reminder schedule sync
  if (e.data.type === 'SCHEDULE') {
    schedule = e.data.schedule || [];
    scheduleLoaded = true;
    await saveSchedule(schedule);
  }

  // Ping — check reminders on demand
  if (e.data.type === 'PING') {
    await ensureScheduleLoaded();
    checkSchedule();
  }

  // ── Timer live notification ────────────────────────────
  // Shows a persistent notification that looks like the clock timer widget
  // (stays in the shade, updates every minute, has a progress bar via timestamp)
  if (e.data.type === 'TIMER_TICK') {
    const secsLeft  = e.data.secsLeft  || 0;
    const secsTotal = e.data.secsTotal || 1500;
    const running   = e.data.running !== false;
    const title     = e.data.title || '⏱ Menmory Timer';
    const body      = e.data.body  || 'Timer running';

    // Samsung/Android live notification style:
    // - Use timestamp trick so the OS shows a live countdown
    // - chronometer = true makes it count up from startTime, we offset it
    //   so it reads the correct time remaining
    const endEpoch = Date.now() + secsLeft * 1000;

    await self.registration.showNotification(title, {
      body,
      icon:       self.location.origin + '/icon-192.png',
      badge:      self.location.origin + '/icon-192.png',
      tag:        'menmory-timer',
      renotify:   false,
      silent:     true,
      ongoing:    true,       // can't be swiped away while timer runs
      // Android chronometer — shows live countdown in the notification
      timestamp:  endEpoch,
      data: { url: self.location.origin + '/?timer=1' },
      actions: running
        ? [{ action: 'open', title: '▶ Open' }]
        : [{ action: 'open', title: 'Open' }]
    });
  }

  // Clear timer notification when session ends or is paused
  if (e.data.type === 'CLEAR_TIMER') {
    const notifs = await self.registration.getNotifications({ tag: 'menmory-timer' });
    notifs.forEach(n => n.close());
  }
});

// ── Periodic background check (fires ~every 1 min on Android) ──
self.addEventListener('periodicsync', async e => {
  if (e.tag === 'check-reminders') {
    e.waitUntil((async () => {
      await ensureScheduleLoaded();
      checkSchedule();
    })());
  }
});

// ── Push (server-side triggered) ───────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch (_) { data = { title: 'Menmory', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(
    self.registration.showNotification(data.title || '⏰ Menmory', {
      body:  data.body  || '',
      icon:  self.location.origin + '/icon-192.png',
      badge: self.location.origin + '/icon-192.png',
      tag:   data.tag   || 'menmory-push',
      data:  { url: self.location.origin + '/' }
    })
  );
});

// ── Notification tap → open app ────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.location.origin + '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing tab if open
      for (const c of clients) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus();
      }
      // Otherwise open new tab
      return self.clients.openWindow(url);
    })
  );
});
