import {
  ArrowRightToLine,
  AlarmClockOff,
  Bell,
  Calendar,
  CheckCircle2,
  CircleSlash,
  CopyPlus,
  Ellipsis,
  Flag,
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
import type { Project, Task } from "./api";
import {
  daysFromNow,
  priorityNames,
  reminderChoices,
  taskLink,
  tomorrowMorning,
  weekday,
} from "./tasks";

export type TaskMenuContext = {
  today: string;
  projects: Project[];
  edit: (task: Task) => void;
  goToProject: (task: Task) => void;
  toggle: (task: Task) => void;
  schedule: (task: Task, due: string | null) => void;
  setPriority: (task: Task, priority: number) => void;
  patch: (task: Task, changes: Partial<Task>, message: string) => void;
  snooze: (task: Task, change: { minutes?: number; until?: string }) => void;
  duplicate: (task: Task) => void;
  copy: (text: string, message: string) => void;
  remove: (task: Task) => void;
};

export function taskMenu(task: Task, context: TaskMenuContext): MenuEntry[] {
  const {
    today,
    projects,
    edit,
    goToProject,
    toggle,
    schedule,
    setPriority,
    patch,
    snooze,
    duplicate,
    copy,
    remove,
  } = context;
  const day = new Date().getDay(),
    tomorrow = daysFromNow(1),
    weekend = daysFromNow(day === 0 ? 0 : 6 - day),
    nextWeek = daysFromNow((8 - day) % 7 || 7);
  const dates: [string, string, React.ReactNode][] = [
    [
      today,
      `Today · ${weekday(today)}`,
      <span className="day-icon tone-green">
        <Calendar size={20} />
        <b>{new Date().getDate()}</b>
      </span>,
    ],
    [
      tomorrow,
      `Tomorrow · ${weekday(tomorrow)}`,
      <Sunrise size={20} className="tone-orange" />,
    ],
    [
      weekend,
      `This weekend · ${weekday(weekend)}`,
      <Sofa size={20} className="tone-blue" />,
    ],
    [
      nextWeek,
      `Next week · ${weekday(nextWeek)}`,
      <ArrowRightToLine size={20} className="tone-purple" />,
    ],
  ];
  return [
    {
      label: "Edit",
      icon: <Pencil size={16} />,
      shortcut: "E",
      key: "e",
      action: () => edit(task),
    },
    {
      label: "Go to project",
      icon: <ListTree size={16} />,
      shortcut: "G",
      key: "g",
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
    {
      row: "Date",
      options: [
        ...dates
          // Weekend can fall on today or tomorrow; keep one button per date.
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
          label: "Pick a date",
          icon: <Ellipsis size={20} />,
          date: {
            value: task.due_date,
            change: (value) => schedule(task, value),
          },
        },
      ],
    },
    {
      row: "Priority",
      shortcut: "1–4",
      options: [1, 2, 3, 4].map((p) => ({
        label: priorityNames[p],
        icon: (
          <Flag
            size={20}
            className={`flag-${p}`}
            fill={p < 4 ? "currentColor" : "none"}
          />
        ),
        selected: task.priority === p,
        action: () => setPriority(task, p),
      })),
    },
    "separator",
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
          },
        ]
      : []),
    ...(!task.completed
      ? [
          {
            label: "Snooze",
            icon: <AlarmClockOff size={16} />,
            items: [
              {
                label: "15 minutes",
                action: () => snooze(task, { minutes: 15 }),
              },
              { label: "1 hour", action: () => snooze(task, { minutes: 60 }) },
              {
                label: "3 hours",
                action: () => snooze(task, { minutes: 180 }),
              },
              {
                label: "Tomorrow 09:00",
                action: () => snooze(task, { until: tomorrowMorning() }),
              },
            ],
          },
        ]
      : []),
    {
      label: "Move to",
      icon: <FolderInput size={16} />,
      shortcut: "V",
      key: "v",
      items: [
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
      ],
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
      action: () => remove(task),
    },
  ];
}
