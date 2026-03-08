// FlowNotes Service Worker v3
// Receives schedule from main page, fires notifications independently

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// ── Notification click → open / focus app ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
      for(const c of list){ if(c.url && 'focus' in c) return c.focus(); }
      return clients.openWindow('/');
    })
  );
});

// ── Schedule storage ──
let schedule = []; // [{ tag, time, title, body, fired }]

self.addEventListener('message', e => {
  if(!e.data) return;
  if(e.data.type === 'SCHEDULE'){
    schedule = e.data.schedule || [];
  }
  if(e.data.type === 'PING'){
    checkSchedule();
  }
});

function getNowHHMM(){
  const n = new Date();
  return String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
}

function todayStr(){
  return new Date().toISOString().split('T')[0];
}

async function checkSchedule(){
  const now = getNowHHMM();
  const today = todayStr();

  for(const item of schedule){
    if(item.fired) continue;
    if(item.time !== now) continue;

    item.fired = true;

    const icon = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%231a6b3c'/><text y='.9em' font-size='72' x='12'>📚</text></svg>";

    await self.registration.showNotification(item.title, {
      body: item.body || 'Tap to open FlowNotes',
      icon: icon,
      badge: icon,
      tag: item.tag,
      vibrate: [200, 100, 200],
      requireInteraction: false,
      data: { url: '/' }
    });

    // Tell the open tab this fired
    const allClients = await clients.matchAll({ includeUncontrolled:true });
    for(const client of allClients){
      client.postMessage({ type:'FIRED', tag:item.tag, title:item.title, body:item.body, date:today });
    }
  }
}

// Check every 30 seconds
setInterval(checkSchedule, 15000);
