export type Project = { id: string; name: string; color: string };
export type ChecklistItem = { id: string; title: string; completed: boolean };
export type Task = {
  id: string;
  title: string;
  description: string;
  project_id: string | null;
  due_date: string | null;
  due_time: string | null;
  time_zone: string;
  reminder_minutes: number | null;
  priority: number;
  labels: string[];
  checklist: ChecklistItem[];
  recurrence: string | null;
  completed: boolean;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
};
export type Profile = { id: string; name: string; email: string };
export type Token = {
  id: string;
  name: string;
  created_at: string;
  expires_at: string;
};
export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
/** Network failures and an unreachable app behind the proxy: the request may be retried later. */
export const isOffline = (e: unknown) =>
  e instanceof TypeError ||
  [0, 502, 503, 504].includes((e as APIError)?.status);
let refreshing: Promise<boolean> | null = null;
/** Inside Personal Command the shell's access token is short-lived; renew it once on a 401. */
function renewShellSession() {
  refreshing ||= fetch("/auth/refresh", {
    method: "POST",
    credentials: "same-origin",
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 5000));
  return refreshing;
}
export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
  retry = true,
): Promise<T> {
  // Relative to the page, so the app works at the root and under the shell's /apps/tasks/.
  const response = await fetch(
    (path.startsWith("/auth") ? path : "/api/v1" + path).slice(1),
    {
      method,
      credentials: "same-origin",
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
    },
  );
  if (
    response.status === 401 &&
    retry &&
    location.pathname.startsWith("/apps/") &&
    (await renewShellSession())
  )
    return api<T>(path, method, data, false);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new APIError(
      response.status,
      typeof body.detail === "string"
        ? body.detail
        : "Please check your input and try again.",
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export async function allTasks(): Promise<Task[]> {
  const results: Task[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await api<Task[]>(`/tasks?limit=200&offset=${offset}`);
    results.push(...page);
    if (page.length < 200) return results;
  }
}
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function dateLabel(value: string | null) {
  if (!value) return "";
  const today = localDate();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (value === today) return "Today";
  if (value === localDate(tomorrow)) return "Tomorrow";
  return new Date(value + "T12:00:00").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export type ParsedTask = {
  title: string;
  due_date: string | null;
  due_time: string | null;
  time_zone: string;
  reminder_minutes: number | null;
  recurrence: string | null;
  priority: number | null;
  labels: string[];
  project_id: string | null;
  recognized: string[];
};
