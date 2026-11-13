// Take control of open pages now, including the tab that just enabled notifications.
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

const TASK_ACTIONS = [
  { action: "complete", title: "Complete" },
  { action: "snooze", title: "Snooze 15 min" },
];

function setBadge(count) {
  if (typeof count !== "number" || !self.navigator?.setAppBadge)
    return Promise.resolve();
  return (
    count > 0
      ? self.navigator.setAppBadge(count)
      : self.navigator.clearAppBadge()
  ).catch(() => {});
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch {
    /* Always show a visible notification. */
  }
  const body = data.subtitle
    ? `${data.subtitle} · ${data.body || ""}`
    : data.body || "A task is due.";
  const options = {
    body,
    tag: data.tag || "tasks-reminder",
    icon: "/icon-192.png",
    // Replacing an earlier notification for the same task should still alert.
    renotify: Boolean(data.tag),
    silent: data.kind === "summary",
    timestamp: Date.now(),
    data: { task_id: data.task_id, url: data.url },
  };
  if (data.actions && data.task_id) options.actions = TASK_ACTIONS;
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(
        data.title || "Task reminder",
        options,
      ),
      setBadge(data.badge),
    ]),
  );
});

async function taskRequest(path, body) {
  const response = await fetch("/api/v1/tasks/" + path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("Request failed: " + response.status);
  return response.json();
}

async function runAction(action, task) {
  const id = encodeURIComponent(task);
  if (action === "snooze") return taskRequest(id + "/snooze", { minutes: 15 });
  // Completing needs the current version. Retry once if another device changed the task meanwhile.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await fetch("/api/v1/tasks/" + id, {
      credentials: "same-origin",
    });
    if (!current.ok) throw new Error("Request failed: " + current.status);
    const value = await current.json();
    if (value.completed) return value;
    try {
      return await taskRequest(id + "/complete", { version: value.version });
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function openPage(target) {
  const url = new URL(target, self.location.origin).href;
  const windows = await clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const existing = windows.find(
    (client) => new URL(client.url).origin === self.location.origin,
  );
  if (!existing) return clients.openWindow(url);
  try {
    await existing.navigate(url);
    return existing.focus();
  } catch {
    // navigate() rejects for a window this worker does not control.
    return clients.openWindow(url);
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { task_id: task, url } = event.notification.data || {};
  const target = url || (task ? "/?task=" + encodeURIComponent(task) : "/");
  if (task && (event.action === "complete" || event.action === "snooze")) {
    event.waitUntil(
      runAction(event.action, task)
        .then(() => clients.matchAll({ type: "window" }))
        .then((windows) =>
          windows.forEach((client) =>
            client.postMessage({ type: "tasks-changed" }),
          ),
        )
        // Signed out or offline: open the task so the change can be made there.
        .catch(() => openPage(target)),
    );
    return;
  }
  event.waitUntil(openPage(target));
});

// The page sends the IDs of open tasks, so notifications for tasks finished elsewhere can be removed.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "open-tasks") return;
  const open = new Set(event.data.ids || []);
  event.waitUntil(
    self.registration.getNotifications().then((list) => {
      list.forEach((notification) => {
        const task = notification.data?.task_id;
        if (task && !open.has(task)) notification.close();
      });
      return setBadge(event.data.badge);
    }),
  );
});
