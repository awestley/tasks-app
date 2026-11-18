import { expect, test, type Page } from "@playwright/test";

const prefix = `Regression ${Date.now()}`;
const headers = (page: Page) => ({ Origin: new URL(page.url()).origin });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Open local workspace/ }).click();
  await expect(page.locator(".quick-add")).toBeVisible();
}
async function create(page: Page, data: Record<string, unknown>) {
  const response = await page.request.post("api/v1/tasks", {
    headers: headers(page),
    data,
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function matching(page: Page, title: string) {
  const response = await page.request.get("api/v1/tasks?limit=200");
  const tasks = await response.json();
  return tasks.filter((t: { title: string }) => t.title === title);
}
async function cleanUp(page: Page) {
  const response = await page.request.get("api/v1/tasks?limit=200");
  for (const task of await response.json())
    if (task.title.startsWith(prefix))
      await page.request.delete(
        `api/v1/tasks/${task.id}?version=${task.version}`,
        { headers: headers(page) },
      );
}
const inbox = (page: Page) =>
  page.locator(".sidebar nav button", { hasText: "Inbox" }).click();
const endSession = (page: Page) =>
  page.request.post("auth/logout", { headers: headers(page) });

test("Holding a shortcut acts once but still moves through the list", async ({
  page,
}) => {
  await signIn(page);
  const title = `${prefix} hold`;
  await create(page, { title });
  await page.reload();
  await inbox(page);
  await page.locator(".task-body", { hasText: title }).hover();
  // Playwright marks repeated key downs as key repeat.
  await page.keyboard.down("d");
  await page.keyboard.down("d");
  await page.keyboard.down("d");
  await page.keyboard.up("d");
  await expect.poll(async () => (await matching(page, title)).length).toBe(2);
  await page.waitForTimeout(400);
  expect((await matching(page, title)).length).toBe(2);
  await cleanUp(page);
});

test("An edit made after another device's change keeps both", async ({
  page,
}) => {
  await signIn(page);
  const title = `${prefix} merge`;
  const task = await create(page, { title });
  await page.reload();
  await inbox(page);
  await page.locator(".task-body", { hasText: title }).click();
  const details = page.getByLabel("Task details");
  await expect(details.getByLabel("Description")).toBeVisible();
  const changed = await page.request.patch(`api/v1/tasks/${task.id}`, {
    headers: headers(page),
    data: { version: task.version, priority: 2 },
  });
  expect(changed.status()).toBe(200);
  await details.getByLabel("Description").fill("Written on this device");
  await details.getByLabel("Description").blur();
  await expect
    .poll(async () => (await matching(page, title))[0].description)
    .toBe("Written on this device");
  expect((await matching(page, title))[0].priority).toBe(2);
  await cleanUp(page);
});

test("An ended session returns to sign-in from an action or from sign out", async ({
  page,
}) => {
  await signIn(page);
  const title = `${prefix} session`;
  await create(page, { title });
  await page.reload();
  await inbox(page);
  await endSession(page);
  await page.getByRole("button", { name: `Complete ${title}` }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await signIn(page);
  // Sent again now, and its own change event refreshes the list: let that finish.
  await expect(page.locator(".sync-status")).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Open settings" }).click();
  await endSession(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await signIn(page);
  await cleanUp(page);
});

test("Changes not yet sent survive a session that ended", async ({ page }) => {
  await signIn(page);
  const title = `${prefix} unsent`;
  await page.locator(".quick-add").click();
  await endSession(page);
  const input = page.getByRole("dialog").getByLabel("Task name");
  await input.fill(title);
  await input.press("Enter");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: /Open local workspace/ }).click();
  await expect(page.locator(".quick-add")).toBeVisible();
  await expect.poll(async () => (await matching(page, title)).length).toBe(1);
  await cleanUp(page);
});

test("A refused Apple account is told why, once", async ({ page }) => {
  await page.goto("/?auth_error=denied");
  await expect(page.getByRole("alert")).toContainText(
    "This Apple account is not allowed on this server.",
  );
  expect(new URL(page.url()).search).toBe("");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Upcoming shows the year outside this one, in date order", async ({
  page,
}) => {
  await signIn(page);
  await create(page, { title: `${prefix} later`, due_date: "2099-12-25" });
  await create(page, { title: `${prefix} earlier`, due_date: "2098-12-25" });
  await page.reload();
  await page.locator(".sidebar nav button", { hasText: "Upcoming" }).click();
  // Sorting by name must not put the dates out of order.
  await page.getByLabel("Sort tasks").selectOption("name");
  const headings = await page.locator(".group-title").allTextContents();
  expect(headings.map((h) => /2098|2099/.exec(h)?.[0]).filter(Boolean)).toEqual(
    ["2098", "2099"],
  );
  await page.getByLabel("Sort tasks").selectOption("smart");
  await cleanUp(page);
});

test("A project deleted elsewhere returns to Inbox", async ({ page }) => {
  await signIn(page);
  const name = `${prefix} project`;
  const project = await (
    await page.request.post("api/v1/projects", {
      headers: headers(page),
      data: { name },
    })
  ).json();
  await page.reload();
  await page.locator(".sidebar nav button", { hasText: name }).click();
  // The heading starts with the project's # mark.
  await expect(page.locator(".page-title h1", { hasText: name })).toBeVisible();
  await page.request.delete(`api/v1/projects/${project.id}`, {
    headers: headers(page),
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
});

test("Refreshing downloads tasks only after they change", async ({ page }) => {
  await signIn(page);
  const downloads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/tasks?")) downloads.push(r.url());
  });
  const focus = async () => {
    const done = page.waitForResponse((r) =>
      r.url().endsWith("/api/v1/tasks/revision"),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await done;
    await page.waitForTimeout(300);
  };
  await focus();
  downloads.length = 0;
  await focus();
  await focus();
  expect(downloads).toEqual([]);
  const title = `${prefix} changed`;
  await create(page, { title });
  await focus();
  expect(downloads.length).toBeGreaterThan(0);
  await inbox(page);
  await expect(page.locator(".task-body", { hasText: title })).toBeVisible();
  await cleanUp(page);
});

test("Another device's session can be ended from Settings", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signIn(other);
  await page.getByRole("button", { name: "Open settings" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("This device")).toBeVisible();
  // Newest first, so the first session that can be ended is the one just created.
  await dialog.getByRole("button", { name: "End session" }).first().click();
  await expect
    .poll(async () => (await other.request.get("api/v1/me")).status())
    .toBe(401);
  expect((await page.request.get("api/v1/me")).status()).toBe(200);
  await otherContext.close();
});

test("A reminder fires on time, but not if it was already past when saved", async ({
  page,
}) => {
  await signIn(page);
  const pad = (n: number) => String(n).padStart(2, "0");
  const parts = (d: Date) => ({
    due_date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    due_time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    time_zone: "UTC",
    reminder_minutes: 0,
  });
  const late = `${prefix} late`;
  const ontime = `${prefix} on time`;
  await create(page, {
    title: late,
    ...parts(new Date(Date.now() - 5 * 60000)),
  });
  const due = new Date(Date.now() + 2 * 60000);
  await create(page, { title: ontime, ...parts(due) });
  const toast = page.locator(".toast");
  await page.reload();
  await expect(page.locator(".quick-add")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(toast.filter({ hasText: late })).toHaveCount(0);
  // Two minutes later, by the page's clock.
  await page.clock.install({ time: new Date(due.getTime() + 60000) });
  await page.reload();
  await expect(toast.filter({ hasText: ontime })).toBeVisible();
  await expect(toast.filter({ hasText: late })).toHaveCount(0);
  await cleanUp(page);
});

async function addTask(page: Page, title: string) {
  await page.locator(".quick-add").click();
  const input = page.getByRole("dialog").getByLabel("Task name");
  await input.fill(title);
  await input.press("Enter");
  await page.keyboard.press("Escape");
}

test("A server error keeps a change and sends it later", async ({ page }) => {
  await signIn(page);
  await inbox(page);
  const title = `${prefix} server error`;
  let failed = false;
  await page.route("**/api/v1/tasks", async (route) => {
    if (route.request().method() === "POST" && !failed) {
      failed = true;
      await route.fulfill({ status: 500, body: "Internal Server Error" });
    } else await route.continue();
  });
  await addTask(page, title);
  await expect(page.locator(".sync-status")).toContainText(
    "Server problem · 1 change will sync",
  );
  await expect(page.locator(".task-body", { hasText: title })).toBeVisible();
  expect(await matching(page, title)).toHaveLength(0);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await matching(page, title)).length).toBe(1);
  await expect(page.locator(".sync-status")).toHaveCount(0);
  await cleanUp(page);
});

test("A change is still sent when browser storage is full", async ({
  page,
}) => {
  await signIn(page);
  await inbox(page);
  await page.evaluate(() => {
    let size = 1024 * 1024;
    let i = 0;
    while (size >= 1) {
      try {
        localStorage.setItem("test.fill." + i++, "x".repeat(size));
      } catch {
        size = Math.floor(size / 2);
      }
    }
  });
  const title = `${prefix} full storage`;
  await addTask(page, title);
  await expect.poll(async () => (await matching(page, title)).length).toBe(1);
  await expect(page.locator(".task-body", { hasText: title })).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await cleanUp(page);
});

test("Live updates start right after a fresh sign-in", async ({ page }) => {
  const streams: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/events")) streams.push(r.url());
  });
  await signIn(page);
  await inbox(page);
  await expect.poll(() => streams.length).toBe(1);
  const title = `${prefix} live`;
  await create(page, { title });
  await expect(page.locator(".task-body", { hasText: title })).toBeVisible();
  await cleanUp(page);
});

test("A session ended elsewhere returns to sign-in when the next change arrives", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.waitForTimeout(500);
  const context = await browser.newContext();
  const device = await context.newPage();
  await signIn(device);
  await endSession(page);
  await create(device, { title: `${prefix} after the session ended` });
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
    timeout: 15000,
  });
  await cleanUp(device);
  await context.close();
});

test("Signing out warns about changes not yet sent", async ({ page }) => {
  await signIn(page);
  await inbox(page);
  await page.route("**/api/v1/tasks", (route) =>
    route.request().method() === "POST" ? route.abort() : route.continue(),
  );
  await addTask(page, `${prefix} unsent`);
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("1 change not synced");
  await expect(page.locator(".quick-add")).toBeVisible();
  await page.getByRole("button", { name: "Sign out anyway" }).click();
  await expect(
    page.getByRole("button", { name: /Open local workspace/ }),
  ).toBeVisible();
});

test("Reminders say push is set up only when this browser is subscribed", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let permission = "default";
    let subscription: unknown = null;
    Object.defineProperty(Notification, "permission", {
      get: () => permission,
    });
    Notification.requestPermission = async () => {
      permission = "granted";
      return "granted";
    };
    PushManager.prototype.getSubscription = async () =>
      subscription as PushSubscription | null;
    PushManager.prototype.subscribe = async () => {
      const allowed = (window as unknown as { allowPush?: boolean }).allowPush;
      if (!allowed) throw new DOMException("No push service", "AbortError");
      subscription = {
        toJSON: () => ({
          endpoint: "https://fcm.googleapis.com/fcm/send/test",
          keys: { p256dh: "key", auth: "secret" },
        }),
      };
      return subscription as PushSubscription;
    };
  });
  await page.route("**/api/v1/push/config", (route) =>
    route.fulfill({
      json: {
        web_enabled: true,
        vapid_public_key:
          "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
      },
    }),
  );
  await page.route("**/api/v1/push/subscriptions", (route) =>
    route.fulfill({ json: { id: "device" } }),
  );
  await signIn(page);
  await page.locator(".bell-button").first().click();
  await page.getByRole("button", { name: "Turn on notifications" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Push could not be turned on",
  );
  await expect(page.locator(".bell-note")).not.toContainText("Push is set up");
  await page.evaluate(() => {
    (window as unknown as { allowPush?: boolean }).allowPush = true;
  });
  await page.getByRole("button", { name: "Turn on push" }).click();
  await expect(page.locator(".bell-note")).toContainText("Push is set up");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Undoing the delete of a completed task keeps it completed", async ({
  page,
}) => {
  await signIn(page);
  const title = `${prefix} undo completed`;
  const task = await create(page, { title });
  const done = await page.request.patch(`api/v1/tasks/${task.id}`, {
    headers: headers(page),
    data: { version: task.version, completed: true },
  });
  expect(done.status()).toBe(200);
  const { completed_at } = await done.json();
  await page.reload();
  await page.locator(".sidebar nav button", { hasText: "Completed" }).click();
  await page.getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Delete task" }).click();
  await page.getByRole("menuitem", { name: "Confirm delete" }).click();
  await expect.poll(async () => (await matching(page, title)).length).toBe(0);
  await page.locator(".toast-undo").click();
  await expect.poll(async () => (await matching(page, title)).length).toBe(1);
  const [restored] = await matching(page, title);
  expect(restored.completed).toBe(true);
  expect(restored.completed_at).toBe(completed_at);
  await expect(page.locator(".task-body", { hasText: title })).toBeVisible();
  await cleanUp(page);
});

test("A change made here does not download every task", async ({ page }) => {
  await signIn(page);
  await page.reload();
  await inbox(page);
  await page.waitForTimeout(500);
  const downloads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/tasks?")) downloads.push(r.url());
  });
  const checked = page.waitForResponse((r) =>
    r.url().endsWith("/api/v1/tasks/revision"),
  );
  const title = `${prefix} own change`;
  await addTask(page, title);
  await checked;
  await expect(page.locator(".sync-status")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(downloads).toEqual([]);
  await cleanUp(page);
});

test("Signing out in one tab signs out the others", async ({
  page,
  context,
}) => {
  await signIn(page);
  await inbox(page);
  const title = `${prefix} other tab`;
  await create(page, { title });
  const other = await context.newPage();
  await other.goto("/");
  await other.locator(".sidebar nav button", { hasText: "Inbox" }).click();
  await expect(other.locator(".task-body", { hasText: title })).toBeVisible();
  await cleanUp(page);
  await page.bringToFront();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    other.getByRole("button", { name: /Open local workspace/ }),
  ).toBeVisible();
  await expect(other.locator(".task-body")).toHaveCount(0);
});

test("Checklist edits on two devices both stay", async ({ page }) => {
  await signIn(page);
  await inbox(page);
  const title = `${prefix} checklist merge`;
  const first = { id: "first", title: "First", completed: false };
  const second = { id: "second", title: "Second", completed: false };
  const task = await create(page, { title, checklist: [first, second] });
  await page.reload();
  await inbox(page);
  await page.locator(".task-body", { hasText: title }).click();
  const item = page
    .getByLabel("Task details")
    .getByLabel("Checklist item 1", { exact: true });
  await item.click();
  // While this device edits the first item, another ticks the second and adds a third.
  const changed = await page.request.patch(`api/v1/tasks/${task.id}`, {
    headers: headers(page),
    data: {
      version: task.version,
      checklist: [
        first,
        { ...second, completed: true },
        { id: "third", title: "Third", completed: false },
      ],
    },
  });
  expect(changed.status()).toBe(200);
  await item.fill("First, edited");
  await item.blur();
  await expect
    .poll(async () =>
      (await matching(page, title))[0].checklist.map(
        (i: { title: string; completed: boolean }) => [i.title, i.completed],
      ),
    )
    .toEqual([
      ["First, edited", false],
      ["Second", true],
      ["Third", false],
    ]);
  await cleanUp(page);
});
