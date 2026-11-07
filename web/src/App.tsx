// Tasks. One app that fits wherever it is shown: full screen or a browser tab, a column in
// Personal Command, or the small companion box beside the workspace (westley-app docs/companion.md).
//
// Wide: sidebar (views, projects, labels), the list, and the open task beside it.
// Narrow: the sidebar becomes a drawer and the task opens over the list.
// Phone: a native layout (phone.tsx): bottom tabs, a + button, a quick add sheet on the keyboard,
// swipe actions, and the task full screen.
// Companion: quick add at the top, a view picker, and a compact list.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDownWideNarrow,
  Bell,
  BellOff,
  BellRing,
  CalendarDays,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  CloudOff,
  Copy,
  CopyPlus,
  ExternalLink,
  FolderInput,
  Inbox,
  Layers,
  Link,
  ListChecks,
  ListFilter,
  ListTree,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Repeat2,
  Search,
  Settings,
  Sun,
  Tag,
  Trash2,
  Undo2,
  X,
  Apple,
  CircleSlash,
  Ellipsis,
  Calendar,
  Sunrise,
  Sofa,
  ArrowRightToLine,
} from "lucide-react";
import { findShortRefs } from "@awestley/pc-runtime";
import {
  PcEmbed,
  useCommands,
  useHosted,
  usePaneTitle,
  usePc,
  useSurface,
} from "@awestley/pc-runtime/react";
import { api, localDate, type Project, type Task } from "./api";
import { ContextMenu, type MenuEntry, type MenuRequest } from "./ContextMenu";
import { disableBrowserPush } from "./PushSettings";
import { QuickAdd, type NewTask, type QuickDefaults } from "./QuickAdd";
import { TaskDetail } from "./TaskDetail";
import {
  Modal,
  ProjectEditor,
  SettingsPanel,
  ShortcutsDialog,
} from "./dialogs";
import { isoDate, nextWeekDate, weekendDate } from "./parse";
import {
  autoReminder,
  enableNotifications,
  reminderAt,
  scheduleReminders,
  setAutoReminder,
  showReminder,
  usePermission,
} from "./reminders";
import * as S from "./store";
import {
  BrowseScreen,
  holdKeyboard,
  swipeRow,
  TabBar,
  useKeyboardInset,
  useMedia,
  type PhoneTab,
} from "./phone";
import {
  DatePicker,
  daysFromNow,
  dueLabel,
  dueTone,
  formatTime,
  isOverdue,
  Popover,
  priorityNames,
  PriorityFlag,
  recurrenceLabel,
  reminderChoices,
  reminderLabel,
  weekday,
} from "./ui";

type View =
  | "today"
  | "inbox"
  | "upcoming"
  | "all"
  | "completed"
  | `project:${string}`
  | `label:${string}`;
const LISTS = ["today", "inbox", "upcoming", "all", "completed"] as const;
const viewNames: Record<string, string> = {
  today: "Today",
  inbox: "Inbox",
  upcoming: "Upcoming",
  all: "All tasks",
  completed: "Completed",
};
const viewIcons = {
  today: Sun,
  inbox: Inbox,
  upcoming: CalendarDays,
  all: Layers,
  completed: CheckCheck,
};

// Routes: #/today, #/inbox, #/upcoming, #/all, #/completed, #/project/<id>, #/label/<name>, each
// optionally followed by /task/<id>; #/task/<id> alone opens the task in its own list.
function readRoute(): { view: View | null; taskId: string | null } {
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
function hashFor(view: View, taskId?: string | null) {
  const base = view.startsWith("project:")
    ? "#/project/" + encodeURIComponent(view.slice(8))
    : view.startsWith("label:")
      ? "#/label/" + encodeURIComponent(view.slice(6))
      : "#/" + view;
  return taskId ? `${base}/task/${encodeURIComponent(taskId)}` : base;
}
// Which app owns each short reference type ([[note:…]], ![[task:…]]) in task descriptions.
const TYPE_OWNERS = { task: "tasks", project: "tasks", note: "notes" };
const taskLink = (task: Task) =>
  location.pathname.startsWith("/apps/")
    ? `${location.origin}/?open=${encodeURIComponent(`pc://tasks/task/${task.id}`)}`
    : `${location.origin}${location.pathname}#/task/${encodeURIComponent(task.id)}`;
const editable = "input,textarea,select,a[href],code,[contenteditable]";
const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};

const COMPACT_BELOW = 480;

type Toast = { id: number; text: string; undo?: () => void; error?: boolean };

export function App({ companion = false }: { companion?: boolean }) {
  const pc = usePc();
  const hosted = useHosted();
  const surface = useSurface();
  const phase = S.useStore((s) => s.phase);
  useEffect(() => {
    S.boot();
    S.startLive();
    // The service worker completed a task from a reminder.
    navigator.serviceWorker?.addEventListener("message", (e) => {
      if (e.data?.type === "tasks-changed") S.refreshSoon(0);
    });
    if ("serviceWorker" in navigator && location.protocol !== "file:")
      navigator.serviceWorker.register("./sw.js").catch(() => {});
  }, []);
  // On a Smithy rail or in a small float (smithy-app docs/desk.md), the full app shows its compact
  // layout, the same one companion.html uses, and goes back to full size when it has room again.
  const compact =
    companion ||
    ((surface.kind === "docked" || surface.kind === "floating") &&
      surface.width > 0 &&
      surface.width < COMPACT_BELOW);
  useEffect(() => {
    document.documentElement.classList.toggle("is-companion", compact);
  }, [compact]);
  if (phase === "loading")
    return (
      <div className="loading">
        <LoaderCircle className="spin" />
      </div>
    );
  if (phase === "signed-out") return <SignIn hosted={hosted} />;
  return (
    <Workspace
      companion={compact}
      hosted={hosted}
      width={surface.width}
      surfaceKind={surface.kind}
      detent={surface.detent}
      pc={pc}
    />
  );
}

function Logo() {
  return (
    <div className="brand" aria-hidden="true">
      <span className="brand-mark">
        <Check size={21} strokeWidth={3} />
      </span>
    </div>
  );
}

function SignIn({ hosted }: { hosted: boolean }) {
  const config = S.useStore((s) => s.config);
  const bootError = S.useStore((s) => s.bootError);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shell = config.shell || hosted;
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-label="Sign in">
        <Logo />
        <h1>Sign in</h1>
        <div className="auth-actions">
          {shell && (
            <a
              className="primary"
              target="_top"
              href={
                "/login?next=" +
                encodeURIComponent(location.pathname + location.hash)
              }
            >
              Sign in
            </a>
          )}
          {config.apple_enabled && (
            <a className="apple-button" href="auth/apple/start">
              <Apple size={20} /> Sign in with Apple
            </a>
          )}
          {config.dev_login && (
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api("/auth/dev", "POST");
                  await S.signedIn();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Opening..." : "Open local workspace"}
            </button>
          )}
          {!config.apple_enabled && !shell && !config.dev_login && (
            <p className="auth-note">Apple sign-in is not configured.</p>
          )}
          {(error || bootError) && (
            <div className="error" role="alert">
              <CircleAlert className="error-icon" size={16} />
              <span>{error || bootError}</span>
            </div>
          )}
          {bootError && !error && (
            <button className="secondary" onClick={() => location.reload()}>
              <RefreshCw size={14} /> Try again
            </button>
          )}
        </div>
      </section>
    </main>
  );
}

function Workspace({
  companion,
  hosted,
  width,
  surfaceKind,
  detent,
  pc,
}: {
  companion: boolean;
  hosted: boolean;
  width: number;
  surfaceKind: string;
  detent?: string;
  pc: ReturnType<typeof usePc>;
}) {
  const user = S.useStore((s) => s.user)!;
  const config = S.useStore((s) => s.config);
  const tasks = S.useStore((s) => s.tasks);
  const projects = S.useStore((s) => s.projects);
  const online = S.useStore((s) => s.online);
  const pending = S.useStore((s) => s.pending);
  const expired = S.useStore((s) => s.expired);
  const problem = S.useStore((s) => s.problem);
  const permission = usePermission();

  const initial = readRoute();
  const [view, setView] = useState<View>(
    () =>
      initial.view ||
      (companion ? (read("tasks.companionView") as View) || "today" : "today"),
  );
  const [openId, setOpenId] = useState<string | null>(initial.taskId);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState(read("tasks.sort") || "smart");
  const [priorityFilter, setPriorityFilter] = useState(false);
  const [sidebarPref, setSidebarPref] = useState(
    read("tasks.sidebar") !== "hidden",
  );
  const [drawer, setDrawer] = useState(false);
  const [quick, setQuick] = useState<QuickDefaults | null>(null);
  const [inlineAdd, setInlineAdd] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [picker, setPicker] = useState<{
    task: Task;
    anchor: DOMRect | { x: number; y: number };
  } | null>(null);
  const [bell, setBell] = useState<DOMRect | null>(null);
  const [settings, setSettings] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [projectEditor, setProjectEditor] = useState<Project | "new" | null>(
    null,
  );
  const [toast, setToast] = useState<Toast | null>(null);
  const [finishing, setFinishing] = useState<Set<string>>(new Set());
  const [focusKey, setFocusKey] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hovered = useRef<string | null>(null);
  const press = useRef({ timer: 0, x: 0, y: 0, active: false, until: 0 });
  const pointerType = useRef("mouse");
  const claimed = useRef<Event | null>(null);
  const gPending = useRef(0);
  const lastEscape = useRef(0);

  const today = localDate();
  const wide = !companion && width >= 900;
  const sidebarDocked = wide && sidebarPref;
  const mainWidth = width - (sidebarDocked ? 260 : 0);
  const detailBeside = !companion && mainWidth >= 900;
  const narrow = !companion && width < 700;
  // A phone, or a phone-sized browser window: the native layout. A narrow column on a desktop
  // keeps the drawer layout.
  const coarse = useMedia("(pointer: coarse)");
  const phone = narrow && (coarse || (!hosted && width < 560));
  const [phoneScreen, setPhoneScreen] = useState<"list" | "search" | "browse">(
    "list",
  );
  const [scrolled, setScrolled] = useState(false);
  useKeyboardInset(phone);
  useEffect(() => {
    if (!phone) return;
    const update = () => setScrolled(scrollY > 36);
    addEventListener("scroll", update, { passive: true });
    update();
    return () => removeEventListener("scroll", update);
  }, [phone, phoneScreen, view]);
  const floating = surfaceKind === "floating";
  const peek = surfaceKind === "sheet" && detent === "peek";

  /* ---------- notices ---------- */

  const notify = useCallback(
    (text: string, undo?: () => void) =>
      setToast({ id: Date.now(), text, undo }),
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.undo ? 7000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (problem) {
      setToast({ id: Date.now(), text: problem, error: true });
      S.clearProblem();
    }
  }, [problem]);

  /* ---------- reminders on this device ---------- */

  useEffect(
    () =>
      scheduleReminders(tasks, (task) => {
        const text = `Reminder: ${task.title}${task.due_time ? " · " + formatTime(task.due_time) : ""}`;
        if (hosted) pc.notify(text, "info");
        else notify(text);
      }),
    [tasks, hosted, pc, notify],
  );

  /* ---------- routes ---------- */

  useEffect(() => {
    const follow = () => {
      const route = readRoute();
      if (route.view) setView(route.view);
      setOpenId(route.taskId);
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  // #/task/<id> on its own: show the task's list behind it.
  useEffect(() => {
    if (initial.view || !initial.taskId) return;
    const t = tasks.find((x) => x.id === initial.taskId);
    if (t)
      setView(
        t.completed
          ? "completed"
          : t.project_id
            ? `project:${t.project_id}`
            : "inbox",
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.length > 0]);
  useEffect(() => {
    const target = hashFor(view, openId);
    if (location.hash !== target) history.replaceState(null, "", target + "");
    if (new URLSearchParams(location.search).has("task"))
      history.replaceState(null, "", location.pathname + target);
    if (companion) store("tasks.companionView", view);
  }, [view, openId, companion]);

  function navigate(next: View) {
    setSearch("");
    setDrawer(false);
    setPhoneScreen("list");
    setOpenId(null);
    setSelected(null);
    setInlineAdd(null);
    if (next !== view) {
      setView(next);
      if (!companion) location.hash = hashFor(next);
    }
  }

  /* ---------- derived lists ---------- */

  const active = useMemo(() => tasks.filter((t) => !t.completed), [tasks]);
  const labels = useMemo(
    () => Array.from(new Set(tasks.flatMap((t) => t.labels))).sort(),
    [tasks],
  );
  const selectedProject = view.startsWith("project:")
    ? projects.find((p) => p.id === view.slice(8))
    : null;
  const title = search
    ? "Search"
    : selectedProject?.name ||
      viewNames[view] ||
      (view.startsWith("label:") ? "@" + view.slice(6) : "Tasks");
  const openTask = openId ? tasks.find((t) => t.id === openId) || null : null;
  usePaneTitle(
    openTask && !detailBeside ? openTask.title : companion ? null : title,
  );

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

  type Group = {
    key: string;
    title: React.ReactNode;
    tasks: Task[];
    add?: QuickDefaults;
    overdue?: boolean;
  };
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
              {new Date(d + "T12:00:00").toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
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
      const laterDays = Array.from(new Set(later.map((t) => t.due_date!)));
      return [
        ...lead,
        ...days,
        ...laterDays.map((d) => ({
          key: d,
          title: (
            <>
              {new Date(d + "T12:00:00").toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
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

  /* ---------- actions ---------- */

  const projectName = (id: string | null) =>
    projects.find((p) => p.id === id)?.name || "Inbox";
  function addTask(fields: NewTask) {
    const task = S.createTask(fields);
    const where = [
      projectName(task.project_id),
      task.due_date && dueLabel(task.due_date, task.due_time),
    ]
      .filter(Boolean)
      .join(" · ");
    notify(`Added to ${where}`, () => S.deleteTask(task.id));
    if (
      task.due_time &&
      task.reminder_minutes !== null &&
      permission === "default" &&
      !read("tasks.askedNotify")
    ) {
      store("tasks.askedNotify", "1");
      setTimeout(() => setBell(bellAnchor()), 400);
    }
    return task;
  }
  function toggle(task: Task) {
    if (task.completed) {
      S.patchTask(task.id, { completed: false });
      notify("Task restored", () => S.patchTask(task.id, { completed: true }));
      return;
    }
    S.patchTask(task.id, { completed: true });
    setFinishing((s) => new Set(s).add(task.id));
    setTimeout(
      () =>
        setFinishing((s) => {
          const n = new Set(s);
          n.delete(task.id);
          return n;
        }),
      900,
    );
    if (openId === task.id && !detailBeside) setOpenId(null);
    notify(
      task.recurrence
        ? `Completed. Next: ${recurrenceLabel[task.recurrence].toLowerCase()}`
        : "Task completed",
      () => S.patchTask(task.id, { completed: false, undo: true }),
    );
  }
  function patch(task: Task, changes: S.TaskChanges, message?: string) {
    const before = Object.fromEntries(
      Object.keys(changes).map((k) => [k, task[k as keyof Task]]),
    ) as S.TaskChanges;
    S.patchTask(task.id, changes);
    if (message) notify(message, () => S.patchTask(task.id, before));
  }
  const schedule = (task: Task, due: string | null) =>
    patch(
      task,
      due
        ? { due_date: due }
        : {
            due_date: null,
            due_time: null,
            reminder_minutes: null,
            recurrence: null,
          },
      due ? `Scheduled for ${dueLabel(due)}` : "Date removed",
    );
  const setPriority = (task: Task, p: number) =>
    patch(
      task,
      { priority: p },
      `Priority set to ${priorityNames[p].toLowerCase()}`,
    );
  const duplicate = (task: Task) => {
    const copy = S.createTask({
      title: task.title,
      description: task.description,
      project_id: task.project_id,
      due_date: task.due_date,
      due_time: task.due_time,
      time_zone: task.time_zone,
      reminder_minutes: task.reminder_minutes,
      priority: task.priority,
      labels: task.labels,
      recurrence: task.recurrence,
      checklist: task.checklist.map(({ title, completed }) => ({
        id: crypto.randomUUID(),
        title,
        completed,
      })),
    });
    notify("Task duplicated", () => S.deleteTask(copy.id));
  };
  const removeTask = (task: Task) => {
    S.deleteTask(task.id);
    if (openId === task.id) setOpenId(null);
    notify("Task deleted", () =>
      S.createTask({
        id: task.id,
        title: task.title,
        description: task.description,
        project_id: task.project_id,
        due_date: task.due_date,
        due_time: task.due_time,
        time_zone: task.time_zone,
        reminder_minutes: task.reminder_minutes,
        priority: task.priority,
        labels: task.labels,
        recurrence: task.recurrence,
        checklist: task.checklist,
      }),
    );
  };
  const copy = (text: string, message: string) =>
    navigator.clipboard.writeText(text).then(
      () => notify(message),
      () =>
        setToast({
          id: Date.now(),
          text: "Copying is not available in this browser.",
          error: true,
        }),
    );
  const goToProject = (task: Task) =>
    navigate(task.project_id ? `project:${task.project_id}` : "inbox");
  const rescheduleOverdue = () => {
    const moved = overdue.map((t) => ({ id: t.id, due: t.due_date }));
    for (const t of overdue) S.patchTask(t.id, { due_date: today });
    notify(`${moved.length} moved to today`, () =>
      moved.forEach((m) => S.patchTask(m.id, { due_date: m.due })),
    );
  };
  const openDetail = (task: Task) => {
    setSelected(task.id);
    setOpenId(task.id);
  };
  const openInColumn = (task: Task) =>
    pc.open(`pc://tasks/task/${task.id}`, { placement: "new-column" });
  const openFull = () =>
    pc.open(location.pathname.replace(/companion\.html$/, "") + hashFor(view), {
      placement: "new-column",
    });
  const openQuick = (defaults?: QuickDefaults) => {
    if (companion) {
      setFocusKey(Date.now());
      return;
    }
    holdKeyboard();
    setQuick(
      defaults || {
        project_id: selectedProject?.id ?? null,
        due_date: view === "today" ? today : null,
        labels: view.startsWith("label:") ? [view.slice(6)] : [],
      },
    );
  };
  const newProject = (name: string) => {
    const colors = [
      "#db4035",
      "#ff9933",
      "#7ecc49",
      "#14aaf5",
      "#884dff",
      "#e05194",
      "#299438",
    ];
    return S.createProject(
      name.slice(0, 100),
      colors[projects.length % colors.length],
    );
  };
  const bellAnchor = () =>
    (
      document.querySelector(".bell-button") as HTMLElement | null
    )?.getBoundingClientRect() || new DOMRect(innerWidth - 40, 40, 0, 0);

  /* ---------- menus ---------- */

  const sheet = () => phone || pointerType.current === "touch";
  const dateOptions = (task: Task) => {
    const now = new Date();
    const dates: [string, string, React.ReactNode][] = [
      [
        today,
        `Today · ${weekday(today)}`,
        <span className="day-icon tone-green">
          <Calendar size={20} />
          <b>{now.getDate()}</b>
        </span>,
      ],
      [
        daysFromNow(1),
        `Tomorrow · ${weekday(daysFromNow(1))}`,
        <Sunrise size={20} className="tone-orange" />,
      ],
      [
        isoDate(weekendDate(now)),
        `This weekend · ${weekday(isoDate(weekendDate(now)))}`,
        <Sofa size={20} className="tone-blue" />,
      ],
      [
        isoDate(nextWeekDate(now)),
        `Next week · ${weekday(isoDate(nextWeekDate(now)))}`,
        <ArrowRightToLine size={20} className="tone-purple" />,
      ],
    ];
    return [
      ...dates
        .filter(([d], i) => dates.findIndex(([o]) => o === d) === i)
        .map(([d, label, icon]) => ({
          label,
          icon,
          selected: task.due_date === d,
          action: () => schedule(task, d),
        })),
      {
        label: "No date",
        icon: <CircleSlash size={20} />,
        selected: !task.due_date,
        action: () => schedule(task, null),
      },
      {
        label: "More dates",
        icon: <Ellipsis size={20} />,
        action: () =>
          setPicker({
            task,
            anchor: { x: menu?.x ?? innerWidth / 2, y: menu?.y ?? 120 },
          }),
      },
    ];
  };
  const moveMenu = (task: Task): MenuEntry[] => [
    {
      label: "Inbox",
      icon: <Inbox size={16} />,
      checked: !task.project_id,
      action: () => patch(task, { project_id: null }, "Moved to Inbox"),
    },
    ...projects.map((p) => ({
      label: p.name,
      icon: (
        <span className="project-hash" style={{ color: p.color }}>
          #
        </span>
      ),
      checked: task.project_id === p.id,
      action: () => patch(task, { project_id: p.id }, `Moved to ${p.name}`),
    })),
  ];
  const priorityMenu = (task: Task): MenuEntry[] =>
    [1, 2, 3, 4].map((p) => ({
      label: priorityNames[p],
      icon: <PriorityFlag priority={p} />,
      checked: task.priority === p,
      action: () => setPriority(task, p),
    }));
  function taskMenu(task: Task): MenuEntry[] {
    return [
      {
        label: "Edit",
        icon: <Pencil size={16} />,
        shortcut: "E",
        key: "e",
        action: () => openDetail(task),
      },
      ...(hosted && !companion
        ? []
        : hosted
          ? [
              {
                label: "Open in a column",
                icon: <ExternalLink size={16} />,
                action: () => openInColumn(task),
              },
            ]
          : []),
      {
        label: "Go to project",
        icon: <ListTree size={16} />,
        shortcut: "⇧G",
        action: () => goToProject(task),
      },
      {
        label: task.completed ? "Restore" : "Complete",
        icon: <CheckCircle2 size={16} />,
        shortcut: "C",
        key: "c",
        action: () => toggle(task),
      },
      "separator",
      { row: "Date", shortcut: "T", options: dateOptions(task) },
      {
        row: "Priority",
        shortcut: "1–4",
        options: [1, 2, 3, 4].map((p) => ({
          label: priorityNames[p],
          icon: <PriorityFlag priority={p} size={20} />,
          selected: task.priority === p,
          action: () => setPriority(task, p),
        })),
      },
      "separator",
      ...(task.due_time
        ? [
            {
              label: "Reminder",
              icon: <Bell size={16} />,
              items: [
                {
                  label: "None",
                  checked: task.reminder_minutes === null,
                  action: () =>
                    patch(task, { reminder_minutes: null }, "Reminder removed"),
                },
                ...reminderChoices.map(([minutes, label]) => ({
                  label,
                  checked: task.reminder_minutes === minutes,
                  action: () =>
                    patch(task, { reminder_minutes: minutes }, "Reminder set"),
                })),
              ],
            } as MenuEntry,
          ]
        : []),
      {
        label: "Move to",
        icon: <FolderInput size={16} />,
        shortcut: "V",
        key: "v",
        items: moveMenu(task),
      },
      {
        label: "Duplicate",
        icon: <CopyPlus size={16} />,
        shortcut: "D",
        key: "d",
        action: () => duplicate(task),
      },
      {
        label: "Copy link to task",
        icon: <Link size={16} />,
        action: () => copy(taskLink(task), "Link copied"),
      },
      "separator",
      {
        label: "Delete task",
        icon: <Trash2 size={16} />,
        danger: true,
        confirm: "Confirm delete",
        action: () => removeTask(task),
      },
    ];
  }
  const addTaskIn = (next: View): MenuEntry[] => [
    {
      label: "Add task",
      icon: <Plus size={16} />,
      action: () => {
        navigate(next);
        setTimeout(() =>
          openQuick({
            project_id: next.startsWith("project:") ? next.slice(8) : null,
            due_date: next === "today" ? today : null,
          }),
        );
      },
    },
  ];
  const projectMenu = (project: Project): MenuEntry[] => [
    ...addTaskIn(`project:${project.id}`),
    {
      label: "Edit project",
      icon: <Pencil size={16} />,
      action: () => setProjectEditor(project),
    },
    "separator",
    {
      label: "Delete project",
      icon: <Trash2 size={16} />,
      danger: true,
      confirm: "Confirm delete",
      action: () => {
        S.deleteProject(project.id);
        if (view === `project:${project.id}`) navigate("inbox");
        notify("Project deleted. Its tasks moved to Inbox.");
      },
    },
  ];
  const listMenu = (): MenuEntry[] => [
    {
      label: "Add task",
      icon: <Plus size={16} />,
      shortcut: "Q",
      key: "q",
      action: () => openQuick(),
    },
    "separator",
    {
      label: "Sort by",
      icon: <ArrowDownWideNarrow size={16} />,
      items: [
        ["smart", "Due date"],
        ["priority", "Priority"],
        ["name", "Name"],
      ].map(([value, label]) => ({
        label,
        checked: sort === value,
        action: () => {
          setSort(value);
          store("tasks.sort", value);
        },
      })),
    },
    {
      label: "High priority only",
      icon: <ListFilter size={16} />,
      checked: priorityFilter,
      action: () => setPriorityFilter(!priorityFilter),
    },
    ...(overdue.length
      ? [
          {
            label: "Move overdue to today",
            icon: <CalendarDays size={16} />,
            action: rescheduleOverdue,
          },
        ]
      : []),
    "separator",
    {
      label: "Refresh",
      icon: <RefreshCw size={16} />,
      action: () => S.refresh(),
    },
  ];
  // Right-click opens a menu at the pointer; a touch long-press opens it as a sheet.
  const menuFor = (
    entries: () => MenuEntry[],
    title?: string,
    target?: string,
  ) => ({
    onContextMenu: (e: React.MouseEvent) => {
      if ((e.target as Element).closest(editable)) return;
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(press.current.timer);
      if (press.current.active) return;
      const touch = pointerType.current === "touch";
      press.current.active = touch;
      let { clientX: x, clientY: y } = e;
      if (!x && !y) {
        const box = e.currentTarget.getBoundingClientRect();
        x = box.left + 24;
        y = box.bottom;
      }
      setMenu({ x, y, entries: entries(), title, target, sheet: touch });
    },
    onPointerDown: (e: React.PointerEvent) => {
      pointerType.current = e.pointerType;
      if (e.pointerType !== "touch" || claimed.current === e.nativeEvent)
        return;
      claimed.current = e.nativeEvent;
      clearTimeout(press.current.timer);
      press.current.x = e.clientX;
      press.current.y = e.clientY;
      press.current.timer = window.setTimeout(() => {
        press.current.active = true;
        navigator.vibrate?.(10);
        getSelection()?.removeAllRanges();
        setMenu({
          x: press.current.x,
          y: press.current.y,
          entries: entries(),
          title,
          target,
          sheet: true,
        });
      }, 450);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (
        Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8
      )
        clearTimeout(press.current.timer);
    },
  });
  const openMenuAt = (
    e: React.MouseEvent,
    entries: MenuEntry[],
    title?: string,
    target?: string,
  ) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: box.right,
      y: box.bottom + 4,
      entries,
      title,
      target,
      sheet: sheet(),
    });
  };

  /* ---------- page behaviour ---------- */

  useEffect(() => {
    // Behave like an app: no browser context menu outside text and links.
    const native = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest?.(editable) && !getSelection()?.toString())
        e.preventDefault();
    };
    const released = () => {
      clearTimeout(press.current.timer);
      if (press.current.active) press.current.until = Date.now() + 400;
      press.current.active = false;
    };
    const swallow = (e: MouseEvent) => {
      if (Date.now() < press.current.until) {
        e.preventDefault();
        e.stopPropagation();
        press.current.until = 0;
      }
    };
    document.addEventListener("contextmenu", native);
    document.addEventListener("pointerup", released, true);
    document.addEventListener("pointercancel", released, true);
    document.addEventListener("click", swallow, true);
    return () => {
      document.removeEventListener("contextmenu", native);
      document.removeEventListener("pointerup", released, true);
      document.removeEventListener("pointercancel", released, true);
      document.removeEventListener("click", swallow, true);
    };
  }, []);

  useCommands(
    [
      { id: "new-task", label: "New task", shortcut: "Mod+Shift+T" },
      { id: "search-tasks", label: "Search tasks" },
      { id: "reminders", label: "Task reminders" },
      { id: "settings", label: "Tasks settings" },
    ],
    (id) => {
      if (id === "new-task") openQuick();
      if (id === "search-tasks") {
        if (companion) openFull();
        else searchRef.current?.focus();
      }
      if (id === "reminders") setBell(bellAnchor());
      if (id === "settings") setSettings(true);
    },
  );

  const target = () =>
    flat.find((t) => t.id === (selected || hovered.current)) || null;
  const modalOpen = !!(
    quick ||
    settings ||
    shortcuts ||
    projectEditor ||
    menu ||
    picker ||
    bell
  );
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const typing = (e.target as HTMLElement).matches?.(
      "input,textarea,select,[contenteditable]",
    );
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z" && !typing && toast?.undo) {
      e.preventDefault();
      toast.undo();
      setToast({ id: Date.now(), text: "Undone" });
      return;
    }
    if (mod && e.key.toLowerCase() === "k" && !hosted) {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (mod && e.key === "Enter" && companion && !typing) {
      const t = target();
      if (t) openInColumn(t);
      return;
    }
    if (e.key === "Escape") {
      if (modalOpen) return; // the dialog or menu closes itself
      if (typing) return;
      if (openId) {
        setOpenId(null);
        return;
      }
      if (inlineAdd) return setInlineAdd(null);
      if (search) return setSearch("");
      if (drawer) return setDrawer(false);
      if (selected) return setSelected(null);
      if (companion && hosted) {
        if (Date.now() - lastEscape.current < 600) pc.companion.hide();
        lastEscape.current = Date.now();
        (document.activeElement as HTMLElement | null)?.blur();
      }
      return;
    }
    if (typing || mod || e.altKey || modalOpen) return;
    const key = e.key;
    if (Date.now() - gPending.current < 900) {
      gPending.current = 0;
      const go = {
        t: "today",
        i: "inbox",
        u: "upcoming",
        c: "completed",
        a: "all",
      }[key.toLowerCase()];
      if (go) {
        e.preventDefault();
        navigate(go as View);
        return;
      }
    }
    if (key === "g") {
      gPending.current = Date.now();
      return;
    }
    if (key === "q") {
      e.preventDefault();
      return openQuick();
    }
    if (key === "a" && !companion) {
      e.preventDefault();
      const last = groups.filter((g) => g.add).at(-1);
      if (last) setInlineAdd(last.key);
      return;
    }
    if (key === "/") {
      e.preventDefault();
      if (companion) setFocusKey(Date.now());
      else searchRef.current?.focus();
      return;
    }
    if (key === "?") return setShortcuts(true);
    if (key === "m" && !companion && !phone) {
      if (wide) {
        setSidebarPref(!sidebarPref);
        store("tasks.sidebar", sidebarPref ? "hidden" : "shown");
      } else setDrawer(!drawer);
      return;
    }
    if (
      key === "j" ||
      key === "k" ||
      key === "ArrowDown" ||
      key === "ArrowUp"
    ) {
      e.preventDefault();
      const i = flat.findIndex((t) => t.id === selected);
      const next =
        flat[
          Math.max(
            0,
            Math.min(
              flat.length - 1,
              i + (key === "j" || key === "ArrowDown" ? 1 : -1),
            ),
          )
        ];
      if (next) {
        setSelected(next.id);
        if (openId && detailBeside) setOpenId(next.id);
        requestAnimationFrame(() =>
          (
            listRef.current?.querySelector(
              `[data-id="${CSS.escape(next.id)}"]`,
            ) as HTMLElement | null
          )?.focus(),
        );
      }
      return;
    }
    const t = target();
    if (!t) return;
    if (key === "Enter" || key === "e") openDetail(t);
    else if (key === "c" || (key === " " && companion)) toggle(t);
    else if (key === "d") duplicate(t);
    else if (key === "G") goToProject(t);
    else if (key === "t") {
      const row = listRef.current?.querySelector(
        `[data-id="${CSS.escape(t.id)}"]`,
      );
      const box = row?.getBoundingClientRect();
      setPicker({
        task: t,
        anchor: box ? { x: box.left + 40, y: box.bottom } : { x: 100, y: 100 },
      });
    } else if (key === "T") schedule(t, null);
    else if (key === "v") {
      const row = listRef.current?.querySelector(
        `[data-id="${CSS.escape(t.id)}"]`,
      );
      const box = row?.getBoundingClientRect() || new DOMRect(100, 100, 0, 0);
      setMenu({
        x: box.left + 40,
        y: box.bottom,
        entries: moveMenu(t),
        title: "Move to",
        target: t.id,
        sheet: false,
      });
    } else if (["1", "2", "3", "4"].includes(key)) setPriority(t, Number(key));
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /* ---------- pieces ---------- */

  // On a phone a row also swipes: right completes, left schedules.
  const rowHandlers = (task: Task) => {
    const menuProps = menuFor(() => taskMenu(task), task.title, task.id);
    if (!phone) return menuProps;
    const swipe = swipeRow({
      right: () => toggle(task),
      left: () =>
        setMenu({
          x: innerWidth / 2,
          y: innerHeight / 2,
          entries: dateOptions(task),
          title: "Schedule",
          target: task.id,
          sheet: true,
        }),
      began: () => clearTimeout(press.current.timer),
    });
    return {
      ...menuProps,
      ...swipe,
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        menuProps.onPointerDown(e);
        swipe.onPointerDown(e);
      },
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        menuProps.onPointerMove(e);
        swipe.onPointerMove(e);
      },
    };
  };

  const taskRow = (task: Task, inGroup?: string) => {
    const project = projects.find((p) => p.id === task.project_id);
    const done = task.completed;
    const checklistDone = task.checklist.filter((i) => i.completed).length;
    const showDate =
      task.due_date &&
      !(
        view === "today" &&
        task.due_date === today &&
        !task.due_time &&
        inGroup !== "search"
      ) &&
      !(view === "upcoming" && inGroup === task.due_date && !task.due_time);
    const meta = (
      <span className="task-meta">
        {showDate && (
          <span className={`due ${dueTone(task.due_date, done)}`}>
            <CalendarDays size={12} />
            {view === "upcoming" && inGroup === task.due_date && task.due_time
              ? formatTime(task.due_time)
              : view === "today" && task.due_date === today && task.due_time
                ? formatTime(task.due_time)
                : dueLabel(task.due_date, task.due_time)}
            {task.recurrence && (
              <Repeat2
                size={12}
                aria-label={recurrenceLabel[task.recurrence]}
              />
            )}
          </span>
        )}
        {!showDate && task.recurrence && (
          <span className="due tone-muted">
            <Repeat2 size={12} aria-label={recurrenceLabel[task.recurrence]} />
          </span>
        )}
        {task.reminder_minutes !== null && task.due_time && !done && (
          <span
            className="has-reminder"
            title={reminderLabel(task.reminder_minutes)}
          >
            <Bell size={11} />
          </span>
        )}
        {task.checklist.length > 0 && (
          <span
            className="checklist-progress"
            aria-label={`${checklistDone} of ${task.checklist.length} checklist items completed`}
          >
            <ListChecks size={13} />
            {checklistDone}/{task.checklist.length}
          </span>
        )}
        {task.labels.map((l) => (
          <span key={l} className="label">
            <Tag size={11} />
            {l}
          </span>
        ))}
        {(companion || phone) &&
          view !== `project:${task.project_id}` &&
          (project || view !== "inbox") && (
            <span className="row-project">
              <span style={{ color: project?.color || "var(--text-faint)" }}>
                #
              </span>
              {project?.name || "Inbox"}
            </span>
          )}
      </span>
    );
    return (
      <div
        key={task.id}
        data-id={task.id}
        tabIndex={
          selected === task.id || (!selected && flat[0]?.id === task.id)
            ? 0
            : -1
        }
        className={`task-row ${done ? "is-complete" : ""} ${finishing.has(task.id) ? "is-finishing" : ""} ${menu?.target === task.id ? "menu-target" : ""} ${selected === task.id ? "is-selected" : ""} ${openId === task.id ? "is-open" : ""}`}
        onMouseEnter={() => (hovered.current = task.id)}
        onMouseLeave={() => (hovered.current = null)}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setSelected(task.id);
        }}
        {...rowHandlers(task)}
      >
        {phone && (
          <>
            <span className="swipe-act is-done" aria-hidden="true">
              <Check size={22} strokeWidth={2.5} />
            </span>
            <span className="swipe-act is-date" aria-hidden="true">
              <CalendarDays size={22} />
            </span>
          </>
        )}
        <button
          className={`check-task priority-${task.priority}`}
          aria-label={`${done ? "Restore" : "Complete"} ${task.title}`}
          tabIndex={-1}
          onClick={() => toggle(task)}
        >
          <Check size={12} strokeWidth={3} />
        </button>
        <button
          className="task-body"
          tabIndex={-1}
          onClick={() => openDetail(task)}
        >
          <span className="task-title">{task.title}</span>
          {task.description && !companion && (
            <span className="task-description">{task.description}</span>
          )}
          {meta}
        </button>
        {!companion && (
          <div className="row-actions">
            <button
              className="icon-button"
              tabIndex={-1}
              aria-label={`Edit ${task.title}`}
              title="Edit"
              onClick={() => openDetail(task)}
            >
              <Pencil size={15} />
            </button>
            <button
              className="icon-button"
              tabIndex={-1}
              aria-label={`Set date for ${task.title}`}
              title="Date"
              onClick={(e) =>
                setPicker({
                  task,
                  anchor: (
                    e.currentTarget as HTMLElement
                  ).getBoundingClientRect(),
                })
              }
            >
              <CalendarDays size={15} />
            </button>
          </div>
        )}
        {!companion && !view.startsWith("project:") && (
          <button
            className="task-project"
            tabIndex={-1}
            onClick={() => goToProject(task)}
          >
            {project?.name || "Inbox"}
            <span style={{ color: project?.color || "var(--text-muted)" }}>
              #
            </span>
          </button>
        )}
        <button
          className="icon-button row-menu"
          tabIndex={-1}
          aria-label={`More actions for ${task.title}`}
          aria-haspopup="menu"
          onClick={(e) => openMenuAt(e, taskMenu(task), task.title, task.id)}
        >
          <MoreHorizontal size={18} />
        </button>
      </div>
    );
  };

  const sections = (
    <div className="task-groups" ref={listRef} role="list">
      {groups.map((g) => {
        const isUpcomingDay = view === "upcoming" && !g.overdue && !!g.add;
        if (
          !g.tasks.length &&
          !isUpcomingDay &&
          g.key !== "main" &&
          g.key !== "search"
        )
          return null;
        return (
          <section
            className={`task-section ${g.overdue ? "is-overdue" : ""}`}
            key={g.key}
            data-group={g.key}
          >
            {g.title && (
              <h3 className={g.overdue ? "overdue" : ""}>
                <span className="group-title">{g.title}</span>
                {g.key !== "main" && g.key !== "search" && (
                  <span className="group-count">{g.tasks.length || ""}</span>
                )}
                {g.overdue && (
                  <button onClick={rescheduleOverdue} title="Move all to today">
                    Reschedule
                  </button>
                )}
              </h3>
            )}
            {g.tasks.map((t) => taskRow(t, g.key))}
            {g.add &&
              view !== "completed" &&
              !search &&
              (!phone || view === "upcoming") &&
              (inlineAdd === g.key ? (
                <QuickAdd
                  variant="inline"
                  projects={projects}
                  labels={labels}
                  defaults={g.add}
                  add={addTask}
                  createProject={newProject}
                  close={() => setInlineAdd(null)}
                  autoFocus
                />
              ) : (
                !companion && (
                  <button
                    className="add-task-row"
                    onClick={() =>
                      phone ? openQuick(g.add) : setInlineAdd(g.key)
                    }
                  >
                    <Plus size={18} /> Add task
                    {g.key === "main" && (
                      <span>
                        or press <kbd>Q</kbd>
                      </span>
                    )}
                  </button>
                )
              ))}
          </section>
        );
      })}
      {!shown.length && (
        <div className="empty-state">
          <div>
            <CheckCheck size={30} />
          </div>
          <h2>
            {search
              ? "Nothing found"
              : view === "completed"
                ? "No completed tasks"
                : view === "today"
                  ? "All clear for today"
                  : "No tasks"}
          </h2>
          <p>
            {search
              ? "Try a different search."
              : view === "completed"
                ? "Completed tasks show up here."
                : companion
                  ? "Type above to add one."
                  : phone
                    ? "Tap + to add one."
                    : "Press Q to add one."}
          </p>
        </div>
      )}
    </div>
  );

  const bellButton = (
    <button
      className={`icon-button bell-button ${permission === "granted" ? "is-on" : ""}`}
      aria-label="Reminders"
      title={
        permission === "granted" ? "Reminders are on" : "Turn on reminders"
      }
      onClick={(e) =>
        setBell((e.currentTarget as HTMLElement).getBoundingClientRect())
      }
    >
      {permission === "granted" ? <Bell size={17} /> : <BellOff size={17} />}
      {permission === "default" && <span className="dot" />}
    </button>
  );

  const status =
    !online || pending ? (
      <div
        className={`sync-status ${online ? "" : "is-offline"}`}
        role="status"
      >
        {online ? (
          <RefreshCw size={12} className="spin" />
        ) : (
          <CloudOff size={12} />
        )}
        {online
          ? "Saving…"
          : pending
            ? `Offline · ${pending} change${pending === 1 ? "" : "s"} will sync`
            : "Offline"}
      </div>
    ) : null;

  const expiredBanner = expired && (
    <div className="expired-banner" role="alert">
      <CircleAlert size={15} />
      <span>Signed out. Changes are kept here until you sign in.</span>
      <a
        target="_top"
        href={
          hosted || location.pathname.startsWith("/apps/")
            ? "/login?next=" +
              encodeURIComponent(location.pathname + location.hash)
            : "./"
        }
      >
        Sign in
      </a>
    </div>
  );

  const counts = {
    today: active.filter((t) => t.due_date && t.due_date <= today).length,
    inbox: active.filter((t) => !t.project_id).length,
    upcoming: active.filter((t) => t.due_date && t.due_date > today).length,
    all: active.length,
    completed: tasks.length - active.length,
  };

  const sidebar = !companion && (
    <aside
      className={`sidebar ${drawer ? "open" : ""}`}
      aria-label="Navigation"
    >
      <div className="sidebar-top">
        {!hosted ? <Logo /> : <span />}
        {wide && (
          <button
            className="icon-button"
            aria-label="Hide sidebar"
            title="Hide sidebar (M)"
            onClick={() => {
              setSidebarPref(false);
              store("tasks.sidebar", "hidden");
            }}
          >
            <PanelLeft size={17} />
          </button>
        )}
      </div>
      {!hosted && (
        <button className="workspace-switch" onClick={() => setSettings(true)}>
          <span className="avatar">{user.name.slice(0, 1)}</span>
          <span>
            {user.name}
            <small>Personal workspace</small>
          </span>
          <ChevronDown size={14} />
        </button>
      )}
      <button className="quick-add" onClick={() => openQuick()}>
        <Plus size={18} /> Add task <kbd>Q</kbd>
      </button>
      <nav>
        {(["inbox", "today", "upcoming", "all", "completed"] as const).map(
          (item) => {
            const Icon = viewIcons[item];
            return (
              <button
                className={view === item && !search ? "active" : ""}
                onClick={() => navigate(item)}
                key={item}
                {...(item !== "completed" && menuFor(() => addTaskIn(item)))}
              >
                <Icon size={18} className={`nav-${item}`} />
                <span>{viewNames[item]}</span>
                <small>{counts[item] || ""}</small>
              </button>
            );
          },
        )}
      </nav>
      <div className="sidebar-heading">
        My projects
        <button
          className="icon-button"
          aria-label="Add project"
          onClick={() => setProjectEditor("new")}
        >
          <Plus size={16} />
        </button>
      </div>
      <nav>
        {projects.map((p) => (
          <button
            key={p.id}
            className={view === `project:${p.id}` ? "active" : ""}
            onClick={() => navigate(`project:${p.id}`)}
            {...menuFor(() => projectMenu(p), p.name)}
          >
            <span className="project-hash" style={{ color: p.color }}>
              #
            </span>
            <span>{p.name}</span>
            <small>
              {active.filter((t) => t.project_id === p.id).length || ""}
            </small>
          </button>
        ))}
        {!projects.length && (
          <p className="sidebar-hint">
            Add one with +, or type #Name in quick add
          </p>
        )}
      </nav>
      <div className="sidebar-heading">
        Labels
        <Tag size={13} />
      </div>
      <nav>
        {labels.map((l) => (
          <button
            key={l}
            className={view === `label:${l}` ? "active" : ""}
            onClick={() => navigate(`label:${l}`)}
          >
            <span className="label-dot" />
            <span>{l}</span>
            <small>
              {active.filter((t) => t.labels.includes(l)).length || ""}
            </small>
          </button>
        ))}
        {!labels.length && (
          <p className="sidebar-hint">Type @label in quick add</p>
        )}
      </nav>
      <div className="sidebar-bottom">
        {status}
        <button onClick={() => setSettings(true)}>
          <Settings size={17} /> Settings & integrations
        </button>
      </div>
    </aside>
  );

  const detail = openTask && (
    <TaskDetail
      key={openTask.id}
      task={openTask}
      projects={projects}
      allLabels={labels}
      overlay={!detailBeside}
      toggle={() => toggle(openTask)}
      patch={(changes) => S.patchTask(openTask.id, changes)}
      remove={() => removeTask(openTask)}
      close={() => setOpenId(null)}
      openMenu={(e, entries, title) =>
        openMenuAt(
          e,
          entries || taskMenu(openTask),
          title || openTask.title,
          openTask.id,
        )
      }
      projectMenu={() => moveMenu(openTask)}
      priorityMenu={() => priorityMenu(openTask)}
      openInColumn={
        hosted && (companion || detailBeside)
          ? () => openInColumn(openTask)
          : undefined
      }
      linked={<Linked text={openTask.description} />}
    />
  );

  const viewOptions: [View, string, React.ReactNode][] = [
    ["today", "Today", null],
    ["inbox", "Inbox", null],
    ["upcoming", "Upcoming", null],
    ["all", "All tasks", null],
    ["completed", "Completed", null],
    ...projects.map((p): [View, string, React.ReactNode] => [
      `project:${p.id}`,
      "# " + p.name,
      null,
    ]),
    ...labels.map((l): [View, string, React.ReactNode] => [
      `label:${l}`,
      "@" + l,
      null,
    ]),
  ];

  // Menus, notices and dialogs, shared by the full and phone layouts.
  const overlays = (
    <>
      {menu && <ContextMenu request={menu} close={() => setMenu(null)} />}
      {toast && (
        <ToastView
          toast={toast}
          close={() => setToast(null)}
          top={phone && !!quick}
        />
      )}
      {picker && (
        <DatePicker
          anchor={picker.anchor}
          value={picker.task}
          close={() => setPicker(null)}
          change={(next) => patchDue(picker.task, next)}
        />
      )}
      {bell && (
        <BellPanel
          anchor={bell}
          close={() => setBell(null)}
          tasks={tasks}
          hosted={hosted}
        />
      )}
      {quick && (
        <Modal
          close={() => setQuick(null)}
          label="Add task"
          className={`is-quick${phone ? " is-sheet" : ""}`}
        >
          <QuickAdd
            variant="modal"
            projects={projects}
            labels={labels}
            defaults={quick}
            add={addTask}
            createProject={newProject}
            close={() => setQuick(null)}
            sheet={phone}
            autoFocus
          />
        </Modal>
      )}
      {projectEditor && (
        <ProjectEditor
          project={projectEditor === "new" ? null : projectEditor}
          close={() => setProjectEditor(null)}
          save={(name, color) => {
            if (projectEditor === "new") {
              const p = S.createProject(name, color);
              navigate(`project:${p.id}`);
            } else S.patchProject(projectEditor.id, { name, color });
            setProjectEditor(null);
          }}
          remove={
            projectEditor === "new"
              ? undefined
              : () => {
                  S.deleteProject(projectEditor.id);
                  navigate("inbox");
                  setProjectEditor(null);
                }
          }
        />
      )}
      {settings && (
        <SettingsPanel
          user={user}
          shell={!!config.shell || hosted}
          close={() => setSettings(false)}
          openShortcuts={() => {
            setSettings(false);
            setShortcuts(true);
          }}
          logout={() =>
            S.signOut(async () => {
              await disableBrowserPush().catch(() => {});
              await api("/auth/logout", "POST");
            }).then(
              () => setSettings(false),
              (e) => setToast({ id: Date.now(), text: e.message, error: true }),
            )
          }
          deleteAccount={() =>
            S.signOut(() => api("/me", "DELETE")).then(
              () => setSettings(false),
              (e) => setToast({ id: Date.now(), text: e.message, error: true }),
            )
          }
        />
      )}
      {shortcuts && <ShortcutsDialog close={() => setShortcuts(false)} />}
    </>
  );

  /* ---------- companion ---------- */

  if (companion)
    return (
      <div
        className={`companion is-${surfaceKind}${peek ? " is-peek" : ""}${floating ? " is-floating" : ""}`}
      >
        {!peek && (
          <header className="companion-head">
            <select
              className="gl-dropdown"
              aria-label="List"
              value={view}
              onChange={(e) => navigate(e.target.value as View)}
            >
              {viewOptions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <span className="companion-count">
              {flat.filter((t) => !t.completed).length || ""}
            </span>
            <span className="spacer" />
            {status}
            {bellButton}
            {hosted && (
              <button
                className="icon-button"
                title="Open in a column"
                aria-label="Open in a column"
                onClick={openFull}
              >
                <ExternalLink size={15} />
              </button>
            )}
          </header>
        )}
        {expiredBanner}
        <QuickAdd
          variant="bar"
          projects={projects}
          labels={labels}
          defaults={{
            project_id: selectedProject?.id ?? null,
            due_date: view === "today" ? today : null,
            labels: view.startsWith("label:") ? [view.slice(6)] : [],
          }}
          add={addTask}
          createProject={newProject}
          focusKey={focusKey}
          placeholder={
            view === "today" ? "Add a task for today" : `Add to ${title}`
          }
        />
        {!peek && <div className="companion-list">{sections}</div>}
        {openTask && <div className="companion-detail">{detail}</div>}
        {toast && (
          <ToastView toast={toast} close={() => setToast(null)} compact />
        )}
        {menu && <ContextMenu request={menu} close={() => setMenu(null)} />}
        {picker && (
          <DatePicker
            anchor={picker.anchor}
            value={picker.task}
            close={() => setPicker(null)}
            change={(next) => patchDue(picker.task, next)}
          />
        )}
        {bell && (
          <BellPanel
            anchor={bell}
            close={() => setBell(null)}
            tasks={tasks}
            hosted={hosted}
          />
        )}
        {shortcuts && <ShortcutsDialog close={() => setShortcuts(false)} />}
      </div>
    );

  function patchDue(
    task: Task,
    next: {
      due_date: string | null;
      due_time: string | null;
      recurrence: string | null;
    },
  ) {
    patch(
      task,
      {
        due_date: next.due_date,
        due_time: next.due_date ? next.due_time : null,
        recurrence: next.due_date
          ? (next.recurrence as Task["recurrence"])
          : null,
        reminder_minutes:
          next.due_date && next.due_time
            ? task.due_time
              ? task.reminder_minutes
              : autoReminder()
            : null,
      },
      next.due_date
        ? `Scheduled for ${dueLabel(next.due_date, next.due_time)}`
        : "Date removed",
    );
  }

  /* ---------- phone ---------- */

  if (phone) {
    const tab: PhoneTab =
      phoneScreen !== "list"
        ? phoneScreen
        : view === "today" || view === "inbox" || view === "upcoming"
          ? view
          : "browse";
    const goTab = (next: PhoneTab) => {
      if (next === tab && phoneScreen === "list")
        return scrollTo({ top: 0, behavior: "smooth" });
      setOpenId(null);
      setSelected(null);
      if (next === "search") {
        holdKeyboard();
        setPhoneScreen("search");
      } else if (next === "browse") {
        setSearch("");
        setPhoneScreen("browse");
      } else navigate(next);
      scrollTo({ top: 0 });
    };
    const open = shown.filter((t) => !t.completed).length;
    const subtitle =
      view === "upcoming"
        ? null
        : view === "completed"
          ? `${shown.length} completed`
          : open
            ? `${open} ${open === 1 ? "task" : "tasks"}`
            : null;
    const viewButton = (
      <button
        className="icon-button"
        aria-label="View options"
        onClick={(e) => openMenuAt(e, listMenu().slice(2), "View")}
      >
        <MoreHorizontal size={22} />
      </button>
    );
    const page =
      phoneScreen === "browse" ? (
        <BrowseScreen
          projects={projects}
          labels={labels}
          counts={counts}
          projectCount={(id) =>
            active.filter((t) => t.project_id === id).length
          }
          labelCount={(l) => active.filter((t) => t.labels.includes(l)).length}
          go={(next) => navigate(next as View)}
          addProject={() => setProjectEditor("new")}
          projectProps={(p) => menuFor(() => projectMenu(p), p.name)}
          reminders={permission === "granted"}
          openReminders={(anchor) => setBell(anchor)}
          openSettings={() => setSettings(true)}
          openShortcuts={coarse ? undefined : () => setShortcuts(true)}
          status={status}
        />
      ) : phoneScreen === "search" ? (
        <div className="phone-page">
          <header className="phone-head">
            <div className="phone-bar">
              <span />
              <span className="phone-bar-title">Search</span>
              <div className="phone-bar-actions">{status}</div>
            </div>
            <h1>Search</h1>
            <div className="search-box phone-search">
              <Search size={18} />
              <input
                ref={searchRef}
                type="search"
                enterKeyHint="search"
                autoFocus
                placeholder="Tasks, descriptions and labels"
                aria-label="Search tasks"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "Escape")
                    e.currentTarget.blur();
                }}
              />
              {search && (
                <button aria-label="Clear search" onClick={() => setSearch("")}>
                  <X size={16} />
                </button>
              )}
            </div>
          </header>
          {search ? (
            <main className="task-main">{sections}</main>
          ) : (
            <p className="phone-hint">
              Search task names, descriptions and labels.
            </p>
          )}
        </div>
      ) : (
        <div className="phone-page">
          <header className="phone-head">
            <div className="phone-bar">
              {tab === "browse" ? (
                <button
                  className="phone-back"
                  onClick={() => {
                    setPhoneScreen("browse");
                    scrollTo({ top: 0 });
                  }}
                >
                  <ChevronLeft size={24} />
                  Browse
                </button>
              ) : (
                <span />
              )}
              <span className="phone-bar-title">{title}</span>
              <div className="phone-bar-actions">
                {status}
                {selectedProject && (
                  <button
                    className="icon-button"
                    aria-label="Edit project"
                    onClick={() => setProjectEditor(selectedProject)}
                  >
                    <Pencil size={19} />
                  </button>
                )}
                {bellButton}
                {viewButton}
              </div>
            </div>
            <h1>
              {selectedProject && (
                <span
                  className="project-hash"
                  style={{ color: selectedProject.color }}
                >
                  #
                </span>
              )}
              {title}
            </h1>
            {subtitle && <p className="phone-sub">{subtitle}</p>}
          </header>
          {expiredBanner}
          {view === "upcoming" && (
            <WeekStrip
              tasks={active}
              jump={(d) => {
                const el = listRef.current?.querySelector(
                  `[data-group="${d}"]`,
                ) as HTMLElement | null;
                if (el)
                  scrollTo({
                    top: el.getBoundingClientRect().top + scrollY - 64,
                    behavior: "smooth",
                  });
              }}
            />
          )}
          <main className="task-main" {...menuFor(listMenu, title)}>
            {sections}
          </main>
        </div>
      );
    // Same root and the overlays in the same place as the full layout, so a rotation or a
    // resize between the two keeps an open sheet and what was typed in it.
    return (
      <div
        className={`app-shell is-phone${hosted ? " hosted" : ""}${scrolled ? " is-scrolled" : ""}${toast && !quick ? " has-toast" : ""}${openTask ? " has-detail" : ""}`}
      >
        <React.Fragment key="phone">
          {page}
          {phoneScreen !== "search" && (
            <button
              className="fab"
              aria-label="Add task"
              onClick={() =>
                openQuick(phoneScreen === "browse" ? {} : undefined)
              }
            >
              <Plus size={28} strokeWidth={2.25} />
            </button>
          )}
          <TabBar tab={tab} go={goTab} />
          {detail}
        </React.Fragment>
        {overlays}
      </div>
    );
  }

  /* ---------- full app ---------- */

  return (
    <div
      className={`app-shell ${hosted ? "hosted" : ""} ${sidebarDocked ? "" : "no-sidebar"} ${narrow ? "is-narrow" : ""} ${openTask && detailBeside ? "with-detail" : ""}`}
    >
      <React.Fragment key="full">
        {sidebar}
        {drawer && !sidebarDocked && (
          <button
            className="mobile-shade"
            aria-label="Close navigation"
            onClick={() => setDrawer(false)}
          />
        )}
        <div className="main-shell">
          <header className="topbar">
            {!sidebarDocked && (
              <button
                className="icon-button mobile-menu"
                aria-label={wide ? "Show sidebar" : "Open navigation"}
                title={wide ? "Show sidebar (M)" : "Navigation"}
                onClick={() => {
                  if (wide) {
                    setSidebarPref(true);
                    store("tasks.sidebar", "shown");
                  } else setDrawer(true);
                }}
              >
                {wide ? <PanelLeft size={18} /> : <Menu size={20} />}
              </button>
            )}
            {!hosted && (
              <div className="breadcrumb">
                My workspace <span className="crumb-sep">/</span>{" "}
                <span>{title}</span>
              </div>
            )}
            <span className="spacer" />
            <div className="search-box">
              <Search size={16} />
              <input
                ref={searchRef}
                placeholder="Search tasks"
                aria-label="Search tasks"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearch("");
                    e.currentTarget.blur();
                  } else if (e.key === "ArrowDown" || e.key === "Enter") {
                    e.preventDefault();
                    const first = flat[0];
                    if (first) {
                      setSelected(first.id);
                      (
                        listRef.current?.querySelector(
                          `[data-id="${CSS.escape(first.id)}"]`,
                        ) as HTMLElement | null
                      )?.focus();
                    }
                  }
                }}
              />
              {search ? (
                <button aria-label="Clear search" onClick={() => setSearch("")}>
                  <X size={14} />
                </button>
              ) : (
                <kbd>{hosted ? "/" : "⌘ K"}</kbd>
              )}
            </div>
            {bellButton}
            {!hosted && (
              <button
                className="top-avatar"
                aria-label="Open settings"
                onClick={() => setSettings(true)}
              >
                {user.name.slice(0, 1)}
              </button>
            )}
          </header>
          {expiredBanner}
          <div className="content-layout">
            <main className="task-main" {...menuFor(listMenu, title)}>
              <div className="page-title">
                <h1>
                  {selectedProject && (
                    <span
                      className="project-hash"
                      style={{ color: selectedProject.color }}
                    >
                      #
                    </span>
                  )}
                  {title}
                </h1>
                <div>
                  {selectedProject && (
                    <button
                      className="icon-button"
                      aria-label="Edit project"
                      onClick={() => setProjectEditor(selectedProject)}
                    >
                      <Pencil size={18} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    aria-label="View options"
                    title="Sort and filter"
                    onClick={(e) => openMenuAt(e, listMenu().slice(2), "View")}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  <button className="primary" onClick={() => openQuick()}>
                    <Plus size={16} /> Add task
                  </button>
                </div>
              </div>
              <div className="list-toolbar">
                <span>
                  <Layers size={15} />
                  {view === "completed"
                    ? `${shown.length} completed`
                    : (() => {
                        const n = shown.filter((t) => !t.completed).length;
                        return `${n} ${n === 1 ? "task" : "tasks"}`;
                      })()}
                </span>
                <div>
                  <button
                    className={priorityFilter ? "filter-on" : ""}
                    onClick={() => setPriorityFilter(!priorityFilter)}
                  >
                    <ListFilter size={15} />
                    {priorityFilter ? "High priority" : "Filter"}
                  </button>
                  <label>
                    <ArrowDownWideNarrow size={14} />
                    <select
                      aria-label="Sort tasks"
                      value={sort}
                      onChange={(e) => {
                        setSort(e.target.value);
                        store("tasks.sort", e.target.value);
                      }}
                    >
                      <option value="smart">Due date</option>
                      <option value="priority">Priority</option>
                      <option value="name">Name</option>
                    </select>
                  </label>
                </div>
              </div>
              {view === "upcoming" && !search && (
                <WeekStrip
                  tasks={active}
                  jump={(d) =>
                    listRef.current
                      ?.querySelector(`[data-group="${d}"]`)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                />
              )}
              {sections}
            </main>
            {detail}
          </div>
        </div>
      </React.Fragment>
      {overlays}
    </div>
  );
}

function ToastView({
  toast,
  close,
  compact,
  top,
}: {
  toast: Toast;
  close: () => void;
  compact?: boolean;
  /** At the top of the screen, clear of a sheet on the keyboard. */
  top?: boolean;
}) {
  return (
    <div
      className={`toast ${toast.error ? "is-error" : ""} ${compact ? "is-compact" : ""} ${top ? "is-top" : ""}`}
      role="status"
      key={toast.id}
    >
      {toast.error ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
      <span>{toast.text}</span>
      {toast.undo && (
        <button
          className="toast-undo"
          onClick={() => {
            toast.undo!();
            close();
          }}
        >
          <Undo2 size={14} /> Undo
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={close}>
        <X size={13} />
      </button>
    </div>
  );
}

function WeekStrip({
  tasks,
  jump,
}: {
  tasks: Task[];
  jump: (date: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => daysFromNow(i));
  return (
    <div className="week-strip" role="navigation" aria-label="This week">
      {days.map((d, i) => {
        const n = tasks.filter((t) => t.due_date === d).length;
        return (
          <button
            key={d}
            className={i === 0 ? "is-today" : ""}
            onClick={() => jump(d)}
          >
            <small>{weekday(d)}</small>
            <strong>{Number(d.slice(8))}</strong>
            <span className="week-dots" aria-label={`${n} tasks`}>
              {Array.from({ length: Math.min(n, 3) }, (_, k) => (
                <i key={k} />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function BellPanel({
  anchor,
  close,
  tasks,
  hosted,
}: {
  anchor: DOMRect;
  close: () => void;
  tasks: Task[];
  hosted: boolean;
}) {
  const permission = usePermission();
  const [auto, setAuto] = useState(autoReminder());
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState<boolean | null>(null);
  useEffect(() => {
    api<{ web_enabled: boolean }>("/push/config")
      .then((c) => setPush(c.web_enabled))
      .catch(() => setPush(false));
  }, []);
  const upcoming = tasks
    .map((t) => ({ t, at: reminderAt(t) }))
    .filter(
      (r): r is { t: Task; at: number } => r.at !== null && r.at > Date.now(),
    )
    .sort((a, b) => a.at - b.at)
    .slice(0, 4);
  return (
    <Popover anchor={anchor} close={close} label="Reminders" width={320}>
      <div className="bell-panel">
        <div className="bell-head">
          {permission === "granted" ? (
            <BellRing size={18} className="tone-green" />
          ) : (
            <BellOff size={18} />
          )}
          <div>
            <strong>Reminders</strong>
            <p>
              {permission === "granted"
                ? "On for this browser."
                : permission === "denied"
                  ? "Blocked. Allow notifications for this site in your browser settings."
                  : permission === "unsupported"
                    ? "This browser can't show notifications."
                    : "Get a notification when a task is due."}
            </p>
          </div>
        </div>
        {permission === "default" && (
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await enableNotifications().catch(() => "default");
              setBusy(false);
            }}
          >
            <Bell size={15} /> Turn on notifications
          </button>
        )}
        <label className="bell-field">
          <span>When a task has a time, remind me</span>
          <select
            aria-label="Automatic reminder"
            value={auto ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? null : Number(e.target.value);
              setAuto(v);
              setAutoReminder(v);
            }}
          >
            <option value="">Never</option>
            {reminderChoices.map(([m, label]) => (
              <option key={m} value={m}>
                {label.replace("At due time", "At the time")}
              </option>
            ))}
          </select>
        </label>
        {upcoming.length > 0 && (
          <div className="bell-upcoming">
            <small>Coming up</small>
            {upcoming.map(({ t, at }) => (
              <div key={t.id}>
                <span>{t.title}</span>
                <time>
                  {new Date(at).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </div>
            ))}
          </div>
        )}
        <p className="bell-note">
          {push
            ? "Push is set up, so reminders also arrive when Tasks is closed."
            : hosted
              ? "Reminders fire while Personal Command is open (the companion counts). Set up push in Tasks settings to get them when it's closed."
              : "Reminders fire while Tasks is open. Set up push in Settings to get them when it's closed."}
        </p>
        {permission === "granted" && (
          <button
            className="secondary"
            onClick={() =>
              showReminder(
                {
                  ...(upcoming[0]?.t ||
                    ({ id: "test", title: "Test reminder" } as Task)),
                  title: upcoming[0]?.t.title || "Test reminder",
                },
                "test-" + Date.now(),
                "This is how reminders look.",
              )
            }
          >
            Send a test notification
          </button>
        )}
      </div>
    </Popover>
  );
}

// Notes, tasks and projects a description links to ([[note:id]]) or embeds (![[note:id]]).
function Linked({ text }: { text: string }) {
  const pc = usePc();
  const refs = findShortRefs(text, TYPE_OWNERS);
  if (!refs.length) return null;
  return (
    <section className="linked-items" aria-label="Linked items">
      <h3>Linked</h3>
      {refs.map((r, i) =>
        r.embed ? (
          <PcEmbed key={i} target={r.ref} size="card">
            {r.label || r.ref}
          </PcEmbed>
        ) : (
          <button
            key={i}
            className="linked-link"
            onClick={() => pc.open(r.ref, { placement: "new-column" })}
          >
            {r.label || r.ref.replace(/^pc:\/\/[^/]+\//, "")}
          </button>
        ),
      )}
    </section>
  );
}

export { Copy };
