import { test, expect } from "@playwright/test";

test("quick add parses as you type, corrections, reminders and notification settings", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Open local workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();

  // Q opens quick add; the date and time light up as they are typed.
  const unique = "Order Pizza " + Date.now();
  await page.keyboard.press("q");
  const dialog = page.getByRole("dialog", { name: "Add task" });
  const input = dialog.getByLabel("Task name");
  await expect(input).toBeFocused();
  await input.fill(unique + " Friday Afternoon");
  await expect(dialog.locator(".qa-backdrop .tok-date")).toHaveText("Friday");
  await expect(dialog.locator(".qa-backdrop .tok-time")).toHaveText(
    "Afternoon",
  );
  await expect(
    dialog.getByRole("button", { name: "Date", exact: true }),
  ).toContainText("3:00 PM");
  await expect(
    dialog.getByRole("button", { name: "Reminder", exact: true }),
  ).toContainText("At time");
  await page.screenshot({
    path: "../docs/screenshots/quick-entry.png",
    fullPage: true,
  });
  // Enter adds and keeps the field ready for the next task.
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByLabel("Search tasks").fill(unique);
  await expect(page.locator(".task-row")).toContainText("3:00 PM");
  await expect(page.locator(".task-row")).not.toContainText("Afternoon");

  // The reminder and time persist.
  await page.reload();
  await page.getByLabel("Search tasks").fill(unique);
  await page.locator(".task-row .task-body").click();
  await expect(page.getByLabel("Reminder", { exact: true })).toHaveValue("0");
  await page.getByLabel("Due date", { exact: true }).click();
  await expect(page.getByLabel("Due time", { exact: true })).toHaveValue(
    "15:00",
  );
  await page.keyboard.press("Escape");
  await page.getByLabel("Reminder", { exact: true }).selectOption("15");
  await page.reload();
  await page.getByLabel("Search tasks").fill(unique);
  await page.locator(".task-row .task-body").click();
  await expect(page.getByLabel("Reminder", { exact: true })).toHaveValue("15");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await page.getByLabel("Clear search").click();

  // Clicking a highlighted word keeps it as plain text, and the date picker corrects the time.
  await page.keyboard.press("q");
  await input.fill("Call tomorrow at 10am");
  await expect(dialog.locator(".qa-backdrop .tok-time")).toHaveText("at 10am");
  const word = (await dialog.locator(".qa-backdrop .tok-date").boundingBox())!;
  await page.mouse.click(word.x + word.width / 2, word.y + word.height / 2);
  await expect(dialog.locator(".qa-backdrop .tok-date")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Date", exact: true }),
  ).toContainText("10:00 AM");
  await dialog.getByRole("button", { name: "Date", exact: true }).click();
  await page.getByLabel("Due time", { exact: true }).fill("11:30");
  await page.keyboard.press("Escape");
  await expect(
    dialog.getByRole("button", { name: "Date", exact: true }),
  ).toContainText("11:30 AM");
  await expect(input).toHaveValue(/^Call tomorrow\s*$/);

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
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
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

test("service worker shows reminders, opens the task and completes from the notification", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const handlers: Record<string, (event: unknown) => void> = {};
  let notification:
    { title: string; options: Record<string, unknown> } | undefined;
  let opened = "";
  const sent: { url: string; method: string; body?: string }[] = [];
  const posted: unknown[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  const waitUntil = (promise: Promise<unknown>) => {
    pending = promise;
  };
  runInNewContext(await readFile("public/sw.js", "utf8"), {
    URL,
    JSON,
    encodeURIComponent,
    self: {
      location: { origin: "https://tasks.example.com" },
      addEventListener: (name: string, handler: (event: unknown) => void) => {
        handlers[name] = handler;
      },
      registration: {
        showNotification: async (
          title: string,
          options: Record<string, unknown>,
        ) => {
          notification = { title, options };
        },
      },
    },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      sent.push({ url, method: init?.method || "GET", body: init?.body });
      return {
        ok: true,
        json: async () => ({ id: "t1", version: 3, completed: false }),
      };
    },
    clients: {
      matchAll: async () => [
        {
          url: "https://elsewhere.example.com/",
          postMessage: (m: unknown) => posted.push(m),
        },
      ],
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
        tag: "reminder-test-1",
      }),
    },
    waitUntil,
  });
  await pending;
  expect(notification).toEqual({
    title: "Task reminder",
    options: {
      body: "Order pizza",
      tag: "reminder-test-1",
      icon: "https://tasks.example.com/icon-192.png",
      data: { task_id: "test/task" },
      actions: [{ action: "complete", title: "Complete" }],
    },
  });

  // Clicking the notification opens the task.
  handlers.notificationclick({
    notification: { data: { task_id: "test/task" }, close: () => {} },
    waitUntil,
  });
  await pending;
  expect(opened).toBe("https://tasks.example.com/?task=test%2Ftask");

  // The Complete button completes it without opening anything.
  opened = "";
  handlers.notificationclick({
    action: "complete",
    notification: { data: { task_id: "t1" }, close: () => {} },
    waitUntil,
  });
  await pending;
  expect(sent.at(-1)).toEqual({
    url: "https://tasks.example.com/api/v1/tasks/t1",
    method: "PATCH",
    body: JSON.stringify({ version: 3, completed: true }),
  });
  expect(posted).toEqual([{ type: "tasks-changed" }]);
  expect(opened).toBe("");
});
