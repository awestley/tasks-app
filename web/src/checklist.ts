import type { ChecklistItem } from "./api";

/**
 * Combine a checklist edited here with what another device did to it since. `base` is the list the edit
 * started from. Each item is matched by id, and for each field an edit made here wins over the other
 * device's. An item removed on either side stays removed, and items the other device added stay, after the
 * item they followed there.
 */
export function mergeChecklist(
  base: ChecklistItem[],
  mine: ChecklistItem[],
  theirs: ChecklistItem[],
): ChecklistItem[] {
  const before = new Map(base.map((item) => [item.id, item]));
  const other = new Map(theirs.map((item) => [item.id, item]));
  const here = new Set(mine.map((item) => item.id));
  const merged: ChecklistItem[] = [];
  for (const item of mine) {
    const was = before.get(item.id);
    const now = other.get(item.id);
    if (!was || !now) {
      if (!was) merged.push(item); // Added here. Otherwise the other device removed it.
      continue;
    }
    merged.push({
      id: item.id,
      title: item.title !== was.title ? item.title : now.title,
      completed:
        item.completed !== was.completed ? item.completed : now.completed,
    });
  }
  theirs.forEach((item, index) => {
    if (before.has(item.id) || here.has(item.id)) return;
    const previous = theirs[index - 1]?.id;
    merged.splice(merged.findIndex((i) => i.id === previous) + 1, 0, item);
  });
  return merged;
}
