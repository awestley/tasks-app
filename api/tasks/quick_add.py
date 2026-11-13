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


def parse_task(text, zone, projects=(), instant=None):
    current = instant or datetime.now(ZoneInfo(zone))
    current = current.astimezone(ZoneInfo(zone))
    today = current.date()
    result = ParsedTask(title=text, time_zone=zone)
    remaining = text

    def take(pattern):
        nonlocal remaining
        match = re.search(pattern, remaining, re.I)
        if match:
            result.recognized.append(match.group().strip())
            remaining = remaining[: match.start()] + " " + remaining[match.end() :]
        return match

    match = take(r"\b(?:remind(?: me)?\s+)(\d{1,4})\s+(minutes?|hours?)\s+before\b")
    reminder = int(match[1]) * (60 if match[2].lower().startswith("hour") else 1) if match else None
    match = take(r"\b(?:every day|daily|every week|weekly|every month|monthly)\b")
    if match:
        value = match[0].lower()
        result.recurrence = (
            "daily" if value in ["daily", "every day"] else "weekly" if value in ["weekly", "every week"] else "monthly"
        )
    match = take(r"(?<!\S)p([1-4])(?!\S)")
    if match:
        result.priority = int(match[1])
    for project in sorted(projects, key=lambda p: len(p.name), reverse=True):
        if take(r"(?<!\S)#" + re.escape(project.name) + r"(?!\w)"):
            result.project_id = project.id
            break
    while match := take(r"(?<!\S)@([\w-]{1,40})(?!\w)"):
        if match[1].lower() not in result.labels:
            result.labels.append(match[1].lower())
    # Recognize explicit ISO dates only if valid; invalid text remains untouched.
    match = re.search(r"\b\d{4}-\d{2}-\d{2}\b", remaining)
    if match:
        try:
            result.due_date = date.fromisoformat(match[0])
            take(r"\b" + match[0] + r"\b")
        except ValueError:
            pass
    if result.due_date is None:
        match = take(r"\b(day after tomorrow|tomorrow|today|tonight)\b")
        if match:
            result.due_date = today + timedelta(days={"day after tomorrow": 2, "tomorrow": 1}.get(match[0].lower(), 0))
            if match[0].lower() == "tonight":
                result.due_time = "19:00"
        else:
            match = take(r"\bin (\d{1,3}) (days?|weeks?)\b")
            if match:
                result.due_date = today + timedelta(
                    days=int(match[1]) * (7 if match[2].lower().startswith("week") else 1)
                )
            else:
                weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
                match = take(r"\b(?:on\s+)?(next\s+)?(" + "|".join(weekdays) + r")\b")
                if match:
                    days = (weekdays.index(match[2].lower()) - today.weekday()) % 7
                    if match[1]:
                        days = 7 - today.weekday() + weekdays.index(match[2].lower())
                    result.due_date = today + timedelta(days=days)
    match = take(r"\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b")
    if match:
        hour = int(match[1]) % 12 + (12 if match[3].lower() == "pm" else 0)
        result.due_time = f"{hour:02}:{int(match[2] or 0):02}"
    else:
        match = take(r"\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b")
        if match:
            result.due_time = f"{int(match[1]):02}:{match[2]}"
        else:
            match = take(r"\b(?:at\s+|in the\s+)?(morning|afternoon|evening|noon|midnight)\b")
            if match:
                result.due_time = {
                    "morning": "09:00",
                    "afternoon": "15:00",
                    "evening": "19:00",
                    "noon": "12:00",
                    "midnight": "00:00",
                }[match[1].lower()]
    if result.due_time and not result.due_date:
        result.due_date = today if result.due_time > current.strftime("%H:%M") else today + timedelta(days=1)
    if result.recurrence and not result.due_date:
        result.due_date = today
    if reminder is not None and reminder > 10080:
        return ParsedTask(title=text, time_zone=zone)
    if result.due_time:
        result.reminder_minutes = reminder or 0
    title = re.sub(r"\s+", " ", remaining).strip(" ,")
    # Do not save an empty title or silently lose an unschedulable reminder phrase.
    if not title or (reminder is not None and not result.due_time) or len(result.labels) > 20:
        return ParsedTask(title=text, time_zone=zone)
    result.title = title
    return result


@router.post("/tasks/parse", response_model=ParsedTask)
def preview(data: ParseInput, user=Depends(authenticate), db: Session = Depends(get_db)):
    projects = db.scalars(select(Project).where(Project.user_id == user.id)).all()
    return parse_task(data.text, data.time_zone, projects)
