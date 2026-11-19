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
  const picked = page.locator(".task-row.is-picked");
  const toolbar = page.getByRole("toolbar", { name: "Selected tasks" });

  // Cmd/Ctrl-click starts a selection, Shift-click extends it to a range.
  await rows
    .nth(0)
    .locator(".task-title")
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(toolbar).toContainText("1 selected");
  await expect(page.getByLabel("Sort tasks")).toBeHidden();
  await rows
    .nth(2)
    .locator(".task-title")
    .click({ modifiers: ["Shift"] });
  await expect(toolbar).toContainText("3 selected");
  await expect(picked).toHaveCount(3);
  await expect(page.locator(".select-task")).toHaveCount(4);
  await expect(page.locator(".check-task")).toHaveCount(0);

  // A plain click toggles while selecting and does not open the task.
  await rows.nth(1).locator(".task-title").click();
  await expect(toolbar).toContainText("2 selected");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Close task")).toHaveCount(0);

  // Right-click on a selected task shows actions for the whole selection.
  await rows.nth(0).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "2 tasks" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "Urgent" }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator(".select-task")).toHaveCount(4);
  await expect(
    page.getByText("Priority set to urgent for 2 tasks"),
  ).toBeVisible();

  // With a selection, 2 sets the priority of every selected task.
  await page.keyboard.press("2");
  await expect(
    page.getByText("Priority set to high for 2 tasks"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeHidden();
  await expect(page.locator(".check-task.priority-2")).toHaveCount(2);

  // The task menu's Select starts a selection; the toolbar moves the selected tasks.
  await rows.nth(3).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Select" }).click();
  await expect(toolbar).toContainText("1 selected");
  await toolbar.getByRole("button", { name: "Priority" }).click();
  await page
    .getByRole("menu", { name: "Priority" })
    .getByRole("menuitemradio", { name: "Medium" })
    .click();
  await expect(
    page.getByText("Priority set to medium for 1 task"),
  ).toBeVisible();
  await toolbar.getByRole("button", { name: "Clear selection" }).click();
  await expect(toolbar).toBeHidden();
  await expect(page.locator(".check-task.priority-3")).toHaveCount(1);

  // Clicking a task without a selection still opens it.
  await rows.nth(3).locator(".task-title").click();
  await expect(page.getByLabel("Close task")).toBeVisible();
  await page.getByLabel("Close task").click();
  await expect(page.getByLabel("Close task")).toHaveCount(0);

  // Select all from the list's menu, then complete with C and restore from the toolbar.
  await page.getByLabel("View options").click();
  await page.getByRole("menuitem", { name: "Select all" }).click();
  await expect(toolbar).toContainText("4 selected");
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeHidden();

  // Cmd/Ctrl-A selects all too; delete takes two clicks.
  await page.locator(".task-main h1").click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(toolbar).toContainText("4 selected");
  await toolbar.getByRole("button", { name: "Delete" }).click();
  await toolbar.getByRole("button", { name: "Confirm delete" }).click();
  await expect(rows).toHaveCount(0);
  await expect(toolbar).toBeHidden();
  await expect(page.getByText("4 tasks deleted")).toBeVisible();

  // Undo brings them back.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(rows).toHaveCount(4);

  // C completes every selected task; the toolbar then restores them.
  await page.keyboard.press("ControlOrMeta+a");
  await expect(toolbar).toContainText("4 selected");
  await page.keyboard.press("c");
  await expect(page.getByText("4 tasks completed")).toBeVisible();
  await expect(page.locator(".task-row.is-complete")).toHaveCount(4);
  await toolbar.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("4 tasks restored")).toBeVisible();
  await expect(page.locator(".task-row.is-complete")).toHaveCount(0);

  // Changing lists clears the selection.
  await page.keyboard.press("ControlOrMeta+a");
  await expect(toolbar).toContainText("4 selected");
  await page
    .locator(".sidebar nav button")
    .filter({ hasText: "Inbox" })
    .click();
  await expect(toolbar).toBeHidden();
  await expect(picked).toHaveCount(0);
  expect(errors).toEqual([]);
});
