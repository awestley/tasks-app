"""Conservative, deterministic English quick entry. Unrecognized text stays in the title."""

import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from pydantic import Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import authenticate
from .db import Project, get_db
from .scheduling import zone_name
from .schemas import Model

router = APIRouter(prefix="/api/v1", tags=["Quick entry"])


class ParseInput(Model):
    text: str = Field(min_length=1, max_length=500)
    time_zone: str = Field(default="UTC", max_length=100)
    _zone = field_validator("time_zone")(zone_name)


class ParsedTask(Model):
    title: str
    due_date: date | None = None
    due_time: str | None = None
    time_zone: str
    reminder_minutes: int | None = None
    recurrence: str | None = None
    priority: int | None = None
    labels: list[str] = Field(default_factory=list)
    project_id: str | None = None
    recognized: list[str] = Field(default_factory=list)


WEEKDAYS = [
    ["monday", "mon"],
    ["tuesday", "tues", "tue"],
    ["wednesday", "wed"],
    ["thursday", "thurs", "thur", "thu"],
    ["friday", "fri"],
    ["saturday"],
    ["sunday"],
]
WEEKDAY = "|".join(name for names in WEEKDAYS for name in names)
MONTHS = [
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
]
MONTH = "|".join(MONTHS)
TIMES = {"morning": "09:00", "afternoon": "15:00", "evening": "19:00", "noon": "12:00", "midnight": "00:00"}


def weekday_index(word):
    return next(i for i, names in enumerate(WEEKDAYS) if word.lower() in names)


def month_index(word):
    return next(i for i, pattern in enumerate(MONTHS) if re.fullmatch(pattern, word, re.I))


def add_months(day, months):
    month = day.month - 1 + months
    year, month = day.year + month // 12, month % 12 + 1
    last = (date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(day.day, last))


def parse_task(text, zone, projects=(), instant=None):
    """The same rules as web/src/parse.ts; both run tests/quick_add_cases.json."""
    current = instant or datetime.now(ZoneInfo(zone))
    current = current.astimezone(ZoneInfo(zone))
    today = current.date()
    result = ParsedTask(title=text, time_zone=zone)
    masked = text
    spans = []

    def take(pattern, flags=re.I):
        nonlocal masked
        for match in re.finditer(pattern, masked, flags):
            start, end = match.start(), match.end()
            while start < end and masked[start].isspace():
                start += 1
            while end > start and masked[end - 1].isspace():
                end -= 1
            masked = masked[:start] + " " * (end - start) + masked[end:]
            spans.append((start, end))
            result.recognized.append(text[start:end])
            return match
        return None

    def untake():
        spans.pop()
        result.recognized.pop()

    due = None
    recurring_day = None
    # "every friday" wins over a bare "weekly" elsewhere in the text ("Write weekly review every friday").
    match = take(rf"\b(?:every|ev)\s+(day|week|month|{WEEKDAY})\b") or take(r"\b(daily|weekly|monthly)\b")
    if match:
        word = match[1].lower()
        if word in ("day", "daily"):
            result.recurrence = "daily"
        elif word in ("month", "monthly"):
            result.recurrence = "monthly"
        else:
            result.recurrence = "weekly"
            if word not in ("week", "weekly"):
                recurring_day = weekday_index(word)
    match = take(r"(?<!\S)p([1-4])(?!\S)")
    if match:
        result.priority = int(match[1])
    for project in sorted(projects, key=lambda p: len(p.name), reverse=True):
        if take(r"(?<!\S)#" + re.escape(project.name) + r"(?!\w)"):
            result.project_id = project.id
            break
    while match := take(r"(?<!\S)@([\w-]{1,40})(?![\w-])", 0):
        if match[1].lower() not in result.labels:
            result.labels.append(match[1].lower())

    # Dates. Explicit ISO dates count only if valid; invalid text stays in the title.
    match = re.search(r"\b\d{4}-\d{2}-\d{2}\b", masked)
    if match:
        try:
            due = date.fromisoformat(match[0])
            take(r"\b" + match[0] + r"\b")
        except ValueError:
            pass
    if due is None:
        match = take(r"\b(day after tomorrow|tomorrow|tmrw|tmr|today|tod|tonight|yesterday)\b")
        if match:
            word = match[1].lower()
            due = today + timedelta(
                days=2 if word == "day after tomorrow" else 1 if word in ("tomorrow", "tmrw", "tmr") else -1 if word == "yesterday" else 0
            )
            if word == "tonight":
                result.due_time = "19:00"
    if due is None:
        match = take(r"\bin (\d{1,3}) (days?|weeks?|months?)\b")
        if match:
            n, unit = int(match[1]), match[2].lower()
            due = add_months(today, n) if unit.startswith("month") else today + timedelta(days=n * (7 if unit.startswith("week") else 1))
    if due is None:
        match = take(r"\b(next week|next month|next weekend|this weekend|weekend)\b")
        if match:
            word = match[1].lower()
            if word == "next week":
                due = today + timedelta(days=7 - today.weekday())
            elif word == "next month":
                due = add_months(today.replace(day=1), 1)
            else:
                due = today + timedelta(days=(0 if today.weekday() == 6 else 5 - today.weekday()) + (7 if word == "next weekend" else 0))
    if due is None:
        match = take(rf"\b(?:on\s+)?({MONTH})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(\d{{4}}))?\b")
        parts = (match[1], match[2], match[3]) if match else None
        if not match:
            match = take(rf"\b(?:on\s+)?(\d{{1,2}})(?:st|nd|rd|th)?\s+({MONTH})\b(?:,?\s+(\d{{4}})\b)?")
            parts = (match[2], match[1], match[3]) if match else None
        if parts:
            month, day, year = month_index(parts[0]) + 1, int(parts[1]), int(parts[2] or 0)
            try:
                found = date(year or today.year, month, day)
                if not year and found < today:
                    found = date(found.year + 1, month, day)
                due = found
            except ValueError:
                untake()  # "Feb 31" is not a date; the words stay in the title.
    if due is None:
        match = take(rf"\b(?:on\s+)?(next\s+)?({WEEKDAY})\b")
        if match:
            target = weekday_index(match[2])
            days = 7 - today.weekday() + target if match[1] else (target - today.weekday()) % 7
            due = today + timedelta(days=days)

    # Times
    if not result.due_time and due is None:
        match = take(r"\bin (\d{1,3}) ?(hours?|hrs?|minutes?|mins?)\b")
        if match:
            at = current + timedelta(minutes=int(match[1]) * (60 if match[2].lower().startswith("h") else 1))
            due, result.due_time = at.date(), at.strftime("%H:%M")
    if not result.due_time:
        match = take(r"\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b")
        if match:
            hour = int(match[1]) % 12 + (12 if match[3].lower() == "pm" else 0)
            result.due_time = f"{hour:02}:{int(match[2] or 0):02}"
    if not result.due_time:
        match = take(r"\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b")
        if match:
            result.due_time = f"{int(match[1]):02}:{match[2]}"
    if not result.due_time:
        match = take(r"\b(?:at\s+|in the\s+|this\s+)?(morning|afternoon|evening|noon|midnight)\b")
        if match:
            result.due_time = TIMES[match[1].lower()]

    # A reminder needs a time to count from; without one the words stay in the title.
    reminder = None
    if result.due_time:
        match = take(r"(?<!\S)!(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?)\s*(?:b|before)(?!\w)") or take(
            r"\bremind(?: me)?\s+(\d{1,4})\s+(minutes?|hours?)\s+before\b"
        )
        if match:
            reminder = int(match[1]) * (60 if match[2].lower().startswith("h") else 1)
            if reminder > 10080:
                reminder = None
                untake()

    if recurring_day is not None and due is None:
        due = today + timedelta(days=(recurring_day - today.weekday()) % 7)
    if result.due_time and due is None:
        due = today if result.due_time > current.strftime("%H:%M") else today + timedelta(days=1)
    if result.recurrence and due is None:
        due = today
    result.due_date = due
    if result.due_time:
        result.reminder_minutes = reminder if reminder is not None else 0

    title, at = "", 0
    for start, end in sorted(spans):
        title += text[at:start] + " "
        at = end
    title = re.sub(r"\s+", " ", title + text[at:]).strip(" ,")
    if not title or len(result.labels) > 20:
        return ParsedTask(title=text, time_zone=zone)
    result.title = title
    return result


@router.post("/tasks/parse", response_model=ParsedTask)
def preview(data: ParseInput, user=Depends(authenticate), db: Session = Depends(get_db)):
    projects = db.scalars(select(Project).where(Project.user_id == user.id)).all()
    return parse_task(data.text, data.time_zone, projects)
