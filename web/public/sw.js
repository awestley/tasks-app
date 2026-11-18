// Tasks service worker: reminders (push and the app's own), Complete and Snooze on a reminder, and
// the app's files for offline use. Task data is never cached here; the app keeps its own replica.
const CACHE = 'tasks-app-v1';
// Hashed files kept for offline use. Each deploy adds new ones, and the oldest make way.
const ASSET_LIMIT = 60;
const scope = () => new URL(self.registration?.scope || self.location.origin + '/');

async function keepAsset(request, response) {
  const cache = await caches.open(CACHE);
  await cache.put(request, response);
  const prefix = scope().pathname + 'assets/';
  const assets = (await cache.keys()).filter(r => new URL(r.url).pathname.startsWith(prefix));
  await Promise.all(assets.slice(0, -ASSET_LIMIT).map(r => cache.delete(r)));
}

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
  if (path.startsWith('assets/')) {
    // Hashed build files never change: cache first.
    event.respondWith(caches.match(request).then(hit => hit || fetch(request).then(res => {
      if (res.ok) event.waitUntil(keepAsset(request, res.clone()));
      return res;
    })));
    return;
  }
  if (request.mode === 'navigate' || /\.(html|js|svg|png|webmanifest)$/.test(path) || path === '') {
    // Network first, so a deploy shows at once; the cache is the offline copy. This includes embed.js,
    // whose name stays the same across deploys because other apps load it.
    const key = request.mode === 'navigate' ? new URL(path.startsWith('companion') ? 'companion.html' : './', base).href : request;
    event.respondWith(fetch(request).then(res => {
      if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then(hit => hit || Response.error())));
  }
});

function setBadge(count) {
  if (typeof count !== 'number' || !self.navigator?.setAppBadge) return Promise.resolve();
  return (count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge()).catch(() => {});
}

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch { /* Always show a visible notification. */ }
  const body = data.subtitle ? `${data.subtitle} · ${data.body || ''}` : data.body || 'A task is due.';
  const options = {
    body, tag: data.tag || 'tasks-reminder',
    icon: new URL('icon-192.png', scope()).href, data: { task_id: data.task_id },
    // Replacing an earlier notification for the same task should still alert. The summary arrives quietly.
    renotify: Boolean(data.tag), silent: data.kind === 'summary',
  };
  // Older servers send no actions flag; every reminder from them is about a task.
  if (data.task_id && data.actions !== false) {
    options.actions = [{ action: 'complete', title: 'Complete' }, { action: 'snooze', title: 'Snooze 15 min' }];
  }
  event.waitUntil(Promise.all([self.registration.showNotification(data.title || 'Task reminder', options), setBadge(data.badge)]));
});

async function snoozeTask(id) {
  const api = new URL('api/v1/tasks/' + encodeURIComponent(id) + '/snooze', scope()).href;
  const done = await fetch(api, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes: 15 }),
  });
  if (!done.ok) throw new Error('snooze failed');
}

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
  if ((event.action === 'complete' || event.action === 'snooze') && task) {
    // Act without opening anything; open the task if that fails (signed out, offline).
    const action = event.action === 'complete' ? completeTask(task) : snoozeTask(task);
    event.waitUntil(action
      .then(() => clients.matchAll({ includeUncontrolled: true }).then(all => all.forEach(c => c.postMessage({ type: 'tasks-changed' }))))
      .catch(() => openTask(task)));
    return;
  }
  event.waitUntil(openTask(task));
});

// The page sends the IDs of open tasks, so notifications for tasks finished elsewhere can be removed.
self.addEventListener('message', event => {
  if (event.data?.type !== 'open-tasks') return;
  const open = new Set(event.data.ids || []);
  event.waitUntil(self.registration.getNotifications().then(list => {
    list.forEach(notification => {
      const task = notification.data?.task_id;
      if (task && !open.has(task)) notification.close();
    });
    return setBadge(event.data.badge);
  }));
});
