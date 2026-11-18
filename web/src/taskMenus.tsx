// The menus for a task. The same entries appear on right-click, long-press and the row's ⋯ button.
import {
  AlarmClockOff,
  ArrowRightToLine,
  Bell,
  Calendar,
  CheckCircle2,
  CircleSlash,
  CopyPlus,
  Ellipsis,
  ExternalLink,
  FolderInput,
  Inbox,
  Link,
  ListTree,
  Pencil,
  Sofa,
  Sunrise,
  Trash2,
} from "lucide-react";
import type { MenuEntry } from "./ContextMenu";
import { api, type Task } from "./api";
import { isoDate, nextWeekDate, weekendDate } from "./parse";
import { refreshSoon } from "./store";
import { taskLink } from "./routes";
import {
  daysFromNow,
  priorityNames,
  PriorityFlag,
  reminderChoices,
  weekday,
} from "./ui";
import type { W } from "./workspaceContext";

export function dateOptions(task: Task, w: W) {
  const { today, menu, setPicker, schedule } = w;
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
}

export function moveMenu(task: Task, w: W): MenuEntry[] {
  const { patch, projects } = w;
  return [
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
}

export function priorityMenu(task: Task, w: W): MenuEntry[] {
  const { setPriority } = w;
  return [1, 2, 3, 4].map((p) => ({
    label: priorityNames[p],
    icon: <PriorityFlag priority={p} />,
    checked: task.priority === p,
    action: () => setPriority(task, p),
  }));
}

/** 09:00 tomorrow in this device's time zone, as ISO 8601 with its offset. */
function tomorrowMorning() {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${isoDate(at)}T09:00:00${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** Notifies every enabled device again later. Needs the server, so it is not queued offline. */
function snooze(
  task: Task,
  w: W,
  change: { minutes?: number; until?: string },
) {
  api(`/tasks/${encodeURIComponent(task.id)}/snooze`, "POST", change)
    .then(() => {
      w.setToast({ id: Date.now(), text: "Snoozed" });
      refreshSoon(0);
    })
    .catch((e: Error) =>
      w.setToast({ id: Date.now(), text: e.message, error: true }),
    );
}

export function taskMenu(task: Task, w: W): MenuEntry[] {
  const {
    companion,
    hosted,
    openDetail,
    openInColumn,
    toggle,
    setPriority,
    patch,
    duplicate,
    copy,
    removeTask,
    goToProject,
  } = w;
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
    { row: "Date", shortcut: "T", options: dateOptions(task, w) },
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
    ...(!task.completed
      ? [
          {
            label: "Snooze",
            icon: <AlarmClockOff size={16} />,
            items: [
              {
                label: "15 minutes",
                action: () => snooze(task, w, { minutes: 15 }),
              },
              {
                label: "1 hour",
                action: () => snooze(task, w, { minutes: 60 }),
              },
              {
                label: "3 hours",
                action: () => snooze(task, w, { minutes: 180 }),
              },
              {
                label: "Tomorrow 09:00",
                action: () => snooze(task, w, { until: tomorrowMorning() }),
              },
            ],
          } as MenuEntry,
        ]
      : []),
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
      items: moveMenu(task, w),
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
