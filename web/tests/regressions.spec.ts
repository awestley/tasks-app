import { expect, test, type Page } from "@playwright/test";

const titlePrefix = `Regression ${Date.now()}`;
const headers = (page: Page) => ({ Origin: new URL(page.url()).origin });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Open local workspace/ }).click();
  await expect(page.locator(".quick-add")).toBeVisible();
}
async function create(page: Page, title: string) {
  const response = await page.request.post("/api/v1/tasks", {
    headers: headers(page),
    data: { title },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
async function matching(page: Page, title: string) {
  const response = await page.request.get("/api/v1/tasks?limit=200");
  const tasks = await response.json();
  return tasks.filter((t: { title: string }) => t.title === title);
}
async function cleanUp(page: Page) {
  const response = await page.request.get("/api/v1/tasks?limit=200");
  for (const task of await response.json())
    if (task.title.startsWith(titlePrefix))
      await page.request.delete(
        `/api/v1/tasks/${task.id}?version=${task.version}`,
        { headers: headers(page) },
      );
}
async function openInbox(page: Page) {
  await page.reload();
  await page.locator(".sidebar nav button", { hasText: "Inbox" }).click();
}

test("Q leaves an open editor alone", async ({ page }) => {
  await signIn(page);
  const title = `${titlePrefix} Q`;
  await create(page, title);
  await openInbox(page);
  await page.locator(".task-body", { hasText: title }).click();
  const modal = page.getByRole("dialog");
  await modal.locator("h2").click();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press("q");
  await expect(modal.locator("h2")).toHaveText("Edit task");
  await modal.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toBeHidden();
  await page.keyboard.press("q");
  await expect(modal.locator("h2")).toHaveText("Add task");
  await cleanUp(page);
});

test("Holding a row shortcut acts once", async ({ page }) => {
  await signIn(page);
  const title = `${titlePrefix} D`;
  await create(page, title);
  await openInbox(page);
  await page.locator(".task-body", { hasText: title }).hover();
  const posted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/tasks"),
  );
  // Playwright marks repeated key downs as key repeat.
  await page.keyboard.down("d");
  await page.keyboard.down("d");
  await page.keyboard.down("d");
  await page.keyboard.up("d");
  await posted;
  await page.waitForTimeout(500);
  expect((await matching(page, title)).length).toBe(2);
  await cleanUp(page);
});

test("A version conflict keeps the draft and the next save succeeds", async ({
  page,
}) => {
  await signIn(page);
  const title = `${titlePrefix} conflict`;
  const task = await create(page, title);
  await openInbox(page);
  await page.locator(".task-body", { hasText: title }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Description").fill("Draft the user typed");
  const changed = await page.request.patch(`/api/v1/tasks/${task.id}`, {
    headers: headers(page),
    data: { version: task.version, priority: 2 },
  });
  expect(changed.status()).toBe(200);
  const save = modal.getByRole("button", { name: "Save changes" });
  const first = page.waitForResponse((r) => r.request().method() === "PATCH");
  await save.click();
  expect((await first).status()).toBe(409);
  await expect(page.getByRole("alert").first()).toContainText(
    "Save again to replace that change",
  );
  await expect(modal.getByLabel("Description")).toHaveValue(
    "Draft the user typed",
  );
  const second = page.waitForResponse((r) => r.request().method() === "PATCH");
  await save.click();
  expect((await second).status()).toBe(200);
  await expect(modal).toBeHidden();
  const [saved] = await matching(page, title);
  expect(saved.description).toBe("Draft the user typed");
  await cleanUp(page);
});

test("An ended session returns to sign-in from an action or from sign out", async ({
  page,
}) => {
  await signIn(page);
  const title = `${titlePrefix} session`;
  await create(page, title);
  await openInbox(page);
  const endSession = () =>
    page.request.post("/auth/logout", { headers: headers(page) });
  await endSession();
  await page.getByRole("button", { name: `Complete ${title}` }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await signIn(page);
  await page.getByRole("button", { name: "Open settings" }).click();
  await endSession();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await signIn(page);
  await cleanUp(page);
});

test("A refused Apple account is told why", async ({ page }) => {
  await page.goto("/?auth_error=denied");
  await expect(page.getByRole("alert")).toContainText(
    "This Apple account is not allowed on this server.",
  );
});

test("Upcoming keeps different years apart and in order", async ({ page }) => {
  await signIn(page);
  for (const [name, day] of [
    ["later", "2099-12-25"],
    ["earlier", "2098-12-25"],
  ]) {
    const response = await page.request.post("/api/v1/tasks", {
      headers: headers(page),
      data: { title: `${titlePrefix} ${name}`, due_date: day },
    });
    expect(response.status()).toBe(201);
  }
  await page.reload();
  await page.locator(".sidebar nav button", { hasText: "Upcoming" }).click();
  const headings = (await page.locator(".task-section h3").allTextContents())
    .map((text) => /2098|2099/.exec(text)?.[0])
    .filter(Boolean);
  expect(headings).toEqual(["2098", "2099"]);
  await cleanUp(page);
});

test("A project deleted elsewhere returns to Inbox", async ({ page }) => {
  await signIn(page);
  const name = `${titlePrefix} project`;
  const project = await (
    await page.request.post("/api/v1/projects", {
      headers: headers(page),
      data: { name },
    })
  ).json();
  await page.reload();
  await page.locator(".sidebar nav button", { hasText: name }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.request.delete(`/api/v1/projects/${project.id}`, {
    headers: headers(page),
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
});

test("A sign-in error does not return on reload", async ({ page }) => {
  await page.goto("/?auth_error=denied");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Polling downloads tasks only after they change", async ({ page }) => {
  await signIn(page);
  const downloads: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/v1/tasks?")) downloads.push(r.url());
  });
  const poll = async () => {
    const done = page.waitForResponse((r) =>
      r.url().endsWith("/api/v1/tasks/revision"),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await done;
    await page.waitForTimeout(300);
  };
  await poll();
  downloads.length = 0;
  await poll();
  await poll();
  expect(downloads).toEqual([]);
  const title = `${titlePrefix} polled`;
  await create(page, title);
  await poll();
  expect(downloads.length).toBeGreaterThan(0);
  await page.locator(".sidebar nav button", { hasText: "Inbox" }).click();
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
    .poll(async () => (await other.request.get("/api/v1/me")).status())
    .toBe(401);
  expect((await page.request.get("/api/v1/me")).status()).toBe(200);
  await otherContext.close();
});

test("The service worker controls the tab that enabled it", async ({
  page,
}) => {
  await page.goto("/");
  const controlled = await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
    return !!navigator.serviceWorker.controller;
  });
  expect(controlled).toBe(true);
});

test("A notification click opens a window when navigating is refused", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const handlers: Record<string, (event: unknown) => void> = {};
  let opened = "";
  let pending: Promise<unknown> = Promise.resolve();
  runInNewContext(await readFile("public/sw.js", "utf8"), {
    URL,
    self: {
      location: { origin: "https://tasks.example.com" },
      addEventListener: (name: string, handler: (event: unknown) => void) => {
        handlers[name] = handler;
      },
    },
    clients: {
      matchAll: async () => [
        {
          url: "https://tasks.example.com/",
          navigate: async () => {
            throw new TypeError("Not controlled");
          },
          focus: async () => {},
        },
      ],
      openWindow: async (url: string) => {
        opened = url;
      },
    },
  });
  handlers.notificationclick({
    notification: { data: { task_id: "abc" }, close: () => {} },
    waitUntil: (promise: Promise<unknown>) => {
      pending = promise;
    },
  });
  await pending;
  expect(opened).toBe("https://tasks.example.com/?task=abc");
});
