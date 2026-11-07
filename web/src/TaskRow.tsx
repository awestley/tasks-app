import {
  Bell,
  CalendarDays,
  Check,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Repeat2,
  Tag,
} from "lucide-react";
import type { Task } from "./api";
import { taskMenu } from "./taskMenus";
import {
  dueLabel,
  dueTone,
  formatTime,
  recurrenceLabel,
  reminderLabel,
} from "./ui";
import type { W } from "./workspaceContext";

export function TaskRow({
  task,
  inGroup,
  w,
}: {
  task: Task;
  inGroup?: string;
  w: W;
}) {
  const {
    companion,
    phone,
    projects,
    view,
    today,
    flat,
    openId,
    selected,
    setSelected,
    menu,
    setPicker,
    finishing,
    hovered,
    openDetail,
    toggle,
    goToProject,
    openMenuAt,
    rowHandlers,
  } = w;
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
            <Repeat2 size={12} aria-label={recurrenceLabel[task.recurrence]} />
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
      data-id={task.id}
      tabIndex={
        selected === task.id || (!selected && flat[0]?.id === task.id) ? 0 : -1
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
        onClick={(e) => openMenuAt(e, taskMenu(task, w), task.title, task.id)}
      >
        <MoreHorizontal size={18} />
      </button>
    </div>
  );
}
