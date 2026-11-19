import { test, expect } from "@playwright/test";
test("work and personal tasks are shown apart", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: /Open local workspace/ }).click();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  const name = "Space check " + Date.now();
  await page.evaluate(async (prefix) => {
    const post = (path: string, body: object) =>
      fetch("/api/v1/" + path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    const project = await post("projects", {
      name: prefix + " project",
      space: "work",
    });
    await post("tasks", { title: prefix + " work", project_id: project.id });
    await post("tasks", { title: prefix + " home" });
  }, name);
  await page.reload();
  const spaces = page.getByRole("radiogroup", { name: "Space" });
  const sidebar = page.getByRole("complementary", { name: "Navigation" });
  await spaces.getByRole("radio", { name: "Personal" }).click();
  await page.getByRole("button", { name: /^All tasks/ }).click();
  const rows = page.locator(".task-row");
  await expect(rows.filter({ hasText: name + " home" })).toHaveCount(1);
  await expect(rows.filter({ hasText: name + " work" })).toHaveCount(0);
  await expect(sidebar.getByText(name + " project")).toHaveCount(0);

  await spaces.getByRole("radio", { name: "Work" }).click();
  await expect(rows.filter({ hasText: name + " work" })).toHaveCount(1);
  await expect(rows.filter({ hasText: name + " home" })).toHaveCount(0);
  await expect(sidebar.getByText(name + " project")).toBeVisible();
  await expect(page.locator(".breadcrumb")).toContainText("Work");

  // Search stays in the space too.
  await page.getByLabel("Search tasks").fill(name);
  await expect(rows).toHaveCount(1);
  await page.getByLabel("Search tasks").fill("");

  // Moving a task to the other space takes it out of its project.
  await rows.filter({ hasText: name + " work" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to" }).hover();
  await page.getByRole("menuitem", { name: "Personal" }).click();
  await expect(rows.filter({ hasText: name })).toHaveCount(0);
  await spaces.getByRole("radio", { name: "Personal" }).click();
  await expect(rows.filter({ hasText: name })).toHaveCount(2);
  const saved = await page.evaluate(
    async (title) =>
      (await fetch("/api/v1/tasks?q=" + encodeURIComponent(title)).then((r) =>
        r.json(),
      )) as { space: string; project_id: string | null }[],
    name + " work",
  );
  expect(saved).toEqual([
    expect.objectContaining({ space: "personal", project_id: null }),
  ]);
  expect(errors).toEqual([]);
});
