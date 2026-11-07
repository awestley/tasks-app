// The app's data: a local replica of tasks and projects, and an outbox of writes.
//
// Every change shows at once: it is applied to the replica as a pending operation and sent in the
// background, one at a time, in order. Offline, operations wait in the outbox and replay when the
// server is reachable again. Versions are taken from the last server copy when an operation is sent,
// so quick edits never conflict with each other. Only changed fields are sent, so when another
// device changed the task (409), the change is re-applied on top of the newer copy, field by field.
//
// The replica and outbox live in localStorage, so every open view of the app in this browser (a
// Tasks column, the companion, a tab) shows the same thing, and a reload or a cold start offline
// opens straight to your tasks. Only one view sends the outbox at a time (Web Locks).
import { useSyncExternalStore } from "react";
import {
  api,
  allTasks,
  APIError,
  isOffline,
  type Profile,
  type Project,
  type Task,
} from "./api";

export type Config = {
  apple_enabled: boolean;
  dev_login: boolean;
  shell?: boolean;
};
type TaskFields = Omit<
  Task,
  "id" | "completed" | "completed_at" | "created_at" | "updated_at" | "version"
>;
export type TaskChanges = Partial<TaskFields> & {
  completed?: boolean;
  /** Reopening right after completing: the server also removes an untouched recurring successor. */
  undo?: boolean;
};
type Op = { op: string; at: number } & (
  | { kind: "create"; task: Task }
  | { kind: "patch"; id: string; changes: TaskChanges }
  | { kind: "delete"; id: string }
  | { kind: "project-create"; project: Project }
  | {
      kind: "project-patch";
      id: string;
      changes: { name: string; color: string };
    }
  | { kind: "project-delete"; id: string }
);
type Replica = {
  user: Profile;
  tasks: Task[];
  projects: Project[];
  saved: number;
};
export type Phase = "loading" | "signed-out" | "ready";
export type State = {
  phase: Phase;
  user: Profile | null;
  config: Config;
  tasks: Task[];
  projects: Project[];
  /** Writes not yet on the server. */
  pending: number;
  online: boolean;
  /** The session ended (inside the shell: sign in again there). */
  expired: boolean;
  /** A write the server refused, to show once. */
  problem: string;
  bootError: string;
};

const REPLICA = "tasks.replica.v1";
const OUTBOX = "tasks.outbox.v1";
const read = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
};
const storageWorks = (() => {
  try {
    localStorage.setItem("tasks.probe", "1");
    localStorage.removeItem("tasks.probe");
    return true;
  } catch {
    return false;
  }
})();
/** The outbox as every view in this browser sees it. */
const storedQueue = (): Op[] =>
  storageWorks ? read<Op[]>(OUTBOX) || [] : queue;
const write = (key: string, value: unknown) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or full: the app still works for this session */
  }
};

let server: { tasks: Task[]; projects: Project[] } = {
  tasks: [],
  projects: [],
};
let queue: Op[] = read<Op[]>(OUTBOX) || [];
let state: State = {
  phase: "loading",
  user: null,
  config: { apple_enabled: false, dev_login: false },
  tasks: [],
  projects: [],
  pending: queue.length,
  online: true,
  expired: false,
  problem: "",
  bootError: "",
};
const listeners = new Set<() => void>();
function emit(partial: Partial<State> = {}) {
  const view = overlay();
  state = { ...state, ...partial, ...view, pending: queue.length };
  listeners.forEach((fn) => fn());
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getState = () => state;
export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

/* ---------- replica ---------- */

function saveReplica() {
  if (!state.user) return;
  write(REPLICA, {
    user: state.user,
    tasks: server.tasks,
    projects: server.projects,
    saved: Date.now(),
  } satisfies Replica);
}
function saveQueue() {
  write(OUTBOX, queue.length ? queue : null);
}
const nowIso = () => new Date().toISOString().replace("Z", "");

/** Server data with the outbox applied on top: what the user should see. */
function overlay() {
  if (!queue.length) return { tasks: server.tasks, projects: server.projects };
  const tasks = new Map(server.tasks.map((t) => [t.id, t]));
  const projects = new Map(server.projects.map((p) => [p.id, p]));
  for (const op of queue) {
    if (op.kind === "create") {
      if (!tasks.has(op.task.id)) tasks.set(op.task.id, op.task);
    } else if (op.kind === "patch") {
      const t = tasks.get(op.id);
      if (!t) continue;
      const { undo: _undo, ...changes } = op.changes;
      const next: Task = { ...t, ...changes };
      if (changes.completed === true && !t.completed) {
        next.completed_at = nowIso();
        next.checklist = next.checklist.map((i) => ({ ...i, completed: true }));
      } else if (changes.completed === false) next.completed_at = null;
      tasks.set(op.id, next);
    } else if (op.kind === "delete") tasks.delete(op.id);
    else if (op.kind === "project-create") {
      if (!projects.has(op.project.id)) projects.set(op.project.id, op.project);
    } else if (op.kind === "project-patch") {
      const p = projects.get(op.id);
      if (p) projects.set(op.id, { ...p, ...op.changes });
    } else if (op.kind === "project-delete") {
      projects.delete(op.id);
      for (const [id, t] of tasks)
        if (t.project_id === op.id) tasks.set(id, { ...t, project_id: null });
    }
  }
  return { tasks: [...tasks.values()], projects: [...projects.values()] };
}

/* ---------- loading ---------- */

let refreshing: Promise<void> | null = null;
let refreshAgain = false;
/** Fetch everything from the server into the replica. */
export function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      const [tasks, projects] = await Promise.all([
        allTasks(),
        api<Project[]>("/projects"),
      ]);
      server = { tasks, projects };
      saveReplica();
      emit({ online: true, expired: false });
    } catch (e) {
      handleFailure(e);
    } finally {
      refreshing = null;
      if (refreshAgain) {
        refreshAgain = false;
        setTimeout(refresh, 50);
      }
    }
  })();
  return refreshing;
}
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
export function refreshSoon(ms = 150) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

function handleFailure(e: unknown) {
  if (isOffline(e)) emit({ online: false });
  else if ((e as APIError).status === 401) {
    if (state.config.shell || location.pathname.startsWith("/apps/"))
      emit({ expired: true });
    else signedOut();
  } else emit({ problem: (e as Error).message });
}

function signedOut() {
  server = { tasks: [], projects: [] };
  queue = [];
  saveQueue();
  write(REPLICA, null);
  emit({ phase: "signed-out", user: null, expired: false });
}

export async function boot() {
  const replica = read<Replica>(REPLICA);
  if (replica?.user) {
    // Open straight to the last known tasks; the server catches up behind them.
    server = { tasks: replica.tasks, projects: replica.projects };
    emit({ phase: "ready", user: replica.user });
  }
  try {
    const config = await api<Config>("/auth/config").catch((e) => {
      if (isOffline(e)) throw e;
      return state.config;
    });
    emit({ config });
    const user = await api<Profile>("/me");
    if (replica?.user && replica.user.id !== user.id) {
      server = { tasks: [], projects: [] };
      queue = [];
      saveQueue();
    }
    emit({ user, phase: "ready", online: true });
    await refresh();
    flush();
  } catch (e) {
    if (isOffline(e)) {
      if (replica?.user) emit({ online: false });
      else
        emit({
          phase: "signed-out",
          online: false,
          bootError:
            "Can’t reach the server. Check your connection and try again.",
        });
    } else if ((e as APIError).status === 401) {
      if (
        replica?.user &&
        (state.config.shell || location.pathname.startsWith("/apps/"))
      )
        emit({ expired: true });
      else signedOut();
    } else
      emit({
        phase: state.user ? "ready" : "signed-out",
        bootError: (e as Error).message,
      });
  }
  if (new URLSearchParams(location.search).has("auth_error"))
    emit({
      bootError: "Apple sign-in was interrupted or expired. Please try again.",
    });
}

export async function signedIn() {
  const user = await api<Profile>("/me");
  emit({ user, phase: "ready", bootError: "", online: true });
  await refresh();
}

export async function signOut(action: () => Promise<void>) {
  await action();
  signedOut();
}

export const clearProblem = () => emit({ problem: "" });

/* ---------- live updates ---------- */

let live = false;
/** Follow changes from other views and devices. Pauses while the page is hidden. */
export function startLive() {
  if (live) return;
  live = true;
  let source: EventSource | null = null;
  let fallback: ReturnType<typeof setInterval> | undefined;
  const open = () => {
    if (source || typeof EventSource === "undefined" || !state.user) return;
    source = new EventSource("api/v1/events");
    source.onmessage = () => refreshSoon();
    source.onopen = () => {
      clearInterval(fallback);
      fallback = undefined;
    };
    source.onerror = () => {
      // The browser reconnects by itself; poll meanwhile so nothing is missed.
      fallback ||= setInterval(() => {
        refresh();
        flush();
      }, 30000);
    };
  };
  const close = () => {
    source?.close();
    source = null;
  };
  const wake = () => {
    if (document.visibilityState === "hidden") return close();
    open();
    refreshSoon(0);
    flush();
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("focus", () => refreshSoon(0));
  // Another view of the app in this browser changed the replica or the outbox.
  window.addEventListener("storage", (e) => {
    if (e.key === REPLICA) {
      const replica = read<Replica>(REPLICA);
      if (replica && state.user && replica.user.id === state.user.id) {
        server = { tasks: replica.tasks, projects: replica.projects };
        emit();
      }
    } else if (e.key === OUTBOX) {
      queue = read<Op[]>(OUTBOX) || [];
      emit();
    }
  });
  if (document.visibilityState !== "hidden") open();
  setInterval(() => {
    if (queue.length && document.visibilityState !== "hidden") flush();
  }, 15000);
}

/* ---------- outbox ---------- */

const opId = () => crypto.randomUUID();
function enqueue(op: Op) {
  queue = [...storedQueue(), op];
  coalesce();
  saveQueue();
  emit();
  flush();
}
/** Merge a new edit into an earlier queued edit of the same task that has not been sent yet. */
function coalesce() {
  const last = queue[queue.length - 1];
  if (last?.kind !== "patch" || "completed" in last.changes) return;
  // Never into the first operation: some view may be sending it right now.
  for (let i = queue.length - 2; i >= 1; i--) {
    const op = queue[i];
    if (op.kind === "patch" && op.id === last.id) {
      if ("completed" in op.changes) break;
      queue[i] = { ...op, changes: { ...op.changes, ...last.changes } };
      queue.pop();
      return;
    }
    if (op.kind === "create" && op.task.id === last.id) {
      queue[i] = { ...op, task: { ...op.task, ...last.changes } };
      queue.pop();
      return;
    }
    if (("id" in op && op.id === last.id) || op.kind.startsWith("project"))
      break;
  }
}

let flushing = false;
export function flush() {
  if (flushing || !queue.length || !state.user) return;
  flushing = true;
  const run = async () => {
    for (;;) {
      queue = storedQueue();
      const op = queue[0];
      if (!op) break;
      try {
        await send(op);
      } catch (e) {
        if (isOffline(e)) {
          emit({ online: false });
          break;
        }
        const status = (e as APIError).status;
        if (status === 401) {
          handleFailure(e);
          break;
        }
        // Refused (a conflict, a deleted item, bad input): drop it and show the server's copy.
        drop(op);
        emit({
          problem:
            status === 409
              ? "This task changed on another device. Showing the latest."
              : status === 404
                ? ""
                : (e as Error).message,
        });
        refreshSoon(0);
        continue;
      }
      drop(op);
      saveReplica();
      emit({ online: true });
    }
  };
  const done = () => {
    flushing = false;
  };
  if (navigator.locks?.request)
    navigator.locks.request("tasks-outbox", run).then(done, done);
  else run().then(done, done);
}
function drop(op: Op) {
  queue = storedQueue().filter((o) => o.op !== op.op);
  saveQueue();
}
const upsert = <T extends { id: string }>(list: T[], item: T) =>
  list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
const serverVersion = (id: string) =>
  server.tasks.find((t) => t.id === id)?.version;

async function mergeOn409<T>(
  id: string,
  write: (version: number) => Promise<T>,
): Promise<T> {
  const base = serverVersion(id);
  if (base === undefined) throw new APIError(404, "");
  try {
    return await write(base);
  } catch (e) {
    if ((e as APIError).status !== 409) throw e;
    await refresh();
    const fresh = serverVersion(id);
    if (fresh === undefined) throw new APIError(404, "");
    return write(fresh);
  }
}

async function send(op: Op) {
  if (op.kind === "create") {
    const {
      id,
      title,
      description,
      project_id,
      due_date,
      due_time,
      time_zone,
    } = op.task;
    const { reminder_minutes, priority, labels, checklist, recurrence } =
      op.task;
    const task = await api<Task>("/tasks", "POST", {
      id,
      title,
      description,
      project_id,
      due_date,
      due_time,
      time_zone,
      reminder_minutes,
      priority,
      labels,
      checklist,
      recurrence,
    });
    server = { ...server, tasks: upsert(server.tasks, task) };
  } else if (op.kind === "patch") {
    if (serverVersion(op.id) === undefined) await refresh();
    // Only the changed fields are sent, so a 409 (changed on another device) merges field by field:
    // fetch the newer copy and apply these fields on top of it.
    const task = await mergeOn409(op.id, (version) =>
      api<Task>(`/tasks/${op.id}`, "PATCH", { ...op.changes, version }),
    );
    server = { ...server, tasks: upsert(server.tasks, task) };
    if (op.changes.completed !== undefined && task.recurrence) refreshSoon(300);
  } else if (op.kind === "delete") {
    if (serverVersion(op.id) !== undefined)
      await mergeOn409(op.id, (version) =>
        api(`/tasks/${op.id}?version=${version}`, "DELETE"),
      );
    server = { ...server, tasks: server.tasks.filter((t) => t.id !== op.id) };
  } else if (op.kind === "project-create") {
    const project = await api<Project>("/projects", "POST", op.project);
    server = { ...server, projects: upsert(server.projects, project) };
  } else if (op.kind === "project-patch") {
    const project = await api<Project>(
      `/projects/${op.id}`,
      "PATCH",
      op.changes,
    );
    server = { ...server, projects: upsert(server.projects, project) };
  } else if (op.kind === "project-delete") {
    await api(`/projects/${op.id}`, "DELETE").catch((e) => {
      if ((e as APIError).status !== 404) throw e;
    });
    server = {
      tasks: server.tasks.map((t) =>
        t.project_id === op.id ? { ...t, project_id: null } : t,
      ),
      projects: server.projects.filter((p) => p.id !== op.id),
    };
    refreshSoon(300);
  }
}

/* ---------- writes ---------- */

export const blankTask = (): TaskFields => ({
  title: "",
  description: "",
  project_id: null,
  due_date: null,
  due_time: null,
  time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  reminder_minutes: null,
  priority: 4,
  labels: [],
  checklist: [],
  recurrence: null,
});

export function createTask(
  fields: Partial<TaskFields> & { id?: string },
): Task {
  const stamp = nowIso();
  const task: Task = {
    ...blankTask(),
    ...fields,
    id: fields.id || crypto.randomUUID(),
    completed: false,
    completed_at: null,
    created_at: stamp,
    updated_at: stamp,
    version: 1,
  };
  enqueue({ op: opId(), at: Date.now(), kind: "create", task });
  return task;
}
export function patchTask(id: string, changes: TaskChanges) {
  enqueue({ op: opId(), at: Date.now(), kind: "patch", id, changes });
}
export function deleteTask(id: string) {
  enqueue({ op: opId(), at: Date.now(), kind: "delete", id });
}
export function createProject(name: string, color: string): Project {
  const project = { id: crypto.randomUUID(), name, color };
  enqueue({ op: opId(), at: Date.now(), kind: "project-create", project });
  return project;
}
export function patchProject(
  id: string,
  changes: { name: string; color: string },
) {
  enqueue({ op: opId(), at: Date.now(), kind: "project-patch", id, changes });
}
export function deleteProject(id: string) {
  enqueue({ op: opId(), at: Date.now(), kind: "project-delete", id });
}
/** Wait until the outbox is empty (or the server is unreachable). */
export function settled(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!state.pending || !state.online) {
        off();
        resolve();
      }
    };
    const off = subscribe(check);
    check();
  });
}
