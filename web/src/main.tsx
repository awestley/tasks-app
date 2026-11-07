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
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Layers,
  ListFilter,
  LoaderCircle,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { ContextMenu, type MenuEntry, type MenuRequest } from "./ContextMenu";
import {
  api,
  allTasks,
  APIError,
  localDate,
  dateLabel,
  type Task,
  type Project,
  type Profile,
} from "./api";
import "./glassive.css";
import "./style.css";
import { disableBrowserPush } from "./PushSettings";
import { Logo } from "./Logo";
import { ProjectEditor } from "./ProjectEditor";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";
import { SignIn } from "./SignIn";
import { TaskEditor } from "./TaskEditor";
import { TaskRow } from "./TaskRow";
import { taskMenu } from "./taskMenu";
import { priorityNames, type View } from "./tasks";

const editable = "input,textarea,select,a[href],code,[contenteditable]";
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
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Long-press state for touch. Clicks right after a long press are swallowed.
  const press = useRef({ timer: 0, x: 0, y: 0, active: false, until: 0 });
  const pointerType = useRef("mouse");
  const claimed = useRef<Event | null>(null);
  const hovered = useRef<string | null>(null);
  const rowKeys = useRef<(key: string) => boolean>(() => false);
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
    return nextTasks;
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
    const authError = new URLSearchParams(location.search).get("auth_error");
    if (authError) history.replaceState(null, "", location.pathname);
    if (authError)
      setError(
        authError === "denied"
          ? "This Apple account is not allowed on this server."
          : "Apple sign-in was interrupted or expired. Please try again.",
      );
  }, [refresh]);
  // Projects are small and always fetched. Tasks are downloaded only when their revision has changed.
  const lastRevision = useRef("");
  const poll = useCallback(async () => {
    const [{ revision }, nextProjects] = await Promise.all([
      api<{ revision: string }>("/tasks/revision"),
      api<Project[]>("/projects"),
    ]);
    setProjects(nextProjects);
    if (revision !== lastRevision.current) {
      await refresh();
      // Read before the download, so a change during it only causes one extra download.
      lastRevision.current = revision;
    }
  }, [refresh]);
  useEffect(() => {
    if (!user) return;
    const load = () =>
      poll().catch((e) => {
        if (e.status === 401) setUser(null);
        else setError(e.message);
      });
    const timer = setInterval(load, 30000);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [user, poll]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const input = (e.target as HTMLElement).matches("input,textarea,select");
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (
        !input &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        rowKeys.current(e.key)
      )
        e.preventDefault();
      if (e.key === "Escape") {
        setEditor(null);
        setSettings(false);
        setProjectEditor(null);
        setMobile(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    // The project may have been deleted on another device.
    if (
      view.startsWith("project:") &&
      !projects.some((p) => p.id === view.slice(8))
    )
      setView("inbox");
  }, [view, projects]);
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
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(""), 4000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      if ((e as APIError).status === 401) setUser(null);
      if ((e as APIError).status === 409) await refresh();
    } finally {
      setBusy(false);
    }
  };
  const today = localDate(),
    active = tasks.filter((t) => !t.completed);
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
      (view.startsWith("label:") ? view.slice(6) : "Tasks");
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
  function patch(task: Task, changes: Partial<Task>, message: string) {
    return run(async () => {
      await api(`/tasks/${task.id}`, "PATCH", {
        ...changes,
        version: task.version,
      });
      await refresh();
      setNotice(message);
    });
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
      due ? `Due date set to ${dateLabel(due)}` : "Due date removed",
    );
  const setPriority = (task: Task, priority: number) =>
    patch(
      task,
      { priority },
      `Priority set to ${priorityNames[priority].toLowerCase()}`,
    );
  const duplicate = (task: Task) =>
    run(async () => {
      await api("/tasks", "POST", {
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
          title,
          completed,
        })),
      });
      await refresh();
      setNotice("Task duplicated");
    });
  const removeTask = (task: Task) =>
    run(async () => {
      await api(`/tasks/${task.id}?version=${task.version}`, "DELETE");
      await refresh();
      setNotice("Task deleted");
    });
  const copy = (text: string, message: string) =>
    navigator.clipboard.writeText(text).then(
      () => setNotice(message),
      () => setError("Copying is not available in this browser."),
    );
  const goToProject = (task: Task) =>
    navigate(task.project_id ? `project:${task.project_id}` : "inbox");
  // The editor keeps its draft. Adopting the latest version lets the next attempt succeed on purpose.
  async function editorWrite(
    task: Task,
    write: () => Promise<unknown>,
    retry: string,
  ) {
    try {
      await write();
    } catch (e) {
      if ((e as APIError).status !== 409) throw e;
      const latest = (await refresh()).find((t) => t.id === task.id);
      if (!latest) throw new Error("This task was deleted on another device.");
      setEditor(latest);
      throw new Error(`This task changed on another device. ${retry}`);
    }
  }
  const rescheduleOverdue = () =>
    run(async () => {
      for (const task of overdue)
        await api(`/tasks/${task.id}`, "PATCH", {
          version: task.version,
          due_date: today,
        });
      await refresh();
      setNotice("Overdue tasks moved to today");
    });
  const taskEntries = (task: Task) =>
    taskMenu(task, {
      today,
      projects,
      edit: setEditor,
      goToProject,
      toggle,
      schedule,
      setPriority,
      patch,
      duplicate,
      copy,
      remove: removeTask,
    });
  const addTaskIn = (next: View): MenuEntry[] => [
    {
      label: "Add task",
      icon: <Plus size={16} />,
      action: () => {
        navigate(next);
        setEditor("new");
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
      action: () =>
        run(async () => {
          await api(`/projects/${project.id}`, "DELETE");
          await refresh();
          if (view === `project:${project.id}`) navigate("inbox");
          setNotice("Project deleted. Its tasks moved to Inbox.");
        }),
    },
  ];
  const listMenu = (): MenuEntry[] => [
    {
      label: "Add task",
      icon: <Plus size={16} />,
      shortcut: "Q",
      key: "q",
      action: () => setEditor("new"),
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
        action: () => setSort(value),
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
      action: () => run(refresh),
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
  rowKeys.current = (key) => {
    if (!user || editor || settings || projectEditor || menu) return false;
    if (key === "q") {
      setEditor("new");
      return true;
    }
    const task = shown.find((t) => t.id === hovered.current);
    if (!task) return false;
    if (key === "e") setEditor(task);
    else if (key === "g") goToProject(task);
    else if (key === "c") toggle(task);
    else if (key === "d") duplicate(task);
    else if (["1", "2", "3", "4"].includes(key)) setPriority(task, Number(key));
    else return false;
    return true;
  };
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
      <SignIn
        config={config}
        busy={busy}
        error={error}
        openLocalWorkspace={() =>
          run(async () => {
            await api("/auth/dev", "POST");
            setUser(await api("/me"));
            await refresh();
          })
        }
      />
    );
  const group = (
    name: string,
    items: Task[],
    isOverdue = false,
    key = name,
  ) => (
    <section className="task-section" key={key}>
      <h3 className={isOverdue ? "overdue" : ""}>
        {name}
        <span>{items.length}</span>
        {isOverdue && (
          <button onClick={rescheduleOverdue} disabled={busy}>
            Reschedule
          </button>
        )}
      </h3>
      {items.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          project={projects.find((p) => p.id === task.project_id)}
          today={today}
          busy={busy}
          menuOpen={menu?.target === task.id}
          pressProps={menuFor(() => taskEntries(task), task.title, task.id)}
          setHovered={(id) => (hovered.current = id)}
          toggle={toggle}
          edit={setEditor}
          goToProject={goToProject}
          openMenu={(box) =>
            setMenu({
              x: box.right,
              y: box.bottom + 4,
              entries: taskEntries(task),
              title: task.title,
              target: task.id,
              sheet: false,
            })
          }
        />
      ))}
    </section>
  );
  return (
    <div className="app-shell">
      <Sidebar
        user={user}
        mobile={mobile}
        view={view}
        search={search}
        today={today}
        active={active}
        total={tasks.length}
        projects={projects}
        labels={labels}
        navigate={navigate}
        openSettings={() => setSettings(true)}
        addTask={() => setEditor("new")}
        addProject={() => setProjectEditor("new")}
        taskListPress={(item) => menuFor(() => addTaskIn(item))}
        projectPress={(project) =>
          menuFor(() => projectMenu(project), project.name)
        }
      />
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
          <main className="task-main" {...menuFor(listMenu, title)}>
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
                <CircleAlert className="error-icon" size={16} />
                <span>{error}</span>
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
                ? Array.from(new Set(rest.map((t) => t.due_date)))
                    .sort()
                    .map((d) =>
                      group(
                        dateLabel(d),
                        rest.filter((t) => t.due_date === d),
                        false,
                        d ?? "",
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
      {menu && <ContextMenu request={menu} close={closeMenu} />}
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {notice}
        </div>
      )}
      {error && (editor || projectEditor || settings) && (
        <div className="error floating-error" role="alert">
          <CircleAlert className="error-icon" size={16} />
          <span>{error}</span>
          <button
            aria-label="Dismiss error notification"
            onClick={() => setError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {editor && (
        <TaskEditor
          key={editor === "new" ? "new" : editor.id}
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
                await editorWrite(
                  editor,
                  () =>
                    api(`/tasks/${editor.id}`, "PATCH", {
                      ...draft,
                      version: editor.version,
                    }),
                  "Your edits are still here. Save again to replace that change, or cancel to keep it.",
                );
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
                    await editorWrite(
                      editor,
                      () =>
                        api(
                          `/tasks/${editor.id}?version=${editor.version}`,
                          "DELETE",
                        ),
                      "Confirm delete again to remove it anyway.",
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
              // Push cleanup is best effort. An unreachable server fails the next request and reports it.
              await disableBrowserPush().catch(() => undefined);
              await api("/auth/logout", "POST").catch((e) => {
                if (e.status !== 401) throw e;
              });
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
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
