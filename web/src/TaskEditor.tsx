import { useEffect, useState } from "react";
import { CalendarDays, Flag, Inbox, Repeat2, Trash2, X } from "lucide-react";
import {
  api,
  dateLabel,
  type ParsedTask,
  type Project,
  type Task,
} from "./api";
import { ChecklistEditor } from "./ChecklistEditor";
import { Modal } from "./Modal";
import { emptyDraft, parseLabels, reminderChoices, type Draft } from "./tasks";

export function TaskEditor({
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
              labels: parseLabels(labelText),
            }),
          );
        }}
      >
        <div className="modal-heading">
          <h2>{task ? "Edit task" : "Add task"}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close editor"
          >
            <X />
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
                  labels: parseLabels(labelText),
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
                labels: parseLabels(labelText),
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
              {reminderChoices.map(([minutes, label]) => (
                <option key={minutes} value={minutes}>
                  {label}
                </option>
              ))}
              {draft.reminder_minutes !== null &&
                !reminderChoices.some(
                  ([minutes]) => minutes === draft.reminder_minutes,
                ) && (
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
              className={`danger-button ${confirm ? "mod-cta" : ""}`}
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
