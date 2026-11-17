import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeChecklist } from "../../src/checklist.ts";

const item = (id: string, title = id, completed = false) => ({
  id,
  title,
  completed,
});
const base = [item("a"), item("b"), item("c")];

test("nothing changed elsewhere: the edit is kept as it is", () => {
  const mine = [item("a", "edited"), item("b", "b", true), item("new")];
  assert.deepEqual(mergeChecklist(base, mine, base), mine);
});

test("different items changed on each device: both changes stay", () => {
  const mine = [item("a", "edited"), item("b"), item("c")];
  const theirs = [item("a"), item("b", "b", true), item("c")];
  assert.deepEqual(mergeChecklist(base, mine, theirs), [
    item("a", "edited"),
    item("b", "b", true),
    item("c"),
  ]);
});

test("different fields of one item changed on each device: both stay", () => {
  const mine = [item("a", "edited"), item("b"), item("c")];
  const theirs = [item("a", "a", true), item("b"), item("c")];
  assert.equal(mergeChecklist(base, mine, theirs)[0].title, "edited");
  assert.equal(mergeChecklist(base, mine, theirs)[0].completed, true);
});

test("the same field changed on both devices: this device's edit wins", () => {
  const mine = [item("a", "mine"), item("b"), item("c")];
  const theirs = [item("a", "theirs"), item("b"), item("c")];
  assert.equal(mergeChecklist(base, mine, theirs)[0].title, "mine");
});

test("an item removed on either device stays removed", () => {
  const mine = [item("b"), item("c")];
  const theirs = [item("a"), item("b")];
  assert.deepEqual(mergeChecklist(base, mine, theirs), [item("b")]);
});

test("an item removed elsewhere stays removed even if edited here", () => {
  const mine = [item("a", "edited"), item("b"), item("c")];
  const theirs = [item("b"), item("c")];
  assert.deepEqual(mergeChecklist(base, mine, theirs), [item("b"), item("c")]);
});

test("items added on each device all stay, the other device's where it put them", () => {
  const mine = [item("a"), item("b"), item("c"), item("mine")];
  const theirs = [
    item("first"),
    item("a"),
    item("b"),
    item("theirs"),
    item("c"),
  ];
  assert.deepEqual(
    mergeChecklist(base, mine, theirs).map((i) => i.id),
    ["first", "a", "b", "theirs", "c", "mine"],
  );
});
