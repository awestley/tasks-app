// The due date as an embed shows it. On its own so it can be tested without a page.
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dueLabel(
  task: { due_date: string | null; due_time: string | null },
  now = new Date(),
) {
  if (!task.due_date) return "";
  const today = localDate(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day =
    task.due_date === today
      ? "Today"
      : task.due_date === localDate(tomorrow)
        ? "Tomorrow"
        : new Date(task.due_date + "T12:00:00").toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            // Without the year, a date outside this one reads as if it were this year.
            year:
              task.due_date.slice(0, 4) === today.slice(0, 4)
                ? undefined
                : "numeric",
          });
  return task.due_time ? `${day} ${task.due_time}` : day;
}
