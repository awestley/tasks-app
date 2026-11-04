import { test, expect } from "@playwright/test";
test("task context menu and long-press sheet", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: /Open local workspace/ }).click();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  const name = "Menu check " + Date.now();
  await page.evaluate(
    (title) =>
      fetch("/api/v1/tasks", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }),
    name,
  );
  await page.reload();
  await page.getByLabel("Search tasks").fill(name);
  const rows = page.locator(".task-row");
  await expect(rows).toHaveCount(1);

  await rows.first().click({ button: "right" });
  const menu = page.getByRole("menu", { name });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "Urgent" }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator(".check-task")).toHaveClass(/priority-1/);

  await rows.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(rows).toHaveCount(2);

  await rows.first().click({ button: "right" });
  await page.keyboard.press("v");
  await expect(page.getByRole("menu", { name: "Move to" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Move to" })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  for (let count = 2; count > 0; count--) {
    await page.getByLabel(`More actions for ${name}`).first().click();
    await page.getByRole("menuitem", { name: "Delete task" }).click();
    await page.getByRole("menuitem", { name: "Confirm delete" }).click();
    await expect(rows).toHaveCount(count - 1);
  }

  await page.getByLabel("Search tasks").fill("");
  // A narrow window that is not a phone: the sidebar is a drawer.
  await page.setViewportSize({ width: 620, height: 844 });
  const project = page
    .locator(".sidebar nav button")
    .filter({ hasText: "Inbox" });
  await page.getByLabel("Open navigation").click();
  const box = (await project.boundingBox())!;
  const point = { x: box.x + 20, y: box.y + box.height / 2 };
  await project.dispatchEvent("pointerdown", {
    pointerType: "touch",
    clientX: point.x,
    clientY: point.y,
  });
  await page.waitForTimeout(600);
  await project.dispatchEvent("pointerup", { pointerType: "touch" });
  // The click that follows a long press must not also activate the item.
  await project.dispatchEvent("click");
  await expect(page.locator(".menu-sheet")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  await page.getByRole("button", { name: "Close menu" }).click();
  await expect(page.locator(".menu-sheet")).toBeHidden();
  expect(errors).toEqual([]);
});
