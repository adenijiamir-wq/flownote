// FlowNotes Service Worker v3

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

let schedule = [];

self.addEventListener('message', e => {
  if(!e.data) return;
  if(e.data.type === 'SCHEDULE') schedule = e.data.schedule || [];
  if(e.data.type === 'PING') checkSchedule();
});

function getNowHHMM(){
  const n = new Date();
  return String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
}

async function checkSchedule(){
  const now = getNowHHMM();
  const today = new Date().toISOString().split('T')[0];

  for(const item of schedule){
    if(item.fired) continue;
    if(item.time !== now) continue;
    item.fired = true;

    // Use absolute URL for icon — data: URIs are blocked on Android
    const iconUrl = self.location.origin + '/icon-192.png';

    try {
      await self.registration.showNotification(item.title, {
        body: item.body || 'Tap to open FlowNotes',
        icon: iconUrl,
        badge: iconUrl,
        tag: item.tag,
        vibrate: [200, 100, 200],
        requireInteraction: false,
        data: { url: '/' }
      });
    } catch(e) {
      // icon missing — retry without icon
      await self.registration.showNotification(item.title, {
        body: item.body || 'Tap to open FlowNotes',
        tag: item.tag,
        vibrate: [200, 100, 200],
        requireInteraction: false,
        data: { url: '/' }
      });
    }

    // Tell open tabs this fired
    const allClients = await clients.matchAll({ includeUncontrolled:true });
    for(const client of allClients){
      client.postMessage({ type:'FIRED', tag:item.tag, title:item.title, body:item.body, date:today });
    }
  }
}

setInterval(checkSchedule, 15000);
