import { test, expect } from "@playwright/test";
test("select several tasks and change them together", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: /Open local workspace/ }).click();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  const name = "Select check " + Date.now();
  await page.evaluate(async (prefix) => {
    for (const letter of ["A", "B", "C", "D"])
      await fetch("/api/v1/tasks", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${prefix} ${letter}` }),
      });
  }, name);
  await page.reload();
  await page.getByLabel("Search tasks").fill(name);
  await page.getByLabel("Sort tasks").selectOption("name");
  const rows = page.locator(".task-row");
  await expect(rows).toHaveCount(4);
  const toolbar = page.getByRole("toolbar", { name: "Selected tasks" });

  // Cmd/Ctrl-click starts a selection, Shift-click extends it to a range.
  await rows
    .nth(0)
    .locator(".task-title")
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(toolbar).toContainText("1 selected");
  await rows
    .nth(2)
    .locator(".task-title")
    .click({ modifiers: ["Shift"] });
  await expect(toolbar).toContainText("3 selected");
  await expect(page.locator(".task-row.is-picked")).toHaveCount(3);

  // A plain click toggles while selecting and does not open the task.
  await rows.nth(1).locator(".task-title").click();
  await expect(toolbar).toContainText("2 selected");
  await expect(page.locator(".task-row.is-open")).toHaveCount(0);

  // Right-click on a selected task shows actions for the whole selection.
  await rows.nth(0).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "2 tasks" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "Urgent" }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator(".pick-task")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeHidden();
  await expect(page.locator(".check-task.priority-1")).toHaveCount(2);

  // Select all, then delete in two steps.
  await rows
    .nth(3)
    .locator(".task-title")
    .click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("ControlOrMeta+a");
  await expect(toolbar).toContainText("4 selected");
  await toolbar.getByRole("button", { name: "Delete" }).click();
  await toolbar.getByRole("button", { name: "Confirm delete" }).click();
  await expect(rows).toHaveCount(0);
  await expect(toolbar).toBeHidden();
  expect(errors).toEqual([]);
});
