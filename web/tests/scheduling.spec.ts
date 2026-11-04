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
        options: { body: string; tag: string; data: { task_id: string } };
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
  expect(notification).toEqual({
    title: "Task reminder",
    options: {
      body: "Order pizza",
      tag: "delivery",
      icon: "/icon-192.png",
      data: { task_id: "test/task" },
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
