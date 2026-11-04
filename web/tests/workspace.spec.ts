import { test, expect } from "@playwright/test";
test("task lifecycle, project editing, tokens and responsive layout", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: /Open local workspace/ }).click();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../docs/screenshots/web-desktop.png",
    fullPage: true,
    animations: "disabled",
  });

  // Add a task through the dialog: priority and label come from the text.
  const name = "Browser check " + Date.now();
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add task" });
  await dialog.getByLabel("Task name").fill(name + " p1 @testing");
  await dialog
    .getByLabel("Description")
    .fill("Created through the real web interface.");
  await dialog.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByLabel("Search tasks").fill(name);
  const rows = page.locator(".task-row");
  await expect(rows).toHaveCount(1);
  const row = rows.first();
  await expect(row).toContainText("testing");
  await expect(row.locator(".check-task")).toHaveClass(/priority-1/);
  await expect(row).toContainText("Created through the real web interface.");

  // Edit in place: changes save as you go.
  await row.locator(".task-body").click();
  await page.getByLabel("Task title").fill(name + " updated");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page
    .getByLabel("Checklist item 1", { exact: true })
    .fill("Review inbox");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page
    .getByLabel("Checklist item 2", { exact: true })
    .fill("Write notes");
  await page
    .getByRole("checkbox", { name: "Complete checklist item 1", exact: true })
    .check();
  await page.screenshot({
    path: "../docs/screenshots/checklist-editor.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("Close task").click();
  await expect(row).toContainText(name + " updated");
  await expect(page.locator(".checklist-progress")).toHaveText("1/2");

  // Complete, undo, complete again.
  await page
    .getByLabel("Complete " + name + " updated", { exact: true })
    .click();
  await expect(row).toHaveClass(/is-complete/);
  await expect(page.locator(".checklist-progress")).toHaveText("2/2");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(row).not.toHaveClass(/is-complete/);
  await page
    .getByLabel("Complete " + name + " updated", { exact: true })
    .click();
  await expect(row).toHaveClass(/is-complete/);

  // It survives a reload, shows in Completed, and can be restored.
  await page.reload();
  await page
    .locator(".sidebar nav")
    .getByRole("button", { name: /Completed/ })
    .click();
  await expect(
    page.locator(".task-row").filter({ hasText: name }),
  ).toBeVisible();
  await page
    .getByLabel("Restore " + name + " updated", { exact: true })
    .click();
  await page.getByLabel("Search tasks").fill(name);
  await expect(row).not.toHaveClass(/is-complete/);
  await row.locator(".task-body").click();
  await expect(
    page.getByLabel("Checklist item 2", { exact: true }),
  ).toHaveValue("Write notes");
  await page
    .getByRole("checkbox", { name: "Complete checklist item 2", exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "Remove checklist item 1", exact: true })
    .click();
  await page.getByLabel("Close task").click();
  await expect(page.locator(".checklist-progress")).toHaveText("0/1");

  // Delete from the task view.
  await row.locator(".task-body").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Nothing found" }),
  ).toBeVisible();
  await page.getByLabel("Clear search").click();

  // Projects
  await page.getByLabel("Add project", { exact: true }).click();
  await page.getByLabel("Project name").fill(name);
  await page.getByRole("button", { name: "Save project" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page
    .locator(".sidebar nav")
    .getByRole("button", { name: new RegExp(name) })
    .click();
  await page.getByLabel("Edit project", { exact: true }).click();
  await page
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();

  // Personal access tokens
  await page.getByLabel("Open settings", { exact: true }).click();
  await page.getByLabel("Token name").fill(name);
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const token = await page.locator(".token-created code").innerText();
  const api = process.env.TASKWELL_API_URL || "http://127.0.0.1:8000";
  const response = await request.get(api + "/api/v1/tasks", {
    headers: { Authorization: "Bearer " + token },
  });
  expect(response.status()).toBe(200);
  await page
    .locator(".token-row")
    .filter({ hasText: name })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(
    page.locator(".token-row").filter({ hasText: name }),
  ).toHaveCount(0);
  expect(
    (
      await request.get(api + "/api/v1/tasks", {
        headers: { Authorization: "Bearer " + token },
      })
    ).status(),
  ).toBe(401);
  await page.getByLabel("Close settings").click();

  // Phone width: tabs at the bottom, a + button, and nothing scrolls sideways.
  await page
    .locator(".sidebar nav")
    .getByRole("button", { name: /Today/ })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("status")).toHaveCount(0, { timeout: 10000 });
  await page.screenshot({
    path: "../docs/screenshots/web-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page
    .locator(".tabbar")
    .getByRole("button", { name: "Upcoming" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Upcoming", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".tabbar").getByRole("button", { name: "Upcoming" }),
  ).toHaveAttribute("aria-current", "page");
  expect(errors).toEqual([]);
});
