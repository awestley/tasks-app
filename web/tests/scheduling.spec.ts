import { test, expect } from "@playwright/test";

test("quick entry, manual correction, reminder persistence and notification settings", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Open local workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  const unique = "Order Pizza " + Date.now();
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByLabel("Task title", { exact: true })
    .fill(unique + " Friday Afternoon");
  await expect(page.locator(".parse-preview")).toContainText("15:00");
  await expect(page.locator(".parse-preview")).toContainText(
    "Reminder: at due time",
  );
  await page.screenshot({
    path: "../docs/screenshots/quick-entry.png",
    fullPage: true,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add task", exact: true })
    .click();
  await page.getByLabel("Search tasks").fill(unique);
  await expect(page.locator(".task-row")).toContainText("15:00");
  await expect(page.locator(".task-row")).not.toContainText("Afternoon");
  await page.reload();
  await page.getByLabel("Search tasks").fill(unique);
  await page.locator(".task-row .task-body").click();
  await expect(page.getByLabel("Due time", { exact: true })).toHaveValue(
    "15:00",
  );
  await expect(page.getByLabel("Reminder", { exact: true })).toHaveValue("0");
  await page.getByLabel("Reminder", { exact: true }).selectOption("15");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.locator(".task-row .task-body").click();
  await expect(page.getByLabel("Reminder", { exact: true })).toHaveValue("15");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await page.getByLabel("Clear search").click();
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Call tomorrow at 10am");
  await expect(page.locator(".parse-preview")).toContainText("10:00");
  await page.getByRole("button", { name: "Use details and edit" }).click();
  await expect(page.getByLabel("Task title", { exact: true })).toHaveValue(
    "Call",
  );
  await page.getByLabel("Due time", { exact: true }).fill("11:30");
  await expect(page.getByLabel("Due time", { exact: true })).toHaveValue(
    "11:30",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "../docs/screenshots/reminder-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Open navigation").click();
  await page
    .getByRole("button", { name: "Settings & integrations", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reminders & notifications" }),
  ).toBeVisible();
  await expect(page.locator(".push-settings")).toContainText(
    /configured|Enable on this browser|does not expose/,
  );
  expect(errors).toEqual([]);
});

test("service worker prepares the notification and task link", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const handlers: Record<string, (event: unknown) => void> = {};
  let notification:
    | {
        title: string;
        options: Record<string, unknown> & { timestamp?: number };
      }
    | undefined;
  let opened = "";
  let pending: Promise<unknown> = Promise.resolve();
  runInNewContext(await readFile("public/sw.js", "utf8"), {
    URL,
    self: {
      location: { origin: "https://tasks.example.com" },
      addEventListener: (name: string, handler: (event: unknown) => void) => {
        handlers[name] = handler;
      },
      registration: {
        showNotification: async (
          title: string,
          options: NonNullable<typeof notification>["options"],
        ) => {
          notification = { title, options };
        },
      },
    },
    clients: {
      matchAll: async () => [],
      openWindow: async (url: string) => {
        opened = url;
      },
    },
  });
  handlers.push({
    data: {
      json: () => ({
        title: "Task reminder",
        body: "Order pizza",
        task_id: "test/task",
        tag: "delivery",
      }),
    },
    waitUntil: (promise: Promise<unknown>) => {
      pending = promise;
    },
  });
  await pending;
  expect(typeof notification?.options.timestamp).toBe("number");
  delete notification?.options.timestamp;
  expect(notification).toEqual({
    title: "Task reminder",
    options: {
      body: "Order pizza",
      tag: "delivery",
      icon: "/icon-192.png",
      renotify: true,
      silent: false,
      data: { task_id: "test/task", url: undefined },
    },
  });
  handlers.notificationclick({
    notification: { data: { task_id: "test/task" }, close: () => {} },
    waitUntil: (promise: Promise<unknown>) => {
      pending = promise;
    },
  });
  await pending;
  expect(opened).toBe("https://tasks.example.com/?task=test%2Ftask");
});

test("service worker shows task actions, runs them and clears stale notifications", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const requests: { url: string; method: string; body?: string }[] = [];
  const badges: number[] = [];
  const closed: string[] = [];
  const messages: unknown[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  const waitUntil = (promise: Promise<unknown>) => {
    pending = promise;
  };
  runInNewContext(await readFile("public/sw.js", "utf8"), {
    URL,
    JSON,
    fetch: async (
      url: string,
      init: { method?: string; body?: string } = {},
    ) => {
      requests.push({ url, method: init.method || "GET", body: init.body });
      return {
        ok: true,
        json: async () => ({ id: "abc", version: 4, completed: false }),
      };
    },
    self: {
      location: { origin: "https://tasks.example.com" },
      navigator: {
        setAppBadge: async (count: number) => badges.push(count),
        clearAppBadge: async () => badges.push(0),
      },
      addEventListener: (name: string, handler: (event: unknown) => void) => {
        handlers[name] = handler;
      },
      registration: {
        showNotification: async (
          title: string,
          options: Record<string, unknown>,
        ) => {
          shown.push({ title, options });
        },
        getNotifications: async () =>
          ["abc", "done"].map((id) => ({
            data: { task_id: id },
            close: () => closed.push(id),
          })),
      },
    },
    clients: {
      matchAll: async () => [{ postMessage: (m: unknown) => messages.push(m) }],
      openWindow: async () => {},
    },
  });
  handlers.push({
    data: {
      json: () => ({
        title: "Pay rent",
        subtitle: "Home",
        body: "Due 15:00",
        task_id: "abc",
        kind: "reminder",
        tag: "task-abc",
        badge: 3,
        url: "/?task=abc",
        actions: true,
      }),
    },
    waitUntil,
  });
  await pending;
  expect(shown[0].title).toBe("Pay rent");
  expect(shown[0].options.body).toBe("Home · Due 15:00");
  expect(shown[0].options.actions).toEqual([
    { action: "complete", title: "Complete" },
    { action: "snooze", title: "Snooze 15 min" },
  ]);
  expect(badges).toEqual([3]);
  const click = (action: string) =>
    handlers.notificationclick({
      action,
      notification: {
        data: { task_id: "abc", url: "/?task=abc" },
        close: () => {},
      },
      waitUntil,
    });
  click("complete");
  await pending;
  expect(requests.slice(-2)).toEqual([
    { url: "/api/v1/tasks/abc", method: "GET", body: undefined },
    {
      url: "/api/v1/tasks/abc/complete",
      method: "POST",
      body: JSON.stringify({ version: 4 }),
    },
  ]);
  click("snooze");
  await pending;
  expect(requests.at(-1)).toEqual({
    url: "/api/v1/tasks/abc/snooze",
    method: "POST",
    body: JSON.stringify({ minutes: 15 }),
  });
  expect(messages).toEqual([
    { type: "tasks-changed" },
    { type: "tasks-changed" },
  ]);
  // The summary is quiet and has no actions.
  handlers.push({
    data: {
      json: () => ({
        title: "Today",
        body: "2 due today",
        kind: "summary",
        tag: "summary",
        actions: false,
      }),
    },
    waitUntil,
  });
  await pending;
  expect(shown[1].options.silent).toBe(true);
  expect(shown[1].options.actions).toBeUndefined();
  handlers.message({
    data: { type: "open-tasks", ids: ["abc"], badge: 0 },
    waitUntil,
  });
  await pending;
  expect(closed).toEqual(["done"]);
  expect(badges.at(-1)).toBe(0);
});

test("snooze, alert style and notification settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open local workspace" }).click();
  const title = "Snooze me " + Date.now();
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel("Task title", { exact: true }).fill(title);
  await page.getByLabel("Detect dates, times and details").uncheck();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add task", exact: true })
    .click();
  await page.getByLabel("Search tasks").fill(title);
  const row = page.locator(".task-row", { hasText: title });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Snooze" }).click();
  await page.getByRole("menuitem", { name: "1 hour", exact: true }).click();
  await expect(row).toContainText("Snoozed until");
  // Settings persist on the server.
  await page
    .getByRole("button", { name: "Settings & integrations", exact: true })
    .click();
  await page.getByLabel("Morning summary").check();
  await page.getByLabel("Overdue follow-up").selectOption("60");
  await expect(page.getByLabel("Summary time")).toHaveValue("08:00");
  await page.reload();
  await page
    .getByRole("button", { name: "Settings & integrations", exact: true })
    .click();
  await expect(page.getByLabel("Overdue follow-up")).toHaveValue("60");
  await expect(page.getByLabel("Morning summary")).toBeChecked();
  await page.getByLabel("Morning summary").uncheck();
  await page.getByLabel("Overdue follow-up").selectOption("");
});
