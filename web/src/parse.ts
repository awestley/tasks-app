// Quick add parsing, in the browser, so details highlight as you type and capture works offline.
// Mirrors api/tasks/quick_add.py; both run the cases in api/tests/quick_add_cases.json.
// Unrecognized text stays in the title. A token the user dismissed (its "kind:text" key in
// `ignore`) also stays in the title.

export type TokenKind =
  | "date"
  | "time"
  | "recurrence"
  | "priority"
  | "project"
  | "label"
  | "reminder";
export type Token = {
  kind: TokenKind;
  start: number;
  end: number;
  text: string;
};
export type Recurrence = "daily" | "weekly" | "monthly";
export type Parsed = {
  title: string;
  due_date: string | null;
  due_time: string | null;
  recurrence: Recurrence | null;
  priority: number | null;
  project_id: string | null;
  labels: string[];
  /** Only an explicit reminder ("!30m before"). Tasks with a time also get the automatic one. */
  reminder_minutes: number | null;
  tokens: Token[];
};
type ProjectRef = { id: string; name: string };
type Options = { projects?: ProjectRef[]; now?: Date; ignore?: Set<string> };

export const tokenKey = (t: Pick<Token, "kind" | "text">) =>
  `${t.kind}:${t.text.toLowerCase()}`;

const WEEKDAYS = [
  ["monday", "mon"],
  ["tuesday", "tues", "tue"],
  ["wednesday", "wed"],
  ["thursday", "thurs", "thur", "thu"],
  ["friday", "fri"],
  ["saturday"],
  ["sunday"],
];
const WEEKDAY = WEEKDAYS.flat().join("|");
const MONTHS = [
  "jan(?:uary)?",
  "feb(?:ruary)?",
  "mar(?:ch)?",
  "apr(?:il)?",
  "may",
  "june?",
  "july?",
  "aug(?:ust)?",
  "sep(?:t(?:ember)?)?",
  "oct(?:ober)?",
  "nov(?:ember)?",
  "dec(?:ember)?",
];
const MONTH = MONTHS.join("|");
const weekdayIndex = (word: string) =>
  WEEKDAYS.findIndex((names) => names.includes(word.toLowerCase()));
const monthIndex = (word: string) =>
  MONTHS.findIndex((m) => new RegExp(`^(?:${m})$`, "i").test(word));

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, days: number) => {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12);
  return next;
};
const addMonths = (d: Date, months: number) => {
  const first = new Date(d.getFullYear(), d.getMonth() + months, 1, 12);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  first.setDate(Math.min(d.getDate(), last));
  return first;
};
/** Monday = 0 ... Sunday = 6, like Python's weekday(). */
const mondayIndex = (d: Date) => (d.getDay() + 6) % 7;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The Saturday this weekend (today on a weekend day), or a week later for "next weekend". */
export function weekendDate(now: Date, next = false) {
  const day = mondayIndex(now);
  return addDays(now, (day === 6 ? 0 : 5 - day) + (next ? 7 : 0));
}
/** Monday of next week. */
export const nextWeekDate = (now: Date) => addDays(now, 7 - mondayIndex(now));

export function parseQuick(text: string, options: Options = {}): Parsed {
  const now = options.now || new Date();
  const ignore = options.ignore || new Set<string>();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const empty: Parsed = {
    title: text,
    due_date: null,
    due_time: null,
    recurrence: null,
    priority: null,
    project_id: null,
    labels: [],
    reminder_minutes: null,
    tokens: [],
  };
  const result: Parsed = { ...empty, labels: [], tokens: [] };
  let masked = text;
  let due: Date | null = null;

  // Find a match in the text not yet used, record it as a token and blank it out.
  function take(pattern: RegExp, kind: TokenKind): RegExpExecArray | null {
    for (;;) {
      const match = pattern.exec(masked);
      if (!match) return null;
      let start = match.index,
        end = start + match[0].length;
      while (start < end && /\s/.test(masked[start])) start++;
      while (end > start && /\s/.test(masked[end - 1])) end--;
      const word = text.slice(start, end);
      const blank = (ch: string) =>
        masked.slice(0, start) + ch.repeat(end - start) + masked.slice(end);
      if (ignore.has(tokenKey({ kind, text: word }))) {
        masked = blank("\u0001"); // stays in the title, and is not matched again
        continue;
      }
      masked = blank(" ");
      result.tokens.push({ kind, start, end, text: word });
      return match;
    }
  }

  let match: RegExpExecArray | null;
  let recurringDay: number | null = null;
  // "every friday" wins over a bare "weekly" elsewhere in the text ("Write weekly review every friday").
  match =
    take(
      new RegExp(`\\b(?:every|ev)\\s+(day|week|month|${WEEKDAY})\\b`, "i"),
      "recurrence",
    ) || take(/\b(daily|weekly|monthly)\b/i, "recurrence");
  if (match) {
    const word = match[1].toLowerCase();
    if (word === "day" || word === "daily") result.recurrence = "daily";
    else if (word === "month" || word === "monthly")
      result.recurrence = "monthly";
    else {
      result.recurrence = "weekly";
      if (word !== "week" && word !== "weekly")
        recurringDay = weekdayIndex(word);
    }
  }
  match = take(/(?<!\S)p([1-4])(?!\S)/i, "priority");
  if (match) result.priority = Number(match[1]);
  const projects = [...(options.projects || [])].sort(
    (a, b) => b.name.length - a.name.length,
  );
  for (const project of projects) {
    if (
      take(
        new RegExp(`(?<!\\S)#${escape(project.name)}(?![\\p{L}\\p{N}_])`, "iu"),
        "project",
      )
    ) {
      result.project_id = project.id;
      break;
    }
  }
  while (
    (match = take(/(?<!\S)@([\p{L}\p{N}_-]{1,40})(?![\p{L}\p{N}_-])/u, "label"))
  ) {
    const label = match[1].toLowerCase();
    if (!result.labels.includes(label)) result.labels.push(label);
  }

  // Dates
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(masked);
  if (iso) {
    const d = new Date(+iso[1], +iso[2] - 1, +iso[3], 12);
    if (d.getMonth() === +iso[2] - 1 && d.getDate() === +iso[3]) {
      take(new RegExp(`\\b${iso[0]}\\b`), "date");
      due = d;
    }
  }
  if (!due) {
    match = take(
      /\b(day after tomorrow|tomorrow|tmrw|tmr|today|tod|tonight|yesterday)\b/i,
      "date",
    );
    if (match) {
      const word = match[1].toLowerCase();
      due = addDays(
        today,
        word === "day after tomorrow"
          ? 2
          : ["tomorrow", "tmrw", "tmr"].includes(word)
            ? 1
            : word === "yesterday"
              ? -1
              : 0,
      );
      if (word === "tonight") result.due_time = "19:00";
    }
  }
  if (!due) {
    match = take(/\bin (\d{1,3}) (days?|weeks?|months?)\b/i, "date");
    if (match) {
      const n = Number(match[1]),
        unit = match[2].toLowerCase();
      due = unit.startsWith("month")
        ? addMonths(today, n)
        : addDays(today, n * (unit.startsWith("week") ? 7 : 1));
    }
  }
  if (!due) {
    match = take(
      /\b(next week|next month|next weekend|this weekend|weekend)\b/i,
      "date",
    );
    if (match) {
      const word = match[1].toLowerCase();
      due =
        word === "next week"
          ? nextWeekDate(today)
          : word === "next month"
            ? new Date(today.getFullYear(), today.getMonth() + 1, 1, 12)
            : weekendDate(today, word === "next weekend");
    }
  }
  if (!due) {
    match =
      take(
        new RegExp(
          `\\b(?:on\\s+)?(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
          "i",
        ),
        "date",
      ) || null;
    let month = -1,
      day = 0,
      year = 0;
    if (match) {
      month = monthIndex(match[1]);
      day = Number(match[2]);
      year = Number(match[3] || 0);
    } else {
      match = take(
        new RegExp(
          `\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})\\b(?:,?\\s+(\\d{4})\\b)?`,
          "i",
        ),
        "date",
      );
      if (match) {
        month = monthIndex(match[2]);
        day = Number(match[1]);
        year = Number(match[3] || 0);
      }
    }
    if (match && month >= 0) {
      let d = new Date(year || today.getFullYear(), month, day, 12);
      if (d.getMonth() !== month) {
        // "Feb 31": not a date. Give the text back.
        result.tokens.pop();
      } else {
        if (!year && d < today)
          d = new Date(d.getFullYear() + 1, month, day, 12);
        due = d;
      }
    }
  }
  if (!due) {
    match = take(
      new RegExp(`\\b(?:on\\s+)?(next\\s+)?(${WEEKDAY})\\b`, "i"),
      "date",
    );
    if (match) {
      const target = weekdayIndex(match[2]);
      const current = mondayIndex(today);
      const days = match[1] ? 7 - current + target : (target - current + 7) % 7;
      due = addDays(today, days);
    }
  }

  // Times
  if (!result.due_time) {
    match = !due
      ? take(/\bin (\d{1,3}) ?(hours?|hrs?|minutes?|mins?)\b/i, "time")
      : null;
    if (match) {
      const minutes =
        Number(match[1]) * (match[2].toLowerCase().startsWith("h") ? 60 : 1);
      const at = new Date(now.getTime() + minutes * 60000);
      due = new Date(at.getFullYear(), at.getMonth(), at.getDate(), 12);
      result.due_time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    }
  }
  if (!result.due_time) {
    match = take(
      /\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i,
      "time",
    );
    if (match) {
      const hour =
        (Number(match[1]) % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
      result.due_time = `${pad(hour)}:${pad(Number(match[2] || 0))}`;
    }
  }
  if (!result.due_time) {
    match = take(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/i, "time");
    if (match) result.due_time = `${pad(Number(match[1]))}:${match[2]}`;
  }
  if (!result.due_time) {
    match = take(
      /\b(?:at\s+|in the\s+|this\s+)?(morning|afternoon|evening|noon|midnight)\b/i,
      "time",
    );
    if (match)
      result.due_time = (
        {
          morning: "09:00",
          afternoon: "15:00",
          evening: "19:00",
          noon: "12:00",
          midnight: "00:00",
        } as Record<string, string>
      )[match[1].toLowerCase()];
  }

  // A reminder needs a time to count from; without one the words stay in the title.
  if (result.due_time) {
    match =
      take(
        /(?<!\S)!(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?)\s*(?:b|before)(?![\p{L}\p{N}_])/iu,
        "reminder",
      ) ||
      take(
        /\bremind(?: me)?\s+(\d{1,4})\s+(minutes?|hours?)\s+before\b/i,
        "reminder",
      );
    if (match) {
      const minutes =
        Number(match[1]) * (match[2].toLowerCase().startsWith("h") ? 60 : 1);
      if (minutes <= 10080) result.reminder_minutes = minutes;
      else result.tokens.pop();
    }
  }

  if (recurringDay !== null && !due)
    due = addDays(today, (recurringDay - mondayIndex(today) + 7) % 7);
  if (result.due_time && !due) {
    const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    due = result.due_time > clock ? today : addDays(today, 1);
  }
  if (result.recurrence && !due) due = today;
  result.due_date = due ? isoDate(due) : null;

  const spans = [...result.tokens].sort((a, b) => a.start - b.start);
  let title = "",
    at = 0;
  for (const span of spans) {
    title += text.slice(at, span.start) + " ";
    at = span.end;
  }
  title = (title + text.slice(at))
    .replace(/\s+/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "");
  if (!title || result.labels.length > 20) return empty;
  result.title = title;
  result.tokens = spans;
  return result;
}

/** The text with every token of these kinds removed, for when a picker replaces what was typed. */
export function stripTokens(text: string, tokens: Token[], kinds: TokenKind[]) {
  let out = "",
    at = 0;
  for (const t of tokens) {
    if (!kinds.includes(t.kind)) continue;
    out += text.slice(at, t.start);
    at = t.end;
  }
  return (out + text.slice(at)).replace(/\s{2,}/g, " ").replace(/^\s+/, "");
}
