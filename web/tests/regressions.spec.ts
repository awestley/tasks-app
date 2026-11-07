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
