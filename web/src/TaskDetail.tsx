// One task, edited in place. Changes save as you go (text after a short pause), like Todoist's task
// view. Beside the list on a wide screen, over it on a narrow one or in the companion.
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bell,
  CalendarDays,
  Check,
  ExternalLink,
  Globe,
  Inbox,
  MoreHorizontal,
  Repeat2,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import type { Project, Task } from "./api";
import { ChecklistEditor } from "./ChecklistEditor";
import type { MenuEntry } from "./ContextMenu";
import { autoReminder } from "./reminders";
import { getState, type TaskChanges } from "./store";
import {
  AutoText,
  DatePicker,
  dueLabel,
  dueTone,
  priorityNames,
  PriorityFlag,
  recurrenceLabel,
  reminderChoices,
} from "./ui";

export function TaskDetail({
  task,
  projects,
  allLabels,
  overlay,
  toggle,
  patch,
  remove,
  close,
  openMenu,
  projectMenu,
  priorityMenu,
  openInColumn,
  linked,
}: {
  task: Task;
  projects: Project[];
  allLabels: string[];
  /** Shown over the list (narrow screens, the companion) rather than beside it. */
  overlay: boolean;
  toggle: () => void;
  patch: (changes: TaskChanges) => void;
  remove: () => void;
  close: () => void;
  openMenu: (
    e: React.MouseEvent,
    entries?: MenuEntry[],
    title?: string,
  ) => void;
  projectMenu: () => MenuEntry[];
  priorityMenu: () => MenuEntry[];
  openInColumn?: () => void;
  linked?: React.ReactNode;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [checklist, setChecklist] = useState(task.checklist);
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const [labelText, setLabelText] = useState("");
  const [confirm, setConfirm] = useState(false);
  const editing = useRef<"title" | "description" | "checklist" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(task);
  latest.current = task;

  // Follow changes from elsewhere, except in the field being typed in.
  useEffect(() => {
    if (editing.current !== "title") setTitle(task.title);
    if (editing.current !== "description") setDescription(task.description);
    if (editing.current !== "checklist") setChecklist(task.checklist);
  }, [task.title, task.description, task.checklist]);
  useEffect(() => {
    setConfirm(false);
    editing.current = null;
  }, [task.id]);

  const save = (changes: TaskChanges, delay = 0) => {
    clearTimeout(timer.current);
    const run = () => patch(changes);
    if (delay) timer.current = setTimeout(run, delay);
    else run();
  };
  const saveTitle = (value: string) => {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean && clean !== latest.current.title) save({ title: clean });
  };
  const saveChecklist = (items: Task["checklist"]) => {
    if (items.some((i) => !i.title.trim())) return; // wait until the new item has a name
    if (JSON.stringify(items) !== JSON.stringify(latest.current.checklist))
      save({ checklist: items });
  };
  // Leaving the task (another row, Escape, closing) saves whatever is still waiting on the pause.
  const draft = useRef({ title, description, checklist });
  draft.current = { title, description, checklist };
  const patchRef = useRef(patch);
  patchRef.current = patch;
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      const d = draft.current;
      const t = latest.current;
      if (!getState().tasks.some((x) => x.id === t.id)) return;
      const changes: TaskChanges = {};
      const clean = d.title.replace(/\s+/g, " ").trim();
      if (clean && clean !== t.title) changes.title = clean;
      if (d.description !== t.description) changes.description = d.description;
      if (
        !d.checklist.some((i) => !i.title.trim()) &&
        JSON.stringify(d.checklist) !== JSON.stringify(t.checklist)
      )
        changes.checklist = d.checklist;
      if (Object.keys(changes).length) patchRef.current(changes);
    },
    [],
  );

  const project = projects.find((p) => p.id === task.project_id);
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [showZone, setShowZone] = useState(task.time_zone !== deviceZone);
  const addLabel = (raw: string) => {
    const label = raw.trim().replace(/^@/, "").toLowerCase();
    if (!label || task.labels.includes(label) || task.labels.length >= 20)
      return;
    patch({ labels: [...task.labels, label] });
    setLabelText("");
  };
  const menuButton = (
    e: React.MouseEvent,
    entries: MenuEntry[],
    label: string,
  ) => openMenu(e, entries, label);

  return (
    <aside
      className={`detail${overlay ? " is-overlay" : ""}${task.completed ? " is-complete" : ""}`}
      aria-label="Task details"
    >
      <header className="detail-head">
        <button
          className="icon-button"
          aria-label={overlay ? "Back to list" : "Close task"}
          onClick={close}
        >
          {overlay ? <ArrowLeft size={18} /> : <X size={18} />}
        </button>
        <button
          className="detail-crumb"
          onClick={(e) => menuButton(e, projectMenu(), "Move to")}
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
        <span className="spacer" />
        {openInColumn && (
          <button
            className="icon-button"
            aria-label="Open in a column"
            title="Open in a column"
            onClick={openInColumn}
          >
            <ExternalLink size={16} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label="More task actions"
          onClick={(e) => openMenu(e)}
        >
          <MoreHorizontal size={18} />
        </button>
      </header>
      <div className="detail-body">
        <div className="detail-main">
          <div className="detail-title">
            <button
              className={`check-task priority-${task.priority}`}
              aria-label={`${task.completed ? "Restore" : "Complete"} ${task.title}`}
              onClick={toggle}
            >
              {task.completed && <Check size={13} />}
            </button>
            <AutoText
              aria-label="Task title"
              className="detail-title-input"
              value={title}
              maxLength={500}
              onFocus={() => (editing.current = "title")}
              onChange={(e) => {
                setTitle(e.target.value);
                const value = e.target.value;
                clearTimeout(timer.current);
                timer.current = setTimeout(() => saveTitle(value), 700);
              }}
              onBlur={() => {
                editing.current = null;
                clearTimeout(timer.current);
                if (!title.trim()) setTitle(task.title);
                else saveTitle(title);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLTextAreaElement).blur();
                }
              }}
            />
          </div>
          <AutoText
            aria-label="Description"
            className="detail-description"
            placeholder="Description"
            value={description}
            maxLength={10000}
            minRows={2}
            onFocus={() => (editing.current = "description")}
            onChange={(e) => {
              setDescription(e.target.value);
              const value = e.target.value;
              clearTimeout(timer.current);
              timer.current = setTimeout(() => {
                if (value !== latest.current.description)
                  save({ description: value });
              }, 700);
            }}
            onBlur={() => {
              editing.current = null;
              clearTimeout(timer.current);
              if (description !== task.description) save({ description });
            }}
          />
          {linked}
          <div
            onFocus={() => (editing.current = "checklist")}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                editing.current = null;
                saveChecklist(checklist);
              }
            }}
          >
            <ChecklistEditor
              items={checklist}
              locked={task.completed}
              onChange={(items) => {
                setChecklist(items);
                const structural =
                  items.length !== checklist.length ||
                  items.some(
                    (item, i) => item.completed !== checklist[i]?.completed,
                  );
                clearTimeout(timer.current);
                if (structural) saveChecklist(items);
                else
                  timer.current = setTimeout(() => saveChecklist(items), 700);
              }}
            />
          </div>
        </div>
        <div className="detail-side">
          <div className="detail-field">
            <span>Project</span>
            <button onClick={(e) => menuButton(e, projectMenu(), "Move to")}>
              {project ? (
                <span className="project-hash" style={{ color: project.color }}>
                  #
                </span>
              ) : (
                <Inbox size={15} />
              )}
              {project?.name || "Inbox"}
            </button>
          </div>
          <div className="detail-field">
            <span>Date</span>
            <button
              className={dueTone(task.due_date, task.completed)}
              aria-label="Due date"
              onClick={(e) =>
                setPicker(
                  (e.currentTarget as HTMLElement).getBoundingClientRect(),
                )
              }
            >
              <CalendarDays size={15} />
              {task.due_date
                ? dueLabel(task.due_date, task.due_time)
                : "No date"}
              {task.recurrence && (
                <Repeat2
                  size={13}
                  aria-label={recurrenceLabel[task.recurrence]}
                />
              )}
            </button>
          </div>
          <div className="detail-field">
            <span>Priority</span>
            <button onClick={(e) => menuButton(e, priorityMenu(), "Priority")}>
              <PriorityFlag priority={task.priority} size={15} />
              {priorityNames[task.priority]}
            </button>
          </div>
          <div className="detail-field">
            <span>Reminder</span>
            <label className="detail-select">
              <Bell size={15} />
              <select
                aria-label="Reminder"
                disabled={!task.due_time}
                title={
                  task.due_time ? "" : "Give the task a time to set a reminder"
                }
                value={task.reminder_minutes ?? ""}
                onChange={(e) =>
                  patch({
                    reminder_minutes:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              >
                <option value="">None</option>
                {reminderChoices.map(([m, label]) => (
                  <option key={m} value={m}>
                    {label}
                  </option>
                ))}
                {task.reminder_minutes !== null &&
                  !reminderChoices.some(
                    ([m]) => m === task.reminder_minutes,
                  ) && (
                    <option value={task.reminder_minutes}>
                      {task.reminder_minutes} minutes before
                    </option>
                  )}
              </select>
            </label>
          </div>
          <div className="detail-field is-labels">
            <span>Labels</span>
            <div className="detail-labels">
              {task.labels.map((l) => (
                <span key={l} className="label-chip">
                  <Tag size={11} />
                  {l}
                  <button
                    aria-label={`Remove label ${l}`}
                    onClick={() =>
                      patch({ labels: task.labels.filter((x) => x !== l) })
                    }
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              <input
                aria-label="Add label"
                placeholder="Add label"
                list="all-labels"
                value={labelText}
                onChange={(e) => setLabelText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addLabel(labelText);
                  }
                }}
                onBlur={() => addLabel(labelText)}
              />
              <datalist id="all-labels">
                {allLabels
                  .filter((l) => !task.labels.includes(l))
                  .map((l) => (
                    <option key={l} value={l} />
                  ))}
              </datalist>
            </div>
          </div>
          {showZone ? (
            <div className="detail-field">
              <span>Time zone</span>
              <label className="detail-select">
                <Globe size={15} />
                <input
                  aria-label="Time zone"
                  defaultValue={task.time_zone}
                  key={task.time_zone}
                  onBlur={(e) => {
                    const zone = e.target.value.trim();
                    if (zone && zone !== task.time_zone)
                      patch({ time_zone: zone });
                  }}
                />
              </label>
            </div>
          ) : (
            <button className="detail-more" onClick={() => setShowZone(true)}>
              <Globe size={13} /> Time zone: {task.time_zone}
            </button>
          )}
        </div>
      </div>
      <footer className="detail-foot">
        <small>
          Added{" "}
          {new Date(
            task.created_at + (task.created_at.endsWith("Z") ? "" : "Z"),
          ).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          {task.completed && task.completed_at
            ? ` · Completed ${new Date(task.completed_at + (task.completed_at.endsWith("Z") ? "" : "Z")).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
            : ""}
        </small>
        <button
          className={`danger-button ${confirm ? "mod-cta" : ""}`}
          onClick={() => (confirm ? remove() : setConfirm(true))}
        >
          <Trash2 size={14} />
          {confirm ? "Confirm delete" : "Delete"}
        </button>
      </footer>
      {picker && (
        <DatePicker
          anchor={picker}
          value={task}
          close={() => setPicker(null)}
          change={(next) =>
            patch({
              due_date: next.due_date,
              due_time: next.due_date ? next.due_time : null,
              recurrence: next.due_date
                ? (next.recurrence as Task["recurrence"])
                : null,
              // A time added now gets the automatic reminder, as in quick add.
              reminder_minutes:
                next.due_date && next.due_time
                  ? task.due_time
                    ? task.reminder_minutes
                    : autoReminder()
                  : null,
            })
          }
        />
      )}
    </aside>
  );
}
