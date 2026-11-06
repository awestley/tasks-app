import { test, expect, type Page } from "@playwright/test";

async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Open local workspace/ }).click();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
}

test("adding many tasks quickly, # suggestions and keyboard control", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  const stamp = String(Date.now());

  await page.keyboard.press("q");
  const input = page.getByRole("dialog").getByLabel("Task name");
  for (const n of [1, 2, 3]) {
    await input.fill(`Rapid ${stamp} ${n} today`);
    await input.press("Enter");
  }
  // A new #project is offered and created from the field.
  await input.fill(`Rapid ${stamp} 4 #P${stamp}`);
  await expect(
    page.getByRole("option", { name: `Create project “P${stamp}”` }),
  ).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue(`Rapid ${stamp} 4 #P${stamp} `);
  await expect(page.getByRole("dialog").locator(".tok-project")).toHaveText(
    `#P${stamp}`,
  );
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await page.keyboard.press("Escape");

  await page.getByLabel("Search tasks").fill(`Rapid ${stamp}`);
  const rows = page.locator(".task-row");
  await expect(rows).toHaveCount(4);
  await expect(
    rows.filter({ hasText: new RegExp(`${stamp} 4`) }),
  ).toContainText(`P${stamp}`);

  // Keyboard: move with J/K, set priority with 1-4, complete with C and undo with Cmd/Ctrl+Z.
  await page.getByLabel("Search tasks").press("Enter");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toBeFocused();
  // The list re-sorts as priorities change, so follow the task itself.
  const id = await rows.nth(1).getAttribute("data-id");
  const target = page.locator(`.task-row[data-id="${id}"]`);
  await page.keyboard.press("1");
  await expect(target.locator(".check-task")).toHaveClass(/priority-1/);
  await expect(target).toBeFocused();
  await page.keyboard.press("c");
  await expect(target).toHaveClass(/is-complete/);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(target).not.toHaveClass(/is-complete/);
  await page.keyboard.press("?");
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("offline: tasks are added at once and sync when the connection returns", async ({
  page,
  context,
}) => {
  await open(page);
  const name = "Offline " + Date.now();
  await context.setOffline(true);
  await page.keyboard.press("q");
  const input = page.getByRole("dialog").getByLabel("Task name");
  await input.fill(name + " today");
  await input.press("Enter");
  await page.keyboard.press("Escape");
  await page.getByLabel("Search tasks").fill(name);
  await expect(page.locator(".task-row")).toHaveCount(1);
  await expect(page.locator(".sync-status")).toContainText("Offline");
  await context.setOffline(false);
  await expect(page.locator(".sync-status")).toHaveCount(0, { timeout: 20000 });
  await page.reload();
  await page.getByLabel("Search tasks").fill(name);
  await expect(page.locator(".task-row")).toHaveCount(1);
});

test("companion box: capture field first, compact list", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await page.setViewportSize({ width: 340, height: 640 });
  await page.goto("/companion.html");
  const field = page.getByLabel("Task name");
  await expect(field).toBeVisible();
  // It does not take focus on load (the workspace keeps it).
  await expect(field).not.toBeFocused();
  const name = "Companion " + Date.now();
  await field.click();
  await field.fill(name + " today p2");
  await field.press("Enter");
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  const row = page.locator(".task-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.locator(".check-task")).toHaveClass(/priority-2/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({ path: "../docs/screenshots/companion.png" });
  await row.getByLabel(`Complete ${name}`).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  expect(errors).toEqual([]);
});
