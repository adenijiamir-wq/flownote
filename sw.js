// Menmory Service Worker v4 — persistent background notifications

const CACHE_NAME = 'menmory-schedule-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
      for(const c of list){ if(c.url && 'focus' in c) return c.focus(); }
      return clients.openWindow('/');
    })
  );
});

// ── Persist schedule to Cache so it survives SW restart ──
async function saveSchedule(schedule){
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = new Response(JSON.stringify(schedule), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put('/sw-schedule', res);
  } catch(e) {}
}

async function loadSchedule(){
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match('/sw-schedule');
    if(res) return await res.json();
  } catch(e) {}
  return [];
}

// ── In-memory schedule (loaded from cache on start) ──
let schedule = [];
let scheduleLoaded = false;

async function ensureScheduleLoaded(){
  if(!scheduleLoaded){
    schedule = await loadSchedule();
    scheduleLoaded = true;
  }
}

self.addEventListener('message', async e => {
  if(!e.data) return;
  if(e.data.type === 'SCHEDULE'){
    schedule = e.data.schedule || [];
    scheduleLoaded = true;
    await saveSchedule(schedule);
  }
  if(e.data.type === 'PING'){
    await ensureScheduleLoaded();
    checkSchedule();
  }
});

function getTodayStr(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

function getNowHHMM(){
  const n = new Date();
  return String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
}

async function checkSchedule(){
  await ensureScheduleLoaded();
  const now = getNowHHMM();
  const today = getTodayStr();
  let changed = false;

  for(const item of schedule){
    if(item.fired) continue;
    if(item.time !== now) continue;
    item.fired = true;
    changed = true;

    const iconUrl = self.location.origin + '/icon-192.png';

    try {
      await self.registration.showNotification(item.title, {
        body: item.body || 'Tap to open Menmory',
        icon: iconUrl,
        badge: iconUrl,
        tag: item.tag,
        vibrate: [200, 100, 200],
        requireInteraction: true,
        data: { url: '/' }
      });
    } catch(e) {
      try {
        await self.registration.showNotification(item.title, {
          body: item.body || 'Tap to open Menmory',
          tag: item.tag,
          vibrate: [200, 100, 200],
          requireInteraction: true,
          data: { url: '/' }
        });
      } catch(e2) {}
    }

    // Tell open tabs this fired
    const allClients = await clients.matchAll({ includeUncontrolled:true });
    for(const client of allClients){
      client.postMessage({ type:'FIRED', tag:item.tag, title:item.title, body:item.body, date:today });
    }
  }

  // Save updated fired state
  if(changed) await saveSchedule(schedule);
}

// Check every 60 seconds independently — works even when app is closed
setInterval(async () => {
  await checkSchedule();
}, 60000);

// Also check immediately on SW activation
self.addEventListener('activate', () => {
  setTimeout(checkSchedule, 2000);
});
