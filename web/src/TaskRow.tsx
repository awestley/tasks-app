import React from "react";
import {
  CalendarDays,
  Check,
  ListChecks,
  MoreHorizontal,
  Repeat2,
  Tag,
} from "lucide-react";
import { dateLabel, type Project, type Task } from "./api";

export function TaskRow({
  task,
  project,
  today,
  busy,
  menuOpen,
  pressProps,
  setHovered,
  toggle,
  edit,
  goToProject,
  openMenu,
}: {
  task: Task;
  project?: Project;
  today: string;
  busy: boolean;
  menuOpen: boolean;
  pressProps: React.HTMLAttributes<HTMLDivElement>;
  setHovered: (id: string | null) => void;
  toggle: (task: Task) => void;
  edit: (task: Task) => void;
  goToProject: (task: Task) => void;
  openMenu: (box: DOMRect) => void;
}) {
  return (
    <div
      className={`task-row ${task.completed ? "is-complete" : ""} ${menuOpen ? "menu-target" : ""}`}
      onMouseEnter={() => setHovered(task.id)}
      onMouseLeave={() => setHovered(null)}
      onFocus={() => setHovered(task.id)}
      {...pressProps}
    >
      <button
        className={`check-task priority-${task.priority}`}
        aria-label={`${task.completed ? "Restore" : "Complete"} ${task.title}`}
        disabled={busy}
        onClick={() => toggle(task)}
      >
        {task.completed && <Check size={13} />}
      </button>
      <button className="task-body" onClick={() => edit(task)}>
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
      <button className="task-project" onClick={() => goToProject(task)}>
        {project?.name || "Inbox"}
        <span
          style={{
            color: project?.color || "var(--text-muted)",
          }}
        >
          #
        </span>
      </button>
      <button
        className="icon-button row-menu"
        aria-label={`More actions for ${task.title}`}
        aria-haspopup="menu"
        onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect())}
      >
        <MoreHorizontal size={18} />
      </button>
    </div>
  );
}
