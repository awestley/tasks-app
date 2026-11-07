// Which tasks a view shows, in what order, and under which headings.
import React, { useMemo } from "react";
import { localDate, type Project, type Task } from "./api";
import type { QuickDefaults } from "./QuickAdd";
import type { View } from "./routes";
import { daysFromNow, dueLabel, isOverdue, shortDate, weekday } from "./ui";

export type Group = {
  key: string;
  title: React.ReactNode;
  tasks: Task[];
  add?: QuickDefaults;
  overdue?: boolean;
};

export function useTaskGroups({
  tasks,
  view,
  search,
  sort,
  priorityFilter,
  today,
  finishing,
  selectedProject,
}: {
  tasks: Task[];
  view: View;
  search: string;
  sort: string;
  priorityFilter: boolean;
  today: string;
  finishing: Set<string>;
  selectedProject?: Project | null;
}) {
  const visible = (t: Task) => !t.completed || finishing.has(t.id);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = tasks.filter((t) => {
      if (q)
        return (t.title + " " + t.description + " " + t.labels.join(" "))
          .toLowerCase()
          .includes(q);
      if (view === "completed") return t.completed;
      if (!visible(t)) return false;
      if (view === "today") return !!t.due_date && t.due_date <= today;
      if (view === "inbox") return !t.project_id;
      if (view === "upcoming") return !!t.due_date;
      if (view.startsWith("project:")) return t.project_id === view.slice(8);
      if (view.startsWith("label:")) return t.labels.includes(view.slice(6));
      return true;
    });
    const byDue = (a: Task, b: Task) =>
      (a.due_date || "9999").localeCompare(b.due_date || "9999") ||
      (a.due_time || "99").localeCompare(b.due_time || "99") ||
      a.priority - b.priority ||
      a.created_at.localeCompare(b.created_at);
    return list
      .filter((t) => !priorityFilter || t.priority <= 2)
      .sort((a, b) =>
        view === "completed" && !q
          ? (b.completed_at || "").localeCompare(a.completed_at || "")
          : sort === "name"
            ? a.title.localeCompare(b.title)
            : sort === "priority"
              ? a.priority - b.priority || byDue(a, b)
              : byDue(a, b),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, view, search, sort, priorityFilter, today, finishing]);
  const overdue = shown.filter((t) => isOverdue(t) && !search);

  const groups: Group[] = useMemo(() => {
    const defaultsFor = (): QuickDefaults => ({
      project_id: selectedProject?.id ?? null,
      due_date: view === "today" ? today : null,
      labels: view.startsWith("label:") ? [view.slice(6)] : [],
    });
    if (search)
      return [{ key: "search", title: `${shown.length} found`, tasks: shown }];
    if (view === "completed") {
      const out = new Map<string, Task[]>();
      for (const t of shown) {
        const day = t.completed_at
          ? localDate(
              new Date(
                t.completed_at + (t.completed_at.endsWith("Z") ? "" : "Z"),
              ),
            )
          : "";
        out.set(day, [...(out.get(day) || []), t]);
      }
      return [...out].map(([day, items]) => ({
        key: day || "earlier",
        title: day ? dueLabel(day) : "Earlier",
        tasks: items,
      }));
    }
    const rest = shown.filter((t) => !overdue.includes(t));
    const lead: Group[] = overdue.length
      ? [{ key: "overdue", title: "Overdue", tasks: overdue, overdue: true }]
      : [];
    if (view === "upcoming") {
      const days: Group[] = [];
      for (let i = 0; i < 7; i++) {
        const d = daysFromNow(i);
        days.push({
          key: d,
          title: (
            <>
              {shortDate(d)}
              <span className="group-sub">
                {" "}
                ·{" "}
                {i === 0 ? "Today" : i === 1 ? "Tomorrow" : weekday(d, "long")}
              </span>
            </>
          ),
          tasks: rest.filter((t) => t.due_date === d),
          add: { due_date: d },
        });
      }
      const later = rest.filter((t) => t.due_date! > daysFromNow(6));
      const laterDays = Array.from(
        new Set(later.map((t) => t.due_date!)),
      ).sort();
      return [
        ...lead,
        ...days,
        ...laterDays.map((d) => ({
          key: d,
          title: (
            <>
              {shortDate(d)}
              <span className="group-sub"> · {weekday(d, "long")}</span>
            </>
          ),
          tasks: later.filter((t) => t.due_date === d),
          add: { due_date: d },
        })),
      ];
    }
    return [
      ...lead,
      {
        key: "main",
        title:
          view === "today" ? (
            <>
              Today
              <span className="group-sub">
                {" · "}
                {new Date().toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </>
          ) : null,
        tasks: rest,
        add: defaultsFor(),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, view, search, today, selectedProject?.id]);
  const flat = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);

  return { shown, overdue, groups, flat };
}
