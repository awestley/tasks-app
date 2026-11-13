import type { Task } from "./api";
import { localDate } from "./api";

export type View =
  | "today"
  | "inbox"
  | "upcoming"
  | "all"
  | "completed"
  | `project:${string}`
  | `label:${string}`;
export type Draft = Pick<
  Task,
  | "title"
  | "description"
  | "project_id"
  | "due_date"
  | "due_time"
  | "time_zone"
  | "reminder_minutes"
  | "priority"
  | "labels"
  | "recurrence"
  | "checklist"
  | "alert_style"
>;
export const emptyDraft = (): Draft => ({
  title: "",
  description: "",
  project_id: null,
  due_date: null,
  due_time: null,
  time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  reminder_minutes: null,
  priority: 4,
  labels: [],
  checklist: [],
  recurrence: null,
  alert_style: "notification",
});
export const daysFromNow = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDate(d);
};
export const weekday = (value: string) =>
  new Date(value + "T12:00:00").toLocaleDateString(undefined, {
    weekday: "short",
  });
export const priorityNames: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Normal",
};
export const reminderChoices: [number, string][] = [
  [0, "At due time"],
  [5, "5 minutes before"],
  [15, "15 minutes before"],
  [30, "30 minutes before"],
  [60, "1 hour before"],
  [1440, "1 day before"],
];
/** 09:00 tomorrow on this device, as an ISO time with offset. */
export const tomorrowMorning = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};
/** The server stores UTC times without an offset. */
export const serverTime = (value: string) =>
  new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z");
export const taskLink = (task: Task) => `${location.origin}/?task=${task.id}`;
export const parseLabels = (text: string) =>
  text
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
