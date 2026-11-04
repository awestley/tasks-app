import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownWideNarrow,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Flag,
  Inbox,
  Layers,
  ListFilter,
  ListChecks,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sun,
  Tag,
  Trash2,
  X,
  Repeat2,
  LogOut,
  Copy,
  Pencil,
  KeyRound,
  Apple,
  CheckCircle2,
} from "lucide-react";
import {
  api,
  allTasks,
  APIError,
  localDate,
  dateLabel,
  type Task,
  type Project,
  type Profile,
  type Token,
  type ParsedTask,
} from "./api";
import "./style.css";
import { PushSettings, disableBrowserPush } from "./PushSettings";
import { ChecklistEditor } from "./ChecklistEditor";

type View =
  | "today"
  | "inbox"
  | "upcoming"
  | "all"
  | "completed"
  | `project:${string}`
  | `label:${string}`;
type Draft = Pick<
  Task,
  | "title"
  | "description"
  | "project_id"
  | "due_date"
  | "due_time"
  | "time_zone"
  | "reminder_minutes"
  | "priority"
  | "labels"
  | "recurrence"
  | "checklist"
>;
const emptyDraft = (): Draft => ({
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
const icons = {
  today: Sun,
  inbox: Inbox,
  upcoming: CalendarDays,
  all: Layers,
  completed: CheckCheck,
};
function Logo() {
  return (
    <div className="brand" aria-hidden="true">
      <span className="brand-mark">
        <Check size={21} strokeWidth={3} />
      </span>
    </div>
  );
}
function App() {
  const [user, setUser] = useState<Profile | null>(null),
    [loading, setLoading] = useState(true),
    [tasks, setTasks] = useState<Task[]>([]),
    [projects, setProjects] = useState<Project[]>([]);
  const [config, setConfig] = useState({
      apple_enabled: false,
      dev_login: false,
    }),
    [view, setView] = useState<View>("today"),
    [search, setSearch] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [editor, setEditor] = useState<Task | "new" | null>(null),
    [settings, setSettings] = useState(false),
    [projectEditor, setProjectEditor] = useState<Project | "new" | null>(null);
  const [mobile, setMobile] = useState(false),
    [sort, setSort] = useState("smart"),
    [priorityFilter, setPriorityFilter] = useState(false),
    [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const [nextTasks, nextProjects] = await Promise.all([
      allTasks(),
      api<Project[]>("/projects"),
    ]);
    setTasks(nextTasks);
    const taskId = new URLSearchParams(location.search).get("task");
    if (taskId) {
      const target = nextTasks.find((t) => t.id === taskId);
      if (target) setEditor(target);
      history.replaceState(null, "", location.pathname);
    }
    setProjects(nextProjects);
  }, []);
  useEffect(() => {
    Promise.all([api<Profile>("/me"), api<typeof config>("/auth/config")])
      .then(async ([profile, cfg]) => {
        setConfig(cfg);
        setUser(profile);
        await refresh();
      })
      .catch(async (e) => {
        if (e.status !== 401) setError(e.message);
        setConfig(await api("/auth/config"));
      })
      .finally(() => setLoading(false));
    if (new URLSearchParams(location.search).has("auth_error"))
      setError("Apple sign-in was interrupted or expired. Please try again.");
  }, [refresh]);
  useEffect(() => {
    if (!user) return;
    const load = () =>
      refresh().catch((e) => {
        if (e.status === 401) setUser(null);
        else setError(e.message);
      });
    const timer = setInterval(load, 30000);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [user, refresh]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const input = (e.target as HTMLElement).matches("input,textarea,select");
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (!input && e.key === "q" && user) setEditor("new");
      if (e.key === "Escape") {
        setEditor(null);
        setSettings(false);
        setProjectEditor(null);
        setMobile(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [user]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 4000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      if ((e as APIError).status === 409) await refresh();
    } finally {
      setBusy(false);
    }
  };
  const today = localDate(),
    active = tasks.filter((t) => !t.completed),
    todayTasks = active.filter((t) => t.due_date && t.due_date <= today);
  const labels = Array.from(new Set(tasks.flatMap((t) => t.labels))).sort();
  const selectedProject = view.startsWith("project:")
    ? projects.find((p) => p.id === view.slice(8))
    : null;
  const title = search
    ? "Search results"
    : selectedProject?.name ||
      (
        {
          today: "Today",
          inbox: "Inbox",
          upcoming: "Upcoming",
          all: "All tasks",
          completed: "Completed",
        } as Record<string, string>
      )[view] ||
      view.slice(6);
  const shown = useMemo(
    () =>
      tasks
        .filter((t) => {
          if (search)
            return (t.title + " " + t.description + " " + t.labels.join(" "))
              .toLowerCase()
              .includes(search.toLowerCase());
          if (view === "completed") return t.completed;
          if (t.completed) return false;
          if (view === "today") return !!t.due_date && t.due_date <= today;
          if (view === "inbox") return !t.project_id;
          if (view === "upcoming") return !!t.due_date && t.due_date > today;
          if (view.startsWith("project:"))
            return t.project_id === view.slice(8);
          if (view.startsWith("label:"))
            return t.labels.includes(view.slice(6));
          return true;
        })
        .filter((t) => !priorityFilter || t.priority <= 2)
        .sort((a, b) =>
          sort === "name"
            ? a.title.localeCompare(b.title)
            : sort === "priority"
              ? a.priority - b.priority
              : (a.due_date || "9999").localeCompare(b.due_date || "9999") ||
                a.priority - b.priority,
        ),
    [tasks, view, search, sort, priorityFilter, today],
  );
  const overdue = shown.filter(
      (t) => !t.completed && t.due_date && t.due_date < today,
    ),
    rest = shown.filter((t) => !overdue.includes(t));
  function navigate(next: View) {
    setView(next);
    setSearch("");
    setMobile(false);
  }
  async function toggle(task: Task) {
    await run(async () => {
      await api(`/tasks/${task.id}`, "PATCH", {
        version: task.version,
        completed: !task.completed,
      });
      await refresh();
      setNotice(task.completed ? "Task restored" : "Task completed");
    });
  }
  if (loading)
    return (
      <div className="loading">
        <Logo />
        <LoaderCircle className="spin" />
        <p>Loading tasks...</p>
      </div>
    );
  if (!user)
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-label="Sign in">
          <Logo />
          <h1>Sign in</h1>
          <div className="auth-actions">
            {config.apple_enabled && (
              <a className="apple-button" href="/auth/apple/start">
                <Apple size={20} /> Sign in with Apple
              </a>
            )}
            {config.dev_login && (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api("/auth/dev", "POST");
                    setUser(await api("/me"));
                    await refresh();
                  })
                }
              >
                {busy ? "Opening..." : "Open local workspace"}
              </button>
            )}
            {!config.apple_enabled && (
              <p className="auth-note">Apple sign-in is not configured.</p>
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
          </div>
        </section>
      </main>
    );
  const TaskRow = ({ task }: { task: Task }) => (
    <div className={`task-row ${task.completed ? "is-complete" : ""}`}>
      <button
        className={`check-task priority-${task.priority}`}
        aria-label={`${task.completed ? "Restore" : "Complete"} ${task.title}`}
        disabled={busy}
        onClick={() => toggle(task)}
      >
        {task.completed && <Check size={13} />}
      </button>
      <button className="task-body" onClick={() => setEditor(task)}>
        <span className="task-title">{task.title}</span>
        {task.description && (
          <span className="task-description">{task.description}</span>
        )}
        <span className="task-meta">
          {task.due_date && (
            <span
              className={
                task.due_date < today && !task.completed
                  ? "overdue"
                  : task.due_date === today
                    ? "due-today"
                    : ""
              }
            >
              <CalendarDays size={12} />
              {dateLabel(task.due_date)}
              {task.due_time ? ` · ${task.due_time} (${task.time_zone})` : ""}
              {task.reminder_minutes !== null ? " · Reminder" : ""}
              {task.recurrence && <Repeat2 size={12} />}
            </span>
          )}
          {task.checklist.length > 0 && (
            <span
              className="checklist-progress"
              aria-label={`${task.checklist.filter((item) => item.completed).length} of ${task.checklist.length} checklist items completed`}
            >
              <ListChecks size={13} />
              {task.checklist.filter((item) => item.completed).length}/
              {task.checklist.length}
            </span>
          )}
          {task.labels.map((l) => (
            <span key={l} className="label">
              <Tag size={11} />
              {l}
            </span>
          ))}
        </span>
      </button>
      <button
        className="task-project"
        onClick={() =>
          navigate(task.project_id ? `project:${task.project_id}` : "inbox")
        }
      >
        {projects.find((p) => p.id === task.project_id)?.name || "Inbox"}
        <span
          style={{
            color:
              projects.find((p) => p.id === task.project_id)?.color ||
              "#9b99a5",
          }}
        >
          #
        </span>
      </button>
      <button
        className="icon-button row-menu"
        aria-label={`Edit ${task.title}`}
        onClick={() => setEditor(task)}
      >
        <MoreHorizontal size={18} />
      </button>
    </div>
  );
  const group = (name: string, items: Task[], isOverdue = false) => (
    <section className="task-section" key={name}>
      <h3 className={isOverdue ? "overdue" : ""}>
        {name}
        <span>{items.length}</span>
        {isOverdue && (
          <button
            onClick={() =>
              run(async () => {
                for (const task of items)
                  await api(`/tasks/${task.id}`, "PATCH", {
                    version: task.version,
                    due_date: today,
                  });
                await refresh();
                setNotice("Overdue tasks moved to today");
              })
            }
            disabled={busy}
          >
            Reschedule
          </button>
        )}
      </h3>
      {items.map((task) => (
        <TaskRow task={task} key={task.id} />
      ))}
    </section>
  );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <Logo />
        <button className="workspace-switch" onClick={() => setSettings(true)}>
          <span className="avatar">{user.name.slice(0, 1)}</span>
          <span>
            {user.name}
            <small>Personal workspace</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <button className="quick-add" onClick={() => setEditor("new")}>
          <Plus size={18} /> Add task <kbd>Q</kbd>
        </button>
        <nav>
          {(["inbox", "today", "upcoming", "all", "completed"] as const).map(
            (item) => {
              const Icon = icons[item];
              const count =
                item === "today"
                  ? todayTasks.length
                  : item === "inbox"
                    ? active.filter((t) => !t.project_id).length
                    : item === "upcoming"
                      ? active.filter((t) => t.due_date && t.due_date > today)
                          .length
                      : item === "completed"
                        ? tasks.length - active.length
                        : active.length;
              return (
                <button
                  className={view === item && !search ? "active" : ""}
                  onClick={() => navigate(item)}
                  key={item}
                >
                  <Icon size={18} />
                  <span>
                    {
                      {
                        inbox: "Inbox",
                        today: "Today",
                        upcoming: "Upcoming",
                        all: "All tasks",
                        completed: "Completed",
                      }[item]
                    }
                  </span>
                  <small>{count || ""}</small>
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
            </button>
          ))}
          {!labels.length && <p className="sidebar-hint">No labels</p>}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setSettings(true)}>
            <Settings size={17} /> Settings & integrations
          </button>
        </div>
      </aside>
      {mobile && (
        <button
          className="mobile-shade"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobile(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            My workspace <ChevronRight size={13} /> <span>{title}</span>
          </div>
          <div className="search-box">
            <Search size={16} />
            <input
              ref={searchRef}
              placeholder="Search tasks"
              aria-label="Search tasks"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <button aria-label="Clear search" onClick={() => setSearch("")}>
                <X size={14} />
              </button>
            ) : (
              <kbd>⌘ K</kbd>
            )}
          </div>
          <button
            className="top-avatar"
            aria-label="Open settings"
            onClick={() => setSettings(true)}
          >
            {user.name.slice(0, 1)}
          </button>
        </header>
        <div className="content-layout">
          <main className="task-main">
            <div className="page-title">
              <h1>{title}</h1>
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
                <button className="primary" onClick={() => setEditor("new")}>
                  <Plus size={16} /> Add task
                </button>
              </div>
            </div>
            <p className="page-subtitle">
              {view === "today" && !search ? (
                <>
                  <strong>
                    {new Date().toLocaleDateString(undefined, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })}
                  </strong>
                </>
              ) : search ? (
                `${shown.length} tasks matching “${search}”`
              ) : view === "completed" ? (
                `${shown.length} completed tasks`
              ) : (
                `${shown.length} tasks`
              )}
            </p>
            <div className="list-toolbar">
              <span>
                <Layers size={15} />
                {shown.length} tasks
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
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="smart">Due date</option>
                    <option value="priority">Priority</option>
                    <option value="name">Name</option>
                  </select>
                </label>
              </div>
            </div>
            {error && (
              <div className="error" role="alert">
                {error}
                <button
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setError("")}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {overdue.length > 0 && group("Overdue", overdue, true)}
            {rest.length > 0 &&
              (view === "upcoming" && !search
                ? Array.from(new Set(rest.map((t) => t.due_date))).map((d) =>
                    group(
                      dateLabel(d),
                      rest.filter((t) => t.due_date === d),
                    ),
                  )
                : group(
                    view === "today" && !search
                      ? "Today"
                      : view === "completed"
                        ? "Completed"
                        : "Tasks",
                    rest,
                  ))}
            {!shown.length && (
              <div className="empty-state">
                <div>
                  <CheckCheck size={32} />
                </div>
                <h2>
                  {search
                    ? "Nothing found"
                    : view === "completed"
                      ? "No completed tasks"
                      : "No tasks"}
                </h2>
                <p>
                  {search
                    ? "Try a different search."
                    : view === "completed"
                      ? "Your completed tasks will appear here."
                      : "Add a task with the button above or press Q."}
                </p>
                {!search && view !== "completed" && (
                  <button
                    className="subtle-button"
                    onClick={() => setEditor("new")}
                  >
                    <Plus size={16} /> Create a task
                  </button>
                )}
              </div>
            )}
            {view !== "completed" && (
              <button className="add-task-row" onClick={() => setEditor("new")}>
                <Plus size={18} /> Add a task{" "}
                <span>
                  or press <kbd>Q</kbd>
                </span>
              </button>
            )}
          </main>
        </div>
      </div>
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {notice}
        </div>
      )}
      {error && (editor || projectEditor || settings) && (
        <div className="error floating-error" role="alert">
          {error}
          <button
            aria-label="Dismiss error notification"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {editor && (
        <TaskEditor
          task={editor === "new" ? null : editor}
          projects={projects}
          initialProject={selectedProject?.id || null}
          initialDate={view === "today" ? today : null}
          busy={busy}
          close={() => setEditor(null)}
          save={(draft) =>
            run(async () => {
              if (editor === "new") await api("/tasks", "POST", draft);
              else
                await api(`/tasks/${editor.id}`, "PATCH", {
                  ...draft,
                  version: editor.version,
                });
              await refresh();
              setEditor(null);
              setNotice(editor === "new" ? "Task added" : "Task updated");
            })
          }
          remove={
            editor === "new"
              ? undefined
              : () =>
                  run(async () => {
                    await api(
                      `/tasks/${editor.id}?version=${editor.version}`,
                      "DELETE",
                    );
                    await refresh();
                    setEditor(null);
                    setNotice("Task deleted");
                  })
          }
        />
      )}
      {projectEditor && (
        <ProjectEditor
          project={projectEditor === "new" ? null : projectEditor}
          busy={busy}
          close={() => setProjectEditor(null)}
          save={(name, color) =>
            run(async () => {
              if (projectEditor === "new")
                await api("/projects", "POST", { name, color });
              else
                await api(`/projects/${projectEditor.id}`, "PATCH", {
                  name,
                  color,
                });
              await refresh();
              setProjectEditor(null);
            })
          }
          remove={
            projectEditor === "new"
              ? undefined
              : () =>
                  run(async () => {
                    await api(`/projects/${projectEditor.id}`, "DELETE");
                    await refresh();
                    navigate("inbox");
                    setProjectEditor(null);
                  })
          }
        />
      )}
      {settings && (
        <SettingsPanel
          user={user}
          close={() => setSettings(false)}
          logout={() =>
            run(async () => {
              await disableBrowserPush();
              await api("/auth/logout", "POST");
              setUser(null);
              setSettings(false);
              setTasks([]);
              setProjects([]);
            })
          }
          deleteAccount={() =>
            run(async () => {
              await api("/me", "DELETE");
              setUser(null);
              setSettings(false);
              setTasks([]);
              setProjects([]);
            })
          }
        />
      )}
    </div>
  );
}
function Modal({
  children,
  close,
  label,
}: {
  children: React.ReactNode;
  close: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.querySelector<HTMLElement>("input,button,textarea")?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const controls = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input,textarea,select,a[href]",
          ) || [],
        );
        if (e.shiftKey && document.activeElement === controls[0]) {
          e.preventDefault();
          controls.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === controls.at(-1)) {
          e.preventDefault();
          controls[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={ref}
      >
        {children}
      </div>
    </div>
  );
}
function TaskEditor({
  task,
  projects,
  initialProject,
  initialDate,
  busy,
  close,
  save,
  remove,
}: {
  task: Task | null;
  projects: Project[];
  initialProject: string | null;
  initialDate: string | null;
  busy: boolean;
  close: () => void;
  save: (draft: Draft) => void;
  remove?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(
    task
      ? {
          title: task.title,
          description: task.description,
          project_id: task.project_id,
          due_date: task.due_date,
          due_time: task.due_time,
          time_zone: task.time_zone,
          reminder_minutes: task.reminder_minutes,
          priority: task.priority,
          labels: task.labels,
          checklist: task.checklist,
          recurrence: task.recurrence,
        }
      : { ...emptyDraft(), project_id: initialProject, due_date: initialDate },
  );
  const [labelText, setLabelText] = useState(draft.labels.join(", "));
  const [confirm, setConfirm] = useState(false);
  const [smart, setSmart] = useState(!task);
  const [parsed, setParsed] = useState<{
    input: string;
    value: ParsedTask;
  } | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setParsed(null);
    setParseError("");
    if (!smart || !draft.title.trim()) {
      setParsing(false);
      return;
    }
    setParsing(true);
    const timer = setTimeout(() => {
      api<ParsedTask>("/tasks/parse", "POST", {
        text: draft.title,
        time_zone: draft.time_zone,
      })
        .then((value) => {
          if (!cancelled) setParsed({ input: draft.title, value });
        })
        .catch((e) => {
          if (!cancelled) setParseError(e.message);
        })
        .finally(() => {
          if (!cancelled) setParsing(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft.title, draft.time_zone, smart]);
  const detected =
    smart && parsed?.input === draft.title && parsed.value.recognized.length
      ? parsed.value
      : null;
  const withDetails = (base: Draft): Draft =>
    detected
      ? {
          ...base,
          title: detected.title,
          due_date: detected.due_date || base.due_date,
          due_time: detected.due_time || base.due_time,
          reminder_minutes: detected.due_time
            ? detected.reminder_minutes
            : base.reminder_minutes,
          recurrence: detected.recurrence || base.recurrence,
          priority: detected.priority || base.priority,
          project_id: detected.project_id || base.project_id,
          labels: [...new Set([...base.labels, ...detected.labels])],
        }
      : base;
  return (
    <Modal close={close} label={task ? "Edit task" : "Add task"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (
            busy ||
            parsing ||
            parseError ||
            (smart && parsed?.input !== draft.title)
          )
            return;
          save(
            withDetails({
              ...draft,
              labels: labelText
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
            }),
          );
        }}
      >
        <div className="modal-heading">
          <span>{task ? "Edit task" : "Add task"}</span>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close editor"
          >
            <X size={19} />
          </button>
        </div>
        <input
          className="task-name-input"
          aria-label="Task title"
          placeholder="e.g. Order pizza Friday afternoon"
          required
          maxLength={500}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
        <label className="parse-controls">
          <input
            type="checkbox"
            checked={smart}
            onChange={(e) => setSmart(e.target.checked)}
          />{" "}
          Detect dates, times and details
        </label>
        {parsing && (
          <p className="muted" role="status">
            Reading details...
          </p>
        )}
        {parseError && (
          <p className="error-text" role="alert">
            {parseError} Turn off detail detection to enter fields manually.
          </p>
        )}
        {detected && (
          <div className="parse-preview" role="status">
            <strong>{detected.title}</strong>
            <span>
              {[
                detected.due_date && dateLabel(detected.due_date),
                detected.due_time,
                detected.due_time && draft.time_zone,
                detected.recurrence,
                detected.priority && `Priority ${detected.priority}`,
                ...detected.labels.map((l) => "@" + l),
                projects.find((p) => p.id === detected.project_id)?.name,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {detected.due_time && (
              <span>
                Reminder:{" "}
                {detected.reminder_minutes
                  ? `${detected.reminder_minutes} minutes before`
                  : "at due time"}
              </span>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const next = withDetails({
                  ...draft,
                  labels: labelText
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                });
                setDraft(next);
                setLabelText(next.labels.join(", "));
                setSmart(false);
              }}
            >
              Use details and edit
            </button>
          </div>
        )}
        <textarea
          aria-label="Description"
          placeholder="Description"
          maxLength={10000}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <ChecklistEditor
          items={draft.checklist}
          locked={task?.completed}
          onChange={(checklist) => setDraft({ ...draft, checklist })}
        />
        <div
          className="form-grid"
          onFocus={() => {
            if (detected) {
              const next = withDetails({
                ...draft,
                labels: labelText
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              });
              setDraft(next);
              setLabelText(next.labels.join(", "));
              setSmart(false);
            }
          }}
        >
          <label>
            <Inbox size={14} /> Project
            <select
              value={draft.project_id || ""}
              onChange={(e) =>
                setDraft({ ...draft, project_id: e.target.value || null })
              }
            >
              <option value="">Inbox</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <CalendarDays size={14} /> Due date
            <input
              type="date"
              value={draft.due_date || ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  due_date: e.target.value || null,
                  due_time: e.target.value ? draft.due_time : null,
                  reminder_minutes: e.target.value
                    ? draft.reminder_minutes
                    : null,
                  recurrence: e.target.value ? draft.recurrence : null,
                })
              }
            />
          </label>
          <label>
            Due time
            <input
              type="time"
              disabled={!draft.due_date}
              value={draft.due_time || ""}
              onChange={(e) => {
                setSmart(false);
                setDraft({
                  ...draft,
                  due_time: e.target.value || null,
                  reminder_minutes: e.target.value
                    ? draft.reminder_minutes
                    : null,
                });
              }}
            />
          </label>
          <label>
            Time zone
            <input
              aria-label="Time zone"
              value={draft.time_zone}
              onChange={(e) =>
                setDraft({ ...draft, time_zone: e.target.value })
              }
              required
            />
          </label>
          <label>
            Reminder
            <select
              aria-label="Reminder"
              disabled={!draft.due_time}
              value={draft.reminder_minutes ?? ""}
              onChange={(e) => {
                setSmart(false);
                setDraft({
                  ...draft,
                  reminder_minutes:
                    e.target.value === "" ? null : Number(e.target.value),
                });
              }}
            >
              <option value="">None</option>
              <option value="0">At due time</option>
              <option value="5">5 minutes before</option>
              <option value="15">15 minutes before</option>
              <option value="30">30 minutes before</option>
              <option value="60">1 hour before</option>
              <option value="1440">1 day before</option>
              {draft.reminder_minutes !== null &&
                ![0, 5, 15, 30, 60, 1440].includes(draft.reminder_minutes) && (
                  <option value={draft.reminder_minutes}>
                    {draft.reminder_minutes} minutes before
                  </option>
                )}
            </select>
          </label>
          <label>
            <Flag size={14} /> Priority
            <select
              value={draft.priority}
              onChange={(e) =>
                setDraft({ ...draft, priority: Number(e.target.value) })
              }
            >
              <option value="4">Normal</option>
              <option value="3">Medium</option>
              <option value="2">High</option>
              <option value="1">Urgent</option>
            </select>
          </label>
          <label>
            <Repeat2 size={14} /> Repeat
            <select
              value={draft.recurrence || ""}
              disabled={!draft.due_date}
              onChange={(e) =>
                setDraft({ ...draft, recurrence: e.target.value || null })
              }
            >
              <option value="">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
          </label>
        </div>
        <label className="field-label">
          Labels
          <input
            aria-label="Labels"
            placeholder="work, personal, someday"
            value={labelText}
            onChange={(e) => setLabelText(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          {remove && (
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => (confirm ? remove() : setConfirm(true))}
            >
              <Trash2 size={15} />
              {confirm ? "Confirm delete" : "Delete"}
            </button>
          )}
          <span />
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              parsing ||
              Boolean(parseError) ||
              (smart && parsed?.input !== draft.title) ||
              !draft.title.trim() ||
              draft.checklist.some((item) => !item.title.trim())
            }
          >
            {busy ? "Saving..." : task ? "Save changes" : "Add task"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ProjectEditor({
  project,
  busy,
  close,
  save,
  remove,
}: {
  project: Project | null;
  busy: boolean;
  close: () => void;
  save: (name: string, color: string) => void;
  remove?: () => void;
}) {
  const [name, setName] = useState(project?.name || ""),
    [color, setColor] = useState(project?.color || "#2563eb"),
    [confirm, setConfirm] = useState(false);
  return (
    <Modal close={close} label="Project editor">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(name, color);
        }}
      >
        <div className="modal-heading">
          <h2>{project ? "Edit project" : "New project"}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close project editor"
          >
            <X />
          </button>
        </div>
        <label className="field-label">
          Project name
          <input
            required
            maxLength={100}
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field-label">
          Project color
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        {confirm && (
          <p className="muted">Tasks in this project will move to Inbox.</p>
        )}
        <div className="modal-actions">
          {remove && (
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => (confirm ? remove() : setConfirm(true))}
            >
              {confirm ? "Confirm delete" : "Delete project"}
            </button>
          )}
          <span />
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            Save project
          </button>
        </div>
      </form>
    </Modal>
  );
}
function SettingsPanel({
  user,
  close,
  logout,
  deleteAccount,
}: {
  user: Profile;
  close: () => void;
  logout: () => void;
  deleteAccount: () => void;
}) {
  const [tokens, setTokens] = useState<Token[]>([]),
    [name, setName] = useState(""),
    [created, setCreated] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState("");
  const load = () => api<Token[]>("/tokens").then(setTokens);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal close={close} label="Settings and integrations">
      <div className="modal-heading">
        <h2>Your workspace</h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close settings"
        >
          <X />
        </button>
      </div>
      <div className="profile-card">
        <span className="avatar">{user.name.slice(0, 1)}</span>
        <div>
          <strong>{user.name}</strong>
          <p>{user.email}</p>
        </div>
        <button className="secondary" onClick={logout}>
          <LogOut size={14} /> Sign out
        </button>
      </div>
      <PushSettings />
      <div className="settings-title">
        <KeyRound size={19} />
        <div>
          <h3>API & MCP access</h3>
          <p>Connect your tools with a personal access token.</p>
        </div>
      </div>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          perform(async () => {
            const result = await api<{ token: string }>("/tokens", "POST", {
              name,
            });
            setCreated(result.token);
            setName("");
            await load();
          });
        }}
      >
        <input
          aria-label="Token name"
          placeholder="Token name, e.g. Desktop AI"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="primary" disabled={busy}>
          Create token
        </button>
      </form>
      {created && (
        <div className="token-created">
          <strong>Copy this token now. It is shown only once.</strong>
          <code>{created}</code>
          <button
            className="secondary"
            onClick={() =>
              navigator.clipboard
                .writeText(created)
                .catch(() => setError("Select and copy the token above."))
            }
          >
            <Copy size={13} /> Copy token
          </button>
        </div>
      )}
      {tokens.map((t) => (
        <div className="token-row" key={t.id}>
          <div>
            <strong>{t.name}</strong>
            <small>Expires {new Date(t.expires_at).toLocaleDateString()}</small>
          </div>
          <button
            className="danger-button"
            disabled={busy}
            onClick={() =>
              perform(async () => {
                await api(`/tokens/${t.id}`, "DELETE");
                await load();
              })
            }
          >
            Revoke
          </button>
        </div>
      ))}
      <div className="integration-note">
        <strong>Connection details</strong>
        <p>
          REST API: <code>{location.origin}/api/v1</code>
          <br />
          Use the included MCP adapter with your server URL and a
          token. Tokens expire after 90 days and can be revoked here.
        </p>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <details className="account-delete">
        <summary>Delete account</summary>
        <p>
          Permanently remove your tasks, projects, tokens, and Apple
          authorization. Type DELETE to confirm.
        </p>
        <input
          aria-label="Confirm account deletion"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button
          className="danger-button"
          disabled={confirm !== "DELETE"}
          onClick={deleteAccount}
        >
          Permanently delete my account
        </button>
      </details>
    </Modal>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
