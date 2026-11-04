// The phone layout, on an emulated iPhone (touch, mobile viewport) in Chromium.
import {
  test,
  expect,
  devices,
  type Locator,
  type Page,
} from "@playwright/test";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iphone } = devices["iPhone 15"];
test.use({ ...iphone, timezoneId: "America/New_York" });

async function open(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Open local workspace/ }).tap();
  await expect(page.locator(".tabbar")).toBeVisible();
}

/** A finger drag across a row, through real touch events. */
async function swipe(page: Page, row: Locator, dx: number) {
  // In the middle of the screen, clear of the tab bar, the + button and notices.
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const cdp = await page.context().newCDPSession(page);
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = dx > 0 ? box.x + 40 : box.x + box.width - 40;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (dx * i) / 10, y }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
}

test("phone: tabs, the + sheet, swipe actions and the task full screen", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  const stamp = String(Date.now());
  const tabs = page.locator(".tabbar");
  await expect(tabs.getByRole("button", { name: /Today/ })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // + opens quick add as a sheet. Enter and the round button both add and keep it open.
  await page.locator(".fab").tap();
  const sheet = page.locator(".modal-backdrop.is-sheet");
  await expect(sheet).toBeVisible();
  const input = sheet.getByLabel("Task name");
  await expect(input).toBeFocused();
  await input.fill(`Phone ${stamp} first today`);
  await input.press("Enter");
  await input.fill(`Phone ${stamp} second today p1`);
  await sheet.getByRole("button", { name: "Add task" }).tap();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  // The notice moves to the top while the sheet is up.
  await expect(page.locator(".toast.is-top")).toBeVisible();
  await page.touchscreen.tap(200, 90);
  await expect(sheet).toBeHidden();
  const rows = page.locator(".task-row", { hasText: `Phone ${stamp}` });
  await expect(rows).toHaveCount(2);

  // Swipe right completes, with Undo.
  await swipe(page, rows.filter({ hasText: "first" }), 170);
  await expect(page.locator(".toast")).toContainText("Task completed");
  await expect(rows).toHaveCount(1);
  // A short swipe springs back and does nothing.
  await swipe(page, rows.first(), 40);
  await expect(page.locator(".menu-sheet")).toBeHidden();
  await expect(rows).toHaveCount(1);
  // Swipe left schedules.
  await swipe(page, rows.first(), -170);
  const menu = page.locator(".menu-sheet");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /Tomorrow/ }).tap();
  await expect(rows).toHaveCount(0);

  // Upcoming has it tomorrow; it opens full screen and comes back.
  await tabs.getByRole("button", { name: "Upcoming" }).tap();
  await expect(
    page.getByRole("heading", { name: "Upcoming", exact: true }),
  ).toBeVisible();
  const two = page.locator(".task-row", { hasText: `Phone ${stamp} second` });
  await expect(two).toBeVisible();
  await two.locator(".task-body").tap();
  await expect(page.locator(".detail.is-overlay")).toBeVisible();
  await expect(page.getByLabel("Task title")).toHaveValue(
    `Phone ${stamp} second`,
  );
  await page.getByLabel("Back to list").tap();
  await expect(page.locator(".detail")).toBeHidden();

  // Search covers open and completed tasks.
  await tabs.getByRole("button", { name: "Search" }).tap();
  await page.getByLabel("Search tasks").fill(`Phone ${stamp}`);
  await expect(page.locator(".task-row")).toHaveCount(2);

  // Browse holds everything else; a view opened from it has a way back.
  await tabs.getByRole("button", { name: "Browse" }).tap();
  await expect(
    page.getByRole("heading", { name: "Browse", exact: true }),
  ).toBeVisible();
  await page.locator(".phone-cell", { hasText: "Completed" }).tap();
  await expect(
    page.getByRole("heading", { name: "Completed", exact: true }),
  ).toBeVisible();
  await expect(tabs.locator("[aria-current=page]")).toHaveText("Browse");
  await expect(
    page.locator(".task-row", { hasText: `Phone ${stamp} first` }),
  ).toBeVisible();
  await page.locator(".phone-back").tap();
  await expect(
    page.getByRole("heading", { name: "Browse", exact: true }),
  ).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
