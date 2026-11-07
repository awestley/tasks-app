import { test } from "node:test";
import assert from "node:assert/strict";
import { dueLabel } from "../../src/due.ts";

const now = new Date("2026-11-06T12:00:00");
const label = (due_date: string | null, due_time: string | null = null) =>
  dueLabel({ due_date, due_time }, now);

test("no date, today and tomorrow", () => {
  assert.equal(label(null), "");
  assert.equal(label("2026-11-06"), "Today");
  assert.equal(label("2026-11-07", "09:00"), "Tomorrow 09:00");
});

test("the year shows only outside this one", () => {
  assert.doesNotMatch(label("2026-12-25"), /2026/);
  assert.match(label("2027-01-05"), /2027/);
  assert.match(label("2025-01-05"), /2025/);
});
