// Small shared pieces: date wording and colours, the priority flag, and a popover that turns into a
// bottom sheet on narrow screens.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRightToLine,
  Calendar,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Clock,
  Flag,
  Repeat2,
  Sofa,
  Sunrise,
} from "lucide-react";
import { localDate, type Task } from "./api";
import { isoDate, nextWeekDate, parseQuick, weekendDate, type Recurrence } from "./parse";

export const priorityNames: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Normal",
};
export const reminderChoices: [number, string][] = [
  [0, "At due time"],
  [5, "5 minutes before"],
  [10, "10 minutes before"],
  [15, "15 minutes before"],
  [30, "30 minutes before"],
  [60, "1 hour before"],
  [1440, "1 day before"],
];
export const reminderLabel = (m: number | null) =>
  m === null
    ? "No reminder"
    : reminderChoices.find(([v]) => v === m)?.[1] || `${m} minutes before`;
export const recurrenceLabel: Record<string, string> = {
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
};

export const daysFromNow = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDate(d);
};
const at12 = (value: string) => new Date(value + "T12:00:00");
export const weekday = (value: string, style: "short" | "long" = "short") =>
  at12(value).toLocaleDateString(undefined, { weekday: style });

/** How a due date reads in a list: Today, Tomorrow, Friday (this week), Nov 12, Nov 12 2027. */
export function dueLabel(date: string | null, time?: string | null) {
  if (!date) return "";
  const today = localDate();
  const diff = Math.round((at12(date).getTime() - at12(today).getTime()) / 86400000);
  let text: string;
  if (diff === 0) text = "Today";
  else if (diff === 1) text = "Tomorrow";
  else if (diff === -1) text = "Yesterday";
  else if (diff > 1 && diff < 7) text = weekday(date, "long");
  else
    text = at12(date).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(at12(date).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
    });
  return time ? `${text} ${formatTime(time)}` : text;
}
export function formatTime(time: string) {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
/** Colour family for a due date, as Todoist does: overdue red, today green, tomorrow orange, this week purple. */
export function dueTone(date: string | null, completed = false) {
  if (!date || completed) return "";
  const today = localDate();
  if (date < today) return "tone-red";
  if (date === today) return "tone-green";
  if (date === daysFromNow(1)) return "tone-orange";
  if (date <= daysFromNow(6)) return "tone-purple";
  return "tone-muted";
}
export const isOverdue = (t: Pick<Task, "due_date" | "completed">) =>
  !!t.due_date && !t.completed && t.due_date < localDate();

export function PriorityFlag({ priority, size = 16 }: { priority: number; size?: number }) {
  return (
    <Flag
      size={size}
      className={`flag-${priority}`}
      fill={priority < 4 ? "currentColor" : "none"}
    />
  );
}

/* ---------- popover ---------- */

const NARROW = "(max-width: 520px)";
/**
 * A floating panel next to an anchor rectangle, kept on screen. On narrow screens and touch it is a
 * bottom sheet instead. Closes on Escape and on a press outside it.
 */
export function Popover({
  anchor,
  close,
  label,
  children,
  width = 280,
  sheet: forceSheet,
}: {
  anchor: DOMRect | { x: number; y: number };
  close: () => void;
  label: string;
  children: React.ReactNode;
  width?: number;
  sheet?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const sheet = forceSheet ?? matchMedia(NARROW).matches;
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    if (sheet || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    const a =
      "width" in anchor
        ? anchor
        : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    let left = Math.min(a.left, innerWidth - box.width - 8);
    left = Math.max(8, left);
    let top = a.bottom + 6;
    if (top + box.height > innerHeight - 8) top = Math.max(8, a.top - box.height - 6);
    setPos({ left, top });
  }, [anchor, sheet]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const outside = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!ref.current?.contains(target) && !target.closest?.(".context-menu, .menu-sheet"))
        closeRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".context-menu, .menu-sheet")) {
        e.stopPropagation();
        e.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      previous?.focus?.({ preventScroll: true });
    };
  }, []);
  const body = (
    <div
      ref={ref}
      className={`popover gl-glass${sheet ? " is-sheet" : ""}`}
      role="dialog"
      aria-label={label}
      style={
        sheet
          ? undefined
          : { width, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }
      }
    >
      {children}
    </div>
  );
  return sheet ? (
    <div className="popover-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      {body}
    </div>
  ) : (
    body
  );
}

/* ---------- date picker ---------- */

export type Due = { due_date: string | null; due_time: string | null; recurrence: string | null };
export function DatePicker({
  value,
  change,
  close,
  anchor,
}: {
  value: Due;
  change: (next: Due) => void;
  close: () => void;
  anchor: DOMRect | { x: number; y: number };
}) {
  const today = localDate();
  const [month, setMonth] = useState(() => {
    const d = at12(value.due_date || today);
    return new Date(d.getFullYear(), d.getMonth(), 1, 12);
  });
  const [typed, setTyped] = useState("");
  const typedResult = typed.trim()
    ? parseQuick("x " + typed, {})
    : null;
  const typedDue =
    typedResult && typedResult.tokens.length && typedResult.title === "x"
      ? typedResult
      : null;
  const now = new Date();
  const pick = (due_date: string | null) => {
    change(
      due_date
        ? { ...value, due_date }
        : { due_date: null, due_time: null, recurrence: null },
    );
    close();
  };
  const quick: [string | null, string, React.ReactNode, string][] = [
    [today, "Today", <Calendar size={18} />, "tone-green"],
    [daysFromNow(1), "Tomorrow", <Sunrise size={18} />, "tone-orange"],
    [isoDate(weekendDate(now)), "This weekend", <Sofa size={18} />, "tone-blue"],
    [isoDate(nextWeekDate(now)), "Next week", <ArrowRightToLine size={18} />, "tone-purple"],
    [null, "No date", <CircleSlash size={18} />, "tone-muted"],
  ];
  const seen = new Set<string | null>();
  const first = new Date(month);
  const lead = first.getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array(lead).fill(null),
    ...Array.from({ length: days }, (_, i) =>
      isoDate(new Date(month.getFullYear(), month.getMonth(), i + 1, 12)),
    ),
  ];
  return (
    <Popover anchor={anchor} close={close} label="Due date" width={300}>
      <div className="date-picker">
        <input
          className="date-typed"
          autoFocus={!matchMedia("(pointer: coarse)").matches}
          placeholder="Type a date, e.g. next fri 3pm"
          aria-label="Type a date"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typedDue) {
              e.preventDefault();
              change({
                due_date: typedDue.due_date,
                due_time: typedDue.due_time ?? value.due_time,
                recurrence: typedDue.recurrence ?? value.recurrence,
              });
              close();
            }
          }}
        />
        {typed.trim() && (
          <p className="date-typed-result">
            {typedDue
              ? [
                  dueLabel(typedDue.due_date, typedDue.due_time),
                  typedDue.recurrence && recurrenceLabel[typedDue.recurrence],
                ]
                  .filter(Boolean)
                  .join(" · ") + " · press Enter"
              : "Not a date I know"}
          </p>
        )}
        <div className="date-quick">
          {quick
            .filter(([d]) => (seen.has(d) ? false : (seen.add(d), true)))
            .map(([d, label, icon, tone]) => (
              <button
                key={label}
                type="button"
                className={value.due_date === d ? "is-selected" : ""}
                onClick={() => pick(d)}
              >
                <span className={tone}>{icon}</span>
                <span>{label}</span>
                <small>{d ? weekday(d) : ""}</small>
              </button>
            ))}
        </div>
        <div className="date-month">
          <div className="date-month-head">
            <strong>
              {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </strong>
            <button
              type="button"
              className="icon-button"
              aria-label="Previous month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1, 12))}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Next month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1, 12))}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="date-grid" role="grid">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <span key={"h" + i} className="date-dow">
                {d}
              </span>
            ))}
            {cells.map((d, i) =>
              d ? (
                <button
                  key={d}
                  type="button"
                  aria-label={at12(d).toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  })}
                  className={`date-day${d === today ? " is-today" : ""}${d === value.due_date ? " is-selected" : ""}${d < today ? " is-past" : ""}`}
                  onClick={() => pick(d)}
                >
                  {Number(d.slice(8))}
                </button>
              ) : (
                <span key={"e" + i} />
              ),
            )}
          </div>
        </div>
        <div className="date-extra">
          <label>
            <Clock size={15} />
            <input
              type="time"
              aria-label="Due time"
              value={value.due_time || ""}
              disabled={!value.due_date}
              onChange={(e) => change({ ...value, due_time: e.target.value || null })}
            />
          </label>
          <label>
            <Repeat2 size={15} />
            <select
              aria-label="Repeat"
              value={value.recurrence || ""}
              disabled={!value.due_date}
              onChange={(e) =>
                change({ ...value, recurrence: (e.target.value || null) as Recurrence | null })
              }
            >
              <option value="">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
          </label>
        </div>
      </div>
    </Popover>
  );
}

/** A textarea that grows with its content. */
export function AutoText(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number },
) {
  const { minRows = 1, ...rest } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [props.value]);
  return <textarea ref={ref} rows={minRows} {...rest} />;
}
