// Quick add, as in Todoist: one line, and details are picked out as you type. Dates, times,
// "every …", p1–p4, #Project, @label and "!30m before" highlight at once, without waiting on the
// server, so it works offline too. # and @ suggest projects and labels. Enter adds the task and
// keeps the field open for the next one. Click a highlighted word to keep it as plain text.
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bell,
  CalendarDays,
  CornerDownLeft,
  Hash,
  Inbox,
  Plus,
  Repeat2,
  Tag,
  X,
} from "lucide-react";
import type { Project, Task } from "./api";
import { ContextMenu, type MenuEntry, type MenuRequest } from "./ContextMenu";
import {
  parseQuick,
  stripTokens,
  tokenKey,
  type Token,
  type TokenKind,
} from "./parse";
import { autoReminder } from "./reminders";
import {
  DatePicker,
  dueLabel,
  dueTone,
  priorityNames,
  PriorityFlag,
  recurrenceLabel,
  reminderChoices,
  reminderLabel,
  type Due,
} from "./ui";

export type NewTask = Pick<
  Task,
  | "title"
  | "description"
  | "project_id"
  | "due_date"
  | "due_time"
  | "reminder_minutes"
  | "priority"
  | "labels"
  | "recurrence"
>;
export type QuickDefaults = {
  project_id?: string | null;
  due_date?: string | null;
  labels?: string[];
};
type Overrides = {
  due?: Due;
  priority?: number;
  project_id?: string | null;
  labels?: string[];
  reminder?: number | null;
};
type Suggest = {
  trigger: "#" | "@";
  start: number;
  end: number;
  items: { label: string; insert: string; create?: boolean; color?: string }[];
  index: number;
};

export function QuickAdd({
  variant,
  projects,
  labels,
  defaults = {},
  add,
  close,
  createProject,
  focusKey,
  autoFocus = false,
  placeholder,
}: {
  /** modal: the Q dialog. inline: in a list. bar: the companion's field at the top. */
  variant: "modal" | "inline" | "bar";
  projects: Project[];
  labels: string[];
  defaults?: QuickDefaults;
  add: (task: NewTask) => void;
  close?: () => void;
  createProject: (name: string) => Project;
  /** Changing this focuses the field (the shell's quick add command). */
  focusKey?: number;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [description, setDescription] = useState("");
  const [ignore, setIgnore] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<Overrides>({});
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const pointerDown = useRef(false);

  useEffect(() => {
    if (focusKey) input.current?.focus();
  }, [focusKey]);

  const parsed = useMemo(
    () => parseQuick(text, { projects, ignore }),
    [text, projects, ignore],
  );
  const fromText = parsed.tokens.length > 0 || parsed.title !== text;
  const due: Due = over.due ?? {
    due_date: parsed.due_date ?? defaults.due_date ?? null,
    due_time: parsed.due_time,
    recurrence: parsed.recurrence,
  };
  const priority = over.priority ?? parsed.priority ?? 4;
  const projectId =
    over.project_id !== undefined
      ? over.project_id
      : (parsed.project_id ?? defaults.project_id ?? null);
  const taskLabels = [
    ...new Set([
      ...(defaults.labels || []),
      ...parsed.labels,
      ...(over.labels || []),
    ]),
  ];
  const reminder =
    over.reminder !== undefined
      ? over.reminder
      : due.due_time
        ? (parsed.reminder_minutes ?? autoReminder())
        : null;
  const title = fromText ? parsed.title : text.trim();
  const project = projects.find((p) => p.id === projectId);

  function reset() {
    setText("");
    setDescription("");
    setIgnore(new Set());
    setOver({});
    setSuggest(null);
  }
  function submit(andClose = false) {
    if (!title.trim()) return;
    add({
      title: title.trim(),
      description: description.trim(),
      project_id: projectId,
      due_date: due.due_date,
      due_time: due.due_date ? due.due_time : null,
      reminder_minutes: due.due_date && due.due_time ? reminder : null,
      priority,
      labels: taskLabels,
      recurrence: due.due_date ? due.recurrence : null,
    });
    reset();
    if (andClose) close?.();
    else input.current?.focus();
  }
  /** A picker replaced what the text said: drop those words from the text. */
  function replaceTokens(kinds: TokenKind[]) {
    if (parsed.tokens.some((t) => kinds.includes(t.kind)))
      setText(stripTokens(text, parsed.tokens, kinds));
  }

  // Suggestions for #project and @label at the caret.
  function updateSuggest(value: string, caret: number) {
    let i = caret - 1;
    while (i >= 0 && value[i] !== "#" && value[i] !== "@" && caret - i <= 40)
      i--;
    if (
      i < 0 ||
      (value[i] !== "#" && value[i] !== "@") ||
      (i > 0 && !/\s/.test(value[i - 1]))
    ) {
      setSuggest(null);
      return;
    }
    const trigger = value[i] as "#" | "@";
    const query = value.slice(i + 1, caret);
    if (trigger === "@" && /\s/.test(query)) return setSuggest(null);
    const q = query.toLowerCase();
    let items: Suggest["items"];
    if (trigger === "#") {
      items = projects
        .filter((p) => p.name.toLowerCase().includes(q))
        .sort(
          (a, b) =>
            +!a.name.toLowerCase().startsWith(q) -
            +!b.name.toLowerCase().startsWith(q),
        )
        .slice(0, 6)
        .map((p) => ({ label: p.name, insert: "#" + p.name, color: p.color }));
      if (!items.length && /\s$/.test(query)) return setSuggest(null);
      if (
        query.trim() &&
        !projects.some((p) => p.name.toLowerCase() === q.trim())
      )
        items.push({
          label: `Create project “${query.trim()}”`,
          insert: query.trim(),
          create: true,
        });
    } else {
      items = labels
        .filter((l) => l.includes(q))
        .slice(0, 6)
        .map((l) => ({ label: l, insert: "@" + l }));
      if (q && !labels.includes(q))
        items.push({ label: `New label “${q}”`, insert: "@" + q });
    }
    if (!items.length) return setSuggest(null);
    setSuggest({ trigger, start: i, end: caret, items, index: 0 });
  }
  function choose(item: Suggest["items"][number]) {
    if (!suggest) return;
    let insert = item.insert;
    if (item.create) insert = "#" + createProject(item.insert).name;
    const next =
      text.slice(0, suggest.start) +
      insert +
      " " +
      text.slice(suggest.end).replace(/^\s+/, "");
    setText(next);
    setSuggest(null);
    const caret = suggest.start + insert.length + 1;
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
    });
  }

  // Keep the highlights lined up with the field while it scrolls sideways.
  useLayoutEffect(() => {
    if (backdrop.current && input.current)
      backdrop.current.scrollLeft = input.current.scrollLeft;
  });

  const segments: React.ReactNode[] = [];
  let at = 0;
  for (const t of parsed.tokens) {
    if (t.start > at) segments.push(text.slice(at, t.start));
    segments.push(
      <mark key={t.start} className={`tok tok-${t.kind}`}>
        {text.slice(t.start, t.end)}
      </mark>,
    );
    at = t.end;
  }
  segments.push(text.slice(at) + " ");

  const menuAt = (e: React.MouseEvent, entries: MenuEntry[], label: string) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: box.left,
      y: box.bottom + 4,
      entries,
      title: label,
      sheet: matchMedia("(pointer: coarse)").matches && innerWidth < 600,
    });
  };
  const priorityMenu = (): MenuEntry[] =>
    [1, 2, 3, 4].map((p) => ({
      label: `${priorityNames[p]} · p${p}`,
      icon: <PriorityFlag priority={p} />,
      checked: priority === p,
      action: () => {
        replaceTokens(["priority"]);
        setOver((o) => ({ ...o, priority: p }));
      },
    }));
  const projectMenu = (): MenuEntry[] => [
    {
      label: "Inbox",
      icon: <Inbox size={16} />,
      checked: !projectId,
      action: () => {
        replaceTokens(["project"]);
        setOver((o) => ({ ...o, project_id: null }));
      },
    },
    ...projects.map((p) => ({
      label: p.name,
      icon: (
        <span className="project-hash" style={{ color: p.color }}>
          #
        </span>
      ),
      checked: projectId === p.id,
      action: () => {
        replaceTokens(["project"]);
        setOver((o) => ({ ...o, project_id: p.id }));
      },
    })),
  ];
  const reminderMenu = (): MenuEntry[] => [
    {
      label: "No reminder",
      checked: reminder === null,
      action: () => {
        replaceTokens(["reminder"]);
        setOver((o) => ({ ...o, reminder: null }));
      },
    },
    ...reminderChoices.map(([m, label]) => ({
      label,
      checked: reminder === m,
      action: () => {
        replaceTokens(["reminder"]);
        setOver((o) => ({ ...o, reminder: m }));
      },
    })),
  ];
  const labelMenu = (): MenuEntry[] =>
    labels.length
      ? labels.map((l) => ({
          label: l,
          icon: <Tag size={14} />,
          checked: taskLabels.includes(l),
          action: () =>
            setOver((o) => {
              const current = new Set(o.labels || []);
              if (taskLabels.includes(l)) {
                current.delete(l);
                if (parsed.labels.includes(l))
                  setIgnore(
                    new Set([
                      ...ignore,
                      tokenKey({ kind: "label", text: "@" + l }),
                    ]),
                  );
              } else current.add(l);
              return { ...o, labels: [...current] };
            }),
        }))
      : [
          {
            label: "Type @ and a name to add a label",
            action: () => input.current?.focus(),
          },
        ];

  const showChips = variant !== "bar" || focused || text.length > 0;
  const chips = showChips && (
    <div className="qa-chips">
      <span className={`qa-chip-wrap${due.due_date ? " has-clear" : ""}`}>
        <button
          type="button"
          className={`qa-chip ${due.due_date ? "is-set " + dueTone(due.due_date) : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) =>
            setPicker((e.currentTarget as HTMLElement).getBoundingClientRect())
          }
          aria-label="Date"
        >
          <CalendarDays size={14} />
          {due.due_date ? dueLabel(due.due_date, due.due_time) : "Date"}
          {due.recurrence && (
            <Repeat2 size={12} aria-label={recurrenceLabel[due.recurrence]} />
          )}
        </button>
        {due.due_date && (
          <button
            type="button"
            className="qa-chip-clear"
            aria-label="Remove date"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              replaceTokens(["date", "time", "recurrence"]);
              setOver((o) => ({
                ...o,
                due: { due_date: null, due_time: null, recurrence: null },
              }));
            }}
          >
            <X size={12} />
          </button>
        )}
      </span>
      <button
        type="button"
        className={`qa-chip ${priority < 4 ? "is-set" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => menuAt(e, priorityMenu(), "Priority")}
        aria-label="Priority"
      >
        <PriorityFlag priority={priority} size={14} />
        {priority < 4 ? `P${priority}` : "Priority"}
      </button>
      {due.due_time && (
        <button
          type="button"
          className={`qa-chip ${reminder !== null ? "is-set" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => menuAt(e, reminderMenu(), "Reminder")}
          aria-label="Reminder"
          title={reminderLabel(reminder)}
        >
          <Bell size={14} />
          {reminder === null
            ? "Reminder"
            : reminder === 0
              ? "At time"
              : reminderLabel(reminder).replace(" before", "")}
        </button>
      )}
      <button
        type="button"
        className={`qa-chip ${taskLabels.length ? "is-set" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => menuAt(e, labelMenu(), "Labels")}
        aria-label="Labels"
      >
        <Tag size={14} />
        {taskLabels.length ? taskLabels.join(", ") : "Labels"}
      </button>
      {variant === "bar" && (
        <button
          type="button"
          className={`qa-chip ${projectId ? "is-set" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => menuAt(e, projectMenu(), "Project")}
          aria-label="Project"
        >
          {project ? (
            <span className="project-hash" style={{ color: project.color }}>
              #
            </span>
          ) : (
            <Inbox size={14} />
          )}
          {project?.name || "Inbox"}
        </button>
      )}
    </div>
  );

  const field = (
    <div className="qa-field">
      {variant === "bar" && <Plus size={16} className="qa-plus" />}
      <div className="qa-line">
        <div className="qa-backdrop" ref={backdrop} aria-hidden="true">
          {segments}
        </div>
        <input
          ref={input}
          className="qa-input"
          aria-label="Task name"
          placeholder={
            placeholder ||
            (variant === "bar"
              ? "Add a task"
              : "Task name, e.g. Call mom tomorrow 5pm p1 #Home")
          }
          maxLength={500}
          autoFocus={autoFocus}
          spellCheck
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setTimeout(() => setSuggest(null), 150);
          }}
          onPointerDown={() => (pointerDown.current = true)}
          onClick={(e) => {
            // Clicking a highlighted word keeps it as plain text, as in Todoist.
            const el = e.currentTarget;
            if (!pointerDown.current || el.selectionStart !== el.selectionEnd)
              return;
            pointerDown.current = false;
            const caret = el.selectionStart ?? 0;
            const hit = parsed.tokens.find(
              (t: Token) => caret > t.start && caret < t.end,
            );
            if (hit) setIgnore(new Set([...ignore, tokenKey(hit)]));
          }}
          onScroll={(e) => {
            if (backdrop.current)
              backdrop.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
          onChange={(e) => {
            setText(e.target.value);
            updateSuggest(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length,
            );
          }}
          onKeyDown={(e) => {
            if (suggest) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = suggest.items.length;
                setSuggest({
                  ...suggest,
                  index:
                    (suggest.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n,
                });
                return;
              }
              const item = suggest.items[suggest.index];
              const typed = text
                .slice(suggest.start, suggest.end)
                .toLowerCase();
              // When picking would not change the text (a whole project name, or a new label), Enter adds the task.
              const finished =
                !item.create && item.insert.toLowerCase() === typed;
              if (e.key === "Tab" || (e.key === "Enter" && !finished)) {
                e.preventDefault();
                choose(item);
                return;
              }
              if (e.key === "Enter") setSuggest(null);
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setSuggest(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(e.metaKey || e.ctrlKey);
            } else if (e.key === "Escape") {
              e.stopPropagation();
              if (variant === "bar") {
                if (text) reset();
                else input.current?.blur();
              } else close?.();
            } else if (e.key === "ArrowDown" && variant === "bar" && !text) {
              e.preventDefault();
              (
                document.querySelector(".task-row") as HTMLElement | null
              )?.focus();
            }
          }}
        />
      </div>
      {variant === "bar" && text.trim() && (
        <button
          type="button"
          className="qa-enter"
          aria-label="Add task"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => submit()}
        >
          <CornerDownLeft size={14} />
        </button>
      )}
      {suggest && (
        <div
          className="qa-suggest gl-glass"
          role="listbox"
          aria-label="Suggestions"
        >
          {suggest.items.map((item, i) => (
            <button
              key={item.label}
              type="button"
              role="option"
              aria-selected={i === suggest.index}
              className={i === suggest.index ? "is-selected" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(item);
              }}
            >
              {suggest.trigger === "#" ? (
                item.create ? (
                  <Plus size={14} />
                ) : (
                  <Hash size={14} style={{ color: item.color }} />
                )
              ) : (
                <Tag size={14} />
              )}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const popups = (
    <>
      {picker && (
        <DatePicker
          anchor={picker}
          value={due}
          close={() => {
            setPicker(null);
            input.current?.focus();
          }}
          change={(next) => {
            replaceTokens(["date", "time", "recurrence"]);
            setOver((o) => ({ ...o, due: next }));
          }}
        />
      )}
      {menu && (
        <ContextMenu
          request={menu}
          close={() => {
            setMenu(null);
            requestAnimationFrame(() => input.current?.focus());
          }}
        />
      )}
    </>
  );

  if (variant === "bar")
    return (
      <form
        className={`quick-add-bar${focused || text ? " is-active" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {field}
        {chips}
        {popups}
      </form>
    );

  return (
    <form
      className={`quick-add-box is-${variant}`}
      onSubmit={(e) => {
        // Only the button submits the form (Enter is handled on the fields and keeps the dialog open).
        e.preventDefault();
        submit(variant === "modal");
      }}
    >
      {field}
      <input
        className="qa-description"
        aria-label="Description"
        placeholder="Description"
        maxLength={10000}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit(e.metaKey || e.ctrlKey);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            close?.();
          }
        }}
      />
      {chips}
      <div className="qa-footer">
        <button
          type="button"
          className="qa-project"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => menuAt(e, projectMenu(), "Project")}
          aria-label="Project"
        >
          {project ? (
            <span className="project-hash" style={{ color: project.color }}>
              #
            </span>
          ) : (
            <Inbox size={15} />
          )}
          {project?.name || "Inbox"}
        </button>
        <span className="qa-hint">
          <kbd>↵</kbd> add · <kbd>esc</kbd> close
        </span>
        {close && (
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
        )}
        <button className="primary" disabled={!title.trim()}>
          Add task
        </button>
      </div>
      {popups}
    </form>
  );
}
