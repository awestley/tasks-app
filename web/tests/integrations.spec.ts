// Links, alert style, snooze, notification settings and the API reference in the web app.
import { expect, test, type Page } from "@playwright/test";

const title = `Integration ${Date.now()}`;
const headers = (page: Page) => ({ Origin: new URL(page.url()).origin });

async function current(page: Page, id: string) {
  return (await page.request.get(`api/v1/tasks/${id}`)).json();
}

test("links, alert style, snooze, notification settings and the API reference", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Open local workspace/ }).click();
  await expect(page.locator(".quick-add")).toBeVisible();
  const created = await page.request.post("api/v1/tasks", {
    headers: headers(page),
    data: {
      title,
      due_date: "2030-05-01",
      due_time: "09:00",
      time_zone: "UTC",
      reminder_minutes: 15,
    },
  });
  expect(created.status()).toBe(201);
  const task = await created.json();
  await page.goto(`/#/task/${task.id}`);
  await page.reload();
  // On a desktop width the task opens as a dialog over the list.
  const detail = page.getByRole("dialog", { name: "Task details" });
  await expect(detail.getByLabel("Task title")).toHaveValue(title);

  // A link saves at once, separately from the task's version.
  await detail.getByLabel("Link address").fill("https://example.com/visa");
  await detail.getByLabel("Link address").press("Enter");
  await expect(
    detail.getByRole("link", { name: "https://example.com/visa" }),
  ).toBeVisible();
  expect((await current(page, task.id)).links).toHaveLength(1);

  // A task with a reminder can ring as an alarm on iPhone.
  await detail.getByLabel("Alert style").selectOption("alarm");
  await expect
    .poll(async () => (await current(page, task.id)).alert_style)
    .toBe("alarm");

  // Snooze is in the task menu and shows in the detail.
  await detail.getByRole("button", { name: "More task actions" }).click();
  await page.getByText("Snooze", { exact: true }).click();
  await page.getByText("15 minutes", { exact: true }).click();
  await expect(detail.getByText(/Snoozed until/)).toBeVisible();
  expect((await current(page, task.id)).snoozed_until).not.toBeNull();

  // Notification settings are saved on the server for every device.
  await detail.getByRole("button", { name: "Close task" }).click();
  await expect(detail).toBeHidden();
  await page.getByRole("button", { name: "Settings & integrations" }).click();
  await page.getByLabel("Morning summary").check();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("api/v1/notifications/settings")).json())
          .summary_time,
    )
    .toBe("08:00");
  await page.getByLabel("Morning summary").uncheck();
  await expect(
    page.getByRole("link", { name: "API reference" }),
  ).toHaveAttribute("href", "docs");

  // The reference page loads the schema from this server.
  await page.goto("/docs");
  await expect(page).toHaveURL(/\/docs\/$/);
  await expect(
    page.getByText("/api/v1/tasks/{task_id}/snooze").first(),
  ).toBeVisible();

  const latest = await current(page, task.id);
  await page.request.delete(
    `api/v1/tasks/${task.id}?version=${latest.version}`,
    { headers: { Origin: new URL(page.url()).origin } },
  );
});
