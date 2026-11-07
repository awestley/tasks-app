import type { Task } from "./api";

export type View =
  | "today"
  | "inbox"
  | "upcoming"
  | "all"
  | "completed"
  | `project:${string}`
  | `label:${string}`;
const LISTS = ["today", "inbox", "upcoming", "all", "completed"] as const;
export const viewNames: Record<string, string> = {
  today: "Today",
  inbox: "Inbox",
  upcoming: "Upcoming",
  all: "All tasks",
  completed: "Completed",
};

// Routes: #/today, #/inbox, #/upcoming, #/all, #/completed, #/project/<id>, #/label/<name>, each
// optionally followed by /task/<id>; #/task/<id> alone opens the task in its own list.
export function readRoute(): { view: View | null; taskId: string | null } {
  const raw = location.hash.replace(/^#\/?/, "");
  const [head, taskPart] = raw.split(/\/?task\//);
  let taskId: string | null = null;
  try {
    taskId = taskPart ? decodeURIComponent(taskPart) : null;
  } catch {
    /* malformed */
  }
  const [kind, ...rest] = head.split("/");
  let arg = "";
  try {
    arg = decodeURIComponent(rest.join("/"));
  } catch {
    return { view: null, taskId };
  }
  const legacy = new URLSearchParams(location.search).get("task");
  if (legacy) taskId = legacy;
  if (kind === "project" && arg) return { view: `project:${arg}`, taskId };
  if (kind === "label" && arg) return { view: `label:${arg}`, taskId };
  if ((LISTS as readonly string[]).includes(kind))
    return { view: kind as View, taskId };
  return { view: null, taskId };
}
export function hashFor(view: View, taskId?: string | null) {
  const base = view.startsWith("project:")
    ? "#/project/" + encodeURIComponent(view.slice(8))
    : view.startsWith("label:")
      ? "#/label/" + encodeURIComponent(view.slice(6))
      : "#/" + view;
  return taskId ? `${base}/task/${encodeURIComponent(taskId)}` : base;
}
export const taskLink = (task: Task) =>
  location.pathname.startsWith("/apps/")
    ? `${location.origin}/?open=${encodeURIComponent(`pc://tasks/task/${task.id}`)}`
    : `${location.origin}${location.pathname}#/task/${encodeURIComponent(task.id)}`;
export const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
export const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};
