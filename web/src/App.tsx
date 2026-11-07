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
  CalendarDays,
  CheckCheck,
  CircleAlert,
  CloudOff,
  ExternalLink,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import {
  useCommands,
  useHosted,
  usePaneTitle,
  usePc,
  useSurface,
} from "@awestley/pc-runtime/react";
import { api, localDate, type Project, type Task } from "./api";
import { ContextMenu, type MenuEntry, type MenuRequest } from "./ContextMenu";
import { disableBrowserPush } from "./PushSettings";
import { MainColumn, PhonePage } from "./layouts";
import { BellPanel, Linked, ToastView, type Toast } from "./pieces";
import { QuickAdd, type NewTask, type QuickDefaults } from "./QuickAdd";
import {
  hashFor,
  read,
  readRoute,
  store,
  viewNames,
  type View,
} from "./routes";
import { handleShortcut } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import { SignIn } from "./SignIn";
import { dateOptions, moveMenu, priorityMenu, taskMenu } from "./taskMenus";
import { TaskRow } from "./TaskRow";
import { usePressMenu } from "./usePressMenu";
import { useTaskGroups } from "./useTaskGroups";
import type { W } from "./workspaceContext";
import { TaskDetail } from "./TaskDetail";
import {
  Modal,
  ProjectEditor,
  SettingsPanel,
  ShortcutsDialog,
} from "./dialogs";
import { autoReminder, scheduleReminders, usePermission } from "./reminders";
import * as S from "./store";
import {
  holdKeyboard,
  swipeRow,
  TabBar,
  useKeyboardInset,
  useMedia,
  type PhoneTab,
} from "./phone";
import {
  DatePicker,
  dueLabel,
  formatTime,
  priorityNames,
  recurrenceLabel,
} from "./ui";

const COMPACT_BELOW = 480;

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
  const { press, pointerType, menuFor } = usePressMenu(setMenu);
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

  const { shown, overdue, groups, flat } = useTaskGroups({
    tasks,
    view,
    search,
    sort,
    priorityFilter,
    today,
    finishing,
    selectedProject,
  });

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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /* ---------- pieces ---------- */

  // On a phone a row also swipes: right completes, left schedules.
  const rowHandlers = (task: Task) => {
    const menuProps = menuFor(() => taskMenu(task, w), task.title, task.id);
    if (!phone) return menuProps;
    const swipe = swipeRow({
      right: () => toggle(task),
      left: () =>
        setMenu({
          x: innerWidth / 2,
          y: innerHeight / 2,
          entries: dateOptions(task, w),
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

  const counts = {
    today: active.filter((t) => t.due_date && t.due_date <= today).length,
    inbox: active.filter((t) => !t.project_id).length,
    upcoming: active.filter((t) => t.due_date && t.due_date > today).length,
    all: active.length,
    completed: tasks.length - active.length,
  };

  const w: W = {
    companion,
    hosted,
    phone,
    wide,
    narrow,
    detailBeside,
    sidebarDocked,
    coarse,
    pc,
    user,
    projects,
    active,
    labels,
    counts,
    permission,
    view,
    search,
    setSearch,
    today,
    title,
    selectedProject,
    sort,
    setSort,
    priorityFilter,
    setPriorityFilter,
    shown,
    flat,
    groups,
    openId,
    setOpenId,
    selected,
    setSelected,
    inlineAdd,
    setInlineAdd,
    drawer,
    setDrawer,
    sidebarPref,
    setSidebarPref,
    phoneScreen,
    setPhoneScreen,
    menu,
    setMenu,
    setPicker,
    finishing,
    hovered,
    searchRef,
    listRef,
    lastEscape,
    gPending,
    toast,
    setToast,
    modalOpen,
    target,
    navigate,
    openQuick,
    openDetail,
    openInColumn,
    toggle,
    schedule,
    setPriority,
    patch,
    duplicate,
    copy,
    removeTask,
    goToProject,
    menuFor,
    openMenuAt,
    rowHandlers,
    addTaskIn,
    projectMenu,
    listMenu,
    setProjectEditor,
    setSettings,
    setShortcuts,
    setBell,
    setFocusKey,
  };
  keyRef.current = (e: KeyboardEvent) => handleShortcut(e, w);

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
            {g.tasks.map((t) => (
              <TaskRow key={t.id} task={t} inGroup={g.key} w={w} />
            ))}
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

  const sidebar = !companion && <Sidebar w={w} status={status} />;

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
          entries || taskMenu(openTask, w),
          title || openTask.title,
          openTask.id,
        )
      }
      projectMenu={() => moveMenu(openTask, w)}
      priorityMenu={() => priorityMenu(openTask, w)}
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

  const parts = { sections, status, bellButton, expiredBanner, detail };

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
    // Same root and the overlays in the same place as the full layout, so a rotation or a
    // resize between the two keeps an open sheet and what was typed in it.
    return (
      <div
        className={`app-shell is-phone${hosted ? " hosted" : ""}${scrolled ? " is-scrolled" : ""}${toast && !quick ? " has-toast" : ""}${openTask ? " has-detail" : ""}`}
      >
        <React.Fragment key="phone">
          <PhonePage
            w={w}
            parts={parts}
            tab={tab}
            subtitle={subtitle}
            viewButton={viewButton}
          />
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
        <MainColumn w={w} parts={parts} />
      </React.Fragment>
      {overlays}
    </div>
  );
}
