// Runs the cases the server parser also runs (api/tests/quick_add_cases.json) against the browser
// parser. `npm run test:unit` sets TZ to the cases' zone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseQuick, stripTokens } from "../../src/parse.ts";

const data = JSON.parse(
  readFileSync(
    new URL("../../../api/tests/quick_add_cases.json", import.meta.url),
    "utf8",
  ),
);
const now = new Date(data.now);

for (const c of data.cases) {
  test(c.text, () => {
    const p = parseQuick(c.text, { projects: data.projects, now });
    assert.deepEqual(
      {
        title: p.title,
        due_date: p.due_date,
        due_time: p.due_time,
        recurrence: p.recurrence,
        priority: p.priority,
        labels: p.labels,
        project: p.project_id,
        // The server adds a reminder at the due time; the app applies the automatic reminder setting.
        reminder_minutes: p.reminder_minutes ?? (p.due_time ? 0 : null),
      },
      {
        title: c.title,
        due_date: c.due_date ?? null,
        due_time: c.due_time ?? null,
        recurrence: c.recurrence ?? null,
        priority: c.priority ?? null,
        labels: c.labels ?? [],
        project: c.project ?? null,
        reminder_minutes: c.reminder_minutes ?? null,
      },
    );
  });
}

test("tokens cover the recognized words, and a dismissed one stays in the title", () => {
  const text = "Call mom tomorrow p2";
  const p = parseQuick(text, { now });
  assert.deepEqual(
    p.tokens.map((t) => [t.kind, text.slice(t.start, t.end)]),
    [
      ["date", "tomorrow"],
      ["priority", "p2"],
    ],
  );
  const kept = parseQuick(text, { now, ignore: new Set(["date:tomorrow"]) });
  assert.equal(kept.title, "Call mom tomorrow");
  assert.equal(kept.due_date, null);
  assert.equal(kept.priority, 2);
  assert.equal(stripTokens(text, p.tokens, ["date"]), "Call mom p2");
});
