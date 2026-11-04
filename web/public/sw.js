self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch { /* Always show a visible notification. */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Task reminder', {
    body: data.body || 'A task is due.', tag: data.tag || 'taskwell-reminder',
    icon: '/icon-192.png', data: { task_id: data.task_id },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const task = event.notification.data?.task_id;
  const url = new URL(task ? '/?task=' + encodeURIComponent(task) : '/', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(url); return existing.focus(); }
    return clients.openWindow(url);
  }));
});
