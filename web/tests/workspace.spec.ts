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
  const name = "Browser check " + Date.now();
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel("Task title").fill(name);
  await page
    .getByLabel("Description")
    .fill("Created through the real web interface.");
  await page
    .getByRole("combobox", { name: "Priority", exact: true })
    .selectOption("1");
  await page.getByLabel("Labels", { exact: true }).fill("testing");
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
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add task", exact: true })
    .click();
  await expect(
    page.locator(".task-row").filter({ hasText: name }),
  ).toBeVisible();
  await page.getByLabel("Search tasks").fill(name);
  await expect(page.locator(".task-row")).toHaveCount(1);
  await expect(page.locator(".checklist-progress")).toHaveText("1/2");
  await page.locator(".task-row .task-body").click();
  await page.getByLabel("Task title").fill(name + " updated");
  await expect(
    page.getByLabel("Checklist item 1", { exact: true }),
  ).toHaveValue("Review inbox");
  await page
    .getByLabel("Checklist item 2", { exact: true })
    .fill("Updated notes");
  await page.screenshot({
    path: "../docs/screenshots/checklist-editor.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".task-row")).toContainText(name + " updated");
  await page
    .getByLabel("Complete " + name + " updated", { exact: true })
    .click();
  await expect(page.locator(".task-row")).toHaveClass(/is-complete/);
  await expect(page.locator(".checklist-progress")).toHaveText("2/2");
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
  await page.locator(".task-row .task-body").click();
  await expect(
    page.getByLabel("Checklist item 2", { exact: true }),
  ).toHaveValue("Updated notes");
  await page
    .getByRole("checkbox", { name: "Complete checklist item 2", exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "Remove checklist item 1", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".checklist-progress")).toHaveText("0/1");
  await page.locator(".task-row .task-body").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Nothing found" }),
  ).toBeVisible();
  await page.getByLabel("Clear search").click();
  await page.getByLabel("Add project", { exact: true }).click();
  await page.getByLabel("Project name").fill(name);
  await page.getByRole("button", { name: "Save project" }).click();
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
  await page.getByLabel("Open settings", { exact: true }).click();
  await page.getByLabel("Token name").fill(name);
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const token = await page.locator(".token-created code").innerText();
  const response = await request.get(
    (process.env.TASKWELL_API_URL || "http://127.0.0.1:8000") + "/api/v1/tasks",
    {
      headers: { Authorization: "Bearer " + token },
    },
  );
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
      await request.get(
        (process.env.TASKWELL_API_URL || "http://127.0.0.1:8000") +
          "/api/v1/tasks",
        {
          headers: { Authorization: "Bearer " + token },
        },
      )
    ).status(),
  ).toBe(401);
  await page.getByLabel("Close settings").click();
  await page
    .locator(".sidebar nav")
    .getByRole("button", { name: /Today/ })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("status")).toHaveCount(0);
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
  await page.getByLabel("Open navigation").click();
  await page
    .locator(".sidebar nav")
    .getByRole("button", { name: /Upcoming/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Upcoming", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
