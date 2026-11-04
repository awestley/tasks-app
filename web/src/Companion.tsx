// The Tasks companion (westley-app docs/companion.md): a small view kept beside the workspace, docked,
// floating or as a bottom sheet. Its own entry (companion.html), so it loads without the full app.
//
// Capture at the top (Enter adds and keeps focus), today's list below, check off in place, and open a
// task or the full app in a column. Keyboard: arrows move, Space checks off, Enter opens.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, ExternalLink } from "lucide-react";
import {
  api,
  dateLabel,
  localDate,
  type ParsedTask,
  type Project,
  type Task,
} from "./api";
import { useCommands, usePc, useSurface } from "@awestley/pc-runtime/react";

type View = "today" | "inbox" | "upcoming" | "all";
const VIEWS: [View, string][] = [
  ["today", "Today"],
  ["inbox", "Inbox"],
  ["upcoming", "Upcoming"],
  ["all", "All tasks"],
];
const readView = (): View => {
  const v = location.hash.replace(/^#\/?/, "");
  return VIEWS.some(([id]) => id === v) ? (v as View) : "today";
};

async function openTasks(): Promise<Task[]> {
  const out: Task[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await api<Task[]>(
      `/tasks?completed=false&limit=200&offset=${offset}`,
    );
    out.push(...page);
    if (page.length < 200) return out;
  }
}

function sortTasks(a: Task, b: Task) {
  const da = a.due_date || "9999",
    db = b.due_date || "9999";
  if (da !== db) return da < db ? -1 : 1;
  const ta = a.due_time || "99",
    tb = b.due_time || "99";
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.created_at < b.created_at ? -1 : 1;
}

export default function Companion() {
  const pc = usePc();
  const surface = useSurface();
  const [view, setView] = useState<View>(readView);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const load = useCallback(async () => {
    try {
      const [t, p] = await Promise.all([
        openTasks(),
        api<Project[]>("/projects"),
      ]);
      setTasks(t);
      setProjects(p);
      setError("");
    } catch (e) {
      setError(
        (e as { status?: number }).status === 401
          ? "Sign in to Personal Command to see your tasks."
          : "Can’t load tasks right now.",
      );
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Changes from anywhere (a Tasks column, an embed in a note, another device) arrive on /events.
  // Nothing runs while the view is hidden: the collapsed strip and a hidden pop-out are hidden.
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (source || typeof EventSource === "undefined") return;
      source = new EventSource("api/v1/events");
      source.onmessage = () => {
        clearTimeout(timer);
        timer = setTimeout(load, 150);
      };
    };
    const stop = () => {
      source?.close();
      source = null;
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        start();
        load();
      }
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearTimeout(timer);
      stop();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load]);

  useEffect(() => {
    const follow = () => setView(readView());
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  // The shell's quick add (palette, and later the Mac's global hotkey) lands in the capture field.
  useCommands([{ id: "new-task", label: "New task" }], (id) => {
    if (id === "new-task") input.current?.focus();
  });

  const today = localDate();
  const shown = useMemo(() => {
    if (!tasks) return [];
    return tasks
      .filter((t) => {
        if (view === "today") return !!t.due_date && t.due_date <= today;
        if (view === "inbox") return !t.project_id;
        if (view === "upcoming") return !!t.due_date && t.due_date > today;
        return true;
      })
      .sort(sortTasks);
  }, [tasks, view, today]);
  const projectName = (id: string | null) => projects.find((p) => p.id === id);

  const choose = (next: View) => {
    history.replaceState(null, "", "#" + next);
    setView(next);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    const time_zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      const parsed = await api<ParsedTask>("/tasks/parse", "POST", {
        text,
        time_zone,
      }).catch(() => null);
      const fields = {
        id: crypto.randomUUID(),
        title: parsed?.title || text,
        description: "",
        due_date: parsed?.due_date ?? (view === "today" ? today : null),
        due_time: parsed?.due_time ?? null,
        time_zone,
        reminder_minutes: parsed?.reminder_minutes ?? null,
        recurrence: parsed?.recurrence ?? null,
        priority: parsed?.priority ?? 4,
        labels: parsed?.labels ?? [],
        project_id: parsed?.project_id ?? null,
        checklist: [],
      };
      const created = await api<Task>("/tasks", "POST", fields);
      setTasks((list) => (list ? [...list, created] : [created]));
      setDraft("");
    } catch (err) {
      pc.notify((err as Error).message || "Couldn’t add the task.", "error");
    } finally {
      setAdding(false);
      input.current?.focus();
    }
  };

  const complete = async (task: Task) => {
    setDone((s) => new Set(s).add(task.id));
    try {
      await api<Task>(`/tasks/${task.id}`, "PATCH", {
        version: task.version,
        completed: true,
      });
      // Leave it struck through for a moment, so it's clear what happened.
      setTimeout(() => {
        setTasks((list) => list?.filter((t) => t.id !== task.id) || null);
        setDone((s) => {
          const n = new Set(s);
          n.delete(task.id);
          return n;
        });
      }, 900);
    } catch {
      setDone((s) => {
        const n = new Set(s);
        n.delete(task.id);
        return n;
      });
      load();
    }
  };

  const openTask = (task: Task) =>
    pc.open(`pc://tasks/task/${task.id}`, { placement: "new-column" });
  const openFull = () =>
    pc.open(location.pathname.replace(/companion\.html$/, "") + "#/" + view, {
      placement: "new-column",
    });

  const onRowKey = (e: React.KeyboardEvent<HTMLLIElement>, task: Task) => {
    const rows = [
      ...(list.current?.querySelectorAll<HTMLElement>("li[tabindex]") || []),
    ];
    const i = rows.indexOf(e.currentTarget);
    if (e.key === "ArrowDown") rows[i + 1]?.focus();
    else if (e.key === "ArrowUp") (rows[i - 1] || input.current)?.focus();
    else if (e.key === " ") complete(task);
    else if (e.key === "Enter") openTask(task);
    else return;
    e.preventDefault();
  };

  const kind = surface.kind;
  const peek = kind === "sheet" && surface.detent === "peek";
  return (
    <div className={`companion is-${kind}${peek ? " is-peek" : ""}`}>
      {!peek && (
        <header className="companion-head">
          <select
            className="gl-dropdown"
            aria-label="List"
            value={view}
            onChange={(e) => choose(e.target.value as View)}
          >
            {VIEWS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          {tasks && <span className="companion-count">{shown.length}</span>}
          <span className="companion-spacer" />
          <button
            className="companion-icon"
            type="button"
            title="Open in a column"
            aria-label="Open in a column"
            onClick={openFull}
          >
            <ExternalLink size={15} />
          </button>
        </header>
      )}
      <form className="companion-add" onSubmit={add}>
        <input
          ref={input}
          className="gl-search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              list.current?.querySelector<HTMLElement>("li[tabindex]")?.focus();
            } else if (e.key === "Escape") input.current?.blur();
          }}
          placeholder={view === "today" ? "Add a task for today" : "Add a task"}
          aria-label="Add a task"
          disabled={!!error && !tasks}
        />
      </form>
      {!peek && (
        <ul className="companion-list" ref={list} aria-label="Tasks">
          {error && <li className="companion-empty">{error}</li>}
          {!error && tasks && !shown.length && (
            <li className="companion-empty">
              {view === "today" ? "Nothing due today." : "No tasks here."}
            </li>
          )}
          {shown.map((t) => {
            const project = projectName(t.project_id);
            const overdue = !!t.due_date && t.due_date < today;
            const isDone = done.has(t.id);
            return (
              <li
                key={t.id}
                tabIndex={0}
                className={`companion-row${isDone ? " is-done" : ""}`}
                onKeyDown={(e) => onRowKey(e, t)}
              >
                <button
                  type="button"
                  className={`companion-check priority-${t.priority}`}
                  aria-label={`Complete ${t.title}`}
                  tabIndex={-1}
                  onClick={() => complete(t)}
                  disabled={isDone}
                >
                  {isDone && <Check size={11} strokeWidth={3} />}
                </button>
                <button
                  type="button"
                  className="companion-title"
                  tabIndex={-1}
                  onClick={() => openTask(t)}
                >
                  <span className="companion-name">{t.title}</span>
                  {(t.due_date || project) && (
                    <span className="companion-meta">
                      {t.due_date && view !== "today" && (
                        <span className={overdue ? "is-overdue" : ""}>
                          {dateLabel(t.due_date)}
                          {t.due_time ? ` ${t.due_time}` : ""}
                        </span>
                      )}
                      {t.due_date &&
                        view === "today" &&
                        (overdue || t.due_time) && (
                          <span className={overdue ? "is-overdue" : ""}>
                            {overdue ? dateLabel(t.due_date) : t.due_time}
                          </span>
                        )}
                      {project && (
                        <span>
                          <span
                            className="companion-hash"
                            style={{ color: project.color }}
                          >
                            #
                          </span>{" "}
                          {project.name}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
