self.addEventListener('message', async e => {
  if (!e.data) return;
  if (e.data.type === 'SCHEDULE') {
    schedule = e.data.schedule || [];
    scheduleLoaded = true;
    await saveSchedule(schedule);
  }
  if (e.data.type === 'PING') { await ensureScheduleLoaded(); checkSchedule(); }

  // ── Timer notifications ──
  if (e.data.type === 'TIMER_TICK') {
    self.registration.showNotification(e.data.title, {
      body: e.data.body || 'Menmory timer running',
      icon: self.location.origin + '/icon-192.png',
      tag: 'menmory-timer',
      silent: true,
      renotify: false
    });
  }
  if (e.data.type === 'CLEAR_TIMER') {
    const notifs = await self.registration.getNotifications({ tag: 'menmory-timer' });
    notifs.forEach(n => n.close());
  }
});
