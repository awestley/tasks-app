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
  SquareCheck,
  Sunrise,
  Trash2,
  X,
} from "lucide-react";
import type { MenuEntry, MenuRow } from "./ContextMenu";
import { api, spaceNames, type Space, type Task } from "./api";
import { otherSpace, spaceIcons } from "./SpaceSwitch";
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

/** Date choices. `value` is undefined when several tasks have different dates. */
export function dateChoices(
  w: W,
  value: string | null | undefined,
  change: (due: string | null) => void,
  more: (anchor: { x: number; y: number }) => void,
) {
  const { today, menu } = w;
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
        selected: value === d,
        action: () => change(d),
      })),
    {
      label: "No date",
      icon: <CircleSlash size={20} />,
      selected: value !== undefined && !value,
      action: () => change(null),
    },
    {
      label: "More dates",
      icon: <Ellipsis size={20} />,
      action: () => more({ x: menu?.x ?? innerWidth / 2, y: menu?.y ?? 120 }),
    },
  ];
}

export function dateOptions(task: Task, w: W) {
  return dateChoices(
    w,
    task.due_date,
    (due) => w.schedule(task, due),
    (anchor) => w.setPicker({ task, anchor }),
  );
}

/**
 * Project choices in this space, then the other space's Inbox. `current` is undefined when several
 * tasks are in different projects.
 */
export function projectChoices(
  w: W,
  current: string | null | undefined,
  move: (projectId: string | null, name: string) => void,
  toSpace: (space: Space) => void,
): MenuEntry[] {
  const other = otherSpace(w.space);
  const OtherIcon = spaceIcons[other];
  return [
    {
      label: "Inbox",
      icon: <Inbox size={16} />,
      checked: current === null,
      action: () => move(null, "Inbox"),
    },
    ...w.projects.map((p) => ({
      label: p.name,
      icon: (
        <span className="project-hash" style={{ color: p.color }}>
          #
        </span>
      ),
      checked: current === p.id,
      action: () => move(p.id, p.name),
    })),
    "separator",
    {
      label: spaceNames[other],
      icon: <OtherIcon size={16} />,
      action: () => toSpace(other),
    },
  ];
}

/** Priority choices as a row of buttons. `value` is undefined when several tasks differ. */
export function priorityRow(
  value: number | undefined,
  change: (priority: number) => void,
): MenuRow {
  return {
    row: "Priority",
    shortcut: "1–4",
    options: [1, 2, 3, 4].map((p) => ({
      label: priorityNames[p],
      icon: <PriorityFlag priority={p} size={20} />,
      selected: value === p,
      action: () => change(p),
    })),
  };
}

export function moveMenu(task: Task, w: W): MenuEntry[] {
  return projectChoices(
    w,
    task.project_id,
    (project_id, name) => w.patch(task, { project_id }, `Moved to ${name}`),
    (space) =>
      w.patch(
        task,
        { space, project_id: null },
        `Moved to ${spaceNames[space]}`,
      ),
  );
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
    pickTask,
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
    {
      label: "Select",
      icon: <SquareCheck size={16} />,
      shortcut: "S",
      key: "s",
      action: () => pickTask(task),
    },
    "separator",
    { row: "Date", shortcut: "T", options: dateOptions(task, w) },
    priorityRow(task.priority, (p) => setPriority(task, p)),
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

/** A value every selected task shares, or undefined when they differ. */
export function shared<K extends keyof Task>(tasks: Task[], key: K) {
  return tasks.every((t) => t[key] === tasks[0]?.[key])
    ? tasks[0]?.[key]
    : undefined;
}

export const taskCount = (n: number) => (n === 1 ? "1 task" : `${n} tasks`);

/** Actions for every selected task: right-click on a selected row, or long-press on a phone. */
export function selectionMenu(w: W): MenuEntry[] {
  const { chosen, flat, bulk, pickAll, clearPicks } = w;
  const allDone = chosen.every((t) => t.completed);
  return [
    {
      label: allDone ? "Restore" : "Complete",
      icon: <CheckCircle2 size={16} />,
      shortcut: "C",
      key: "c",
      action: bulk.complete,
    },
    "separator",
    {
      row: "Date",
      shortcut: "T",
      options: dateChoices(
        w,
        shared(chosen, "due_date"),
        bulk.schedule,
        bulk.pickDate,
      ),
    },
    priorityRow(shared(chosen, "priority"), bulk.priority),
    "separator",
    {
      label: "Move to",
      icon: <FolderInput size={16} />,
      shortcut: "V",
      key: "v",
      items: projectChoices(
        w,
        shared(chosen, "project_id"),
        bulk.move,
        bulk.space,
      ),
    },
    ...(chosen.length < flat.length
      ? [
          {
            label: "Select all",
            icon: <SquareCheck size={16} />,
            shortcut: "⌘A",
            action: pickAll,
          },
        ]
      : []),
    {
      label: "Clear selection",
      icon: <X size={16} />,
      shortcut: "Esc",
      action: clearPicks,
    },
    "separator",
    {
      label: `Delete ${taskCount(chosen.length)}`,
      icon: <Trash2 size={16} />,
      danger: true,
      confirm: "Confirm delete",
      action: bulk.remove,
    },
  ];
}

/** The menu for a row: the selection's actions when the row is one of several selected tasks. */
export function rowMenu(task: Task, w: W) {
  return w.picked.has(task.id) && w.chosen.length > 1
    ? { entries: () => selectionMenu(w), title: `${w.chosen.length} tasks` }
    : { entries: () => taskMenu(task, w), title: task.title };
}
