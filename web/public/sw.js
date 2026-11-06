// Tasks service worker: reminders (push and the app's own), the Complete action on a reminder, and
// the app's files for offline use. Task data is never cached here; the app keeps its own replica.
const CACHE = 'tasks-app-v1';
const scope = () => new URL(self.registration?.scope || self.location.origin + '/');

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    .then(cache => cache.addAll(['./', './companion.html', './embed.js'].map(p => new URL(p, scope()).href)))
    .catch(() => {})
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('tasks-app-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const base = scope();
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  const path = url.pathname.slice(base.pathname.length);
  if (/^api\/v1\/(search|resolve)\b/.test(path)) {
    // The shell's cross-app search and embeds: say "offline" plainly rather than failing (search.md).
    event.respondWith(fetch(request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    })));
    return;
  }
  if (/^(api|auth|mcp|docs|openapi)/.test(path) || path === 'manifest.json') return;
  if (path.startsWith('assets/') || path === 'embed.js') {
    // Hashed build files never change: cache first.
    event.respondWith(caches.match(request).then(hit => hit || fetch(request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(request, copy)); }
      return res;
    })));
    return;
  }
  if (request.mode === 'navigate' || /\.(html|js|svg|png|webmanifest)$/.test(path) || path === '') {
    // Network first, so a deploy shows at once; the cache is the offline copy.
    const key = request.mode === 'navigate' ? new URL(path.startsWith('companion') ? 'companion.html' : './', base).href : request;
    event.respondWith(fetch(request).then(res => {
      if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then(hit => hit || Response.error())));
  }
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch { /* Always show a visible notification. */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Task reminder', {
    body: data.body || 'A task is due.', tag: data.tag || 'taskwell-reminder',
    icon: new URL('icon-192.png', scope()).href, data: { task_id: data.task_id },
    actions: [{ action: 'complete', title: 'Complete' }],
  }));
});

async function completeTask(id) {
  const api = new URL('api/v1/tasks/' + encodeURIComponent(id), scope()).href;
  const current = await fetch(api, { credentials: 'same-origin' });
  if (!current.ok) throw new Error('read failed');
  const task = await current.json();
  if (task.completed) return;
  const done = await fetch(api, {
    method: 'PATCH', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: task.version, completed: true }),
  });
  if (!done.ok) throw new Error('update failed');
}

function openTask(task) {
  // Inside the shell (served under /apps/), open the task in a column there; on its own, in the app.
  const base = scope();
  const url = base.pathname.startsWith('/apps/')
    ? new URL(task ? '/?open=' + encodeURIComponent('pc://tasks/task/' + task) : '/', base.origin).href
    : new URL(task ? '?task=' + encodeURIComponent(task) : '', base).href;
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin && client.frameType !== 'nested');
    if (existing) {
      try { await existing.navigate(url); return existing.focus(); } catch { /* not ours to navigate */ }
    }
    return clients.openWindow(url);
  });
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const task = event.notification.data?.task_id;
  if (event.action === 'complete' && task) {
    // Complete without opening anything; open the task if that fails (signed out, offline).
    event.waitUntil(completeTask(task)
      .then(() => clients.matchAll({ includeUncontrolled: true }).then(all => all.forEach(c => c.postMessage({ type: 'tasks-changed' }))))
      .catch(() => openTask(task)));
    return;
  }
  event.waitUntil(openTask(task));
});
