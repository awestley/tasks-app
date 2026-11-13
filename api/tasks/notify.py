"""What a notification says and how the system should treat it. Transport lives in push.py."""

from dataclasses import dataclass, field
from datetime import timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .db import Project, Task
from .scheduling import local_today, safe_due

RELEVANCE = {1: 1.0, 2: 0.75, 3: 0.5, 4: 0.25}
TASK_KINDS = ("reminder", "snooze", "overdue")


@dataclass
class Message:
    kind: str
    title: str
    body: str
    subtitle: str = ""
    task_id: str | None = None
    thread: str = "inbox"
    category: str = ""
    level: str = "active"
    relevance: float = 0.5
    badge: int | None = None
    collapse: str = ""
    url: str = "/"
    sync: list[str] = field(default_factory=list)


def day_label(day, today):
    if day == today:
        return ""
    if day == today + timedelta(days=1):
        return "tomorrow "
    if day == today - timedelta(days=1):
        return "yesterday "
    if timedelta(0) < day - today < timedelta(days=7):
        return day.strftime("%a ")
    return day.strftime("%b ") + str(day.day) + " "


def timing(task, kind, instant):
    """Short factual text such as "Due 15:00", "Due now" or "Overdue since Mon 15:00"."""
    due = safe_due(task)
    if due is None:
        return "Snoozed" if kind == "snooze" else "Reminder"
    zone = ZoneInfo(task.time_zone)
    local_due = due.replace(tzinfo=timezone.utc).astimezone(zone)
    today = local_today(instant, task.time_zone)
    when = day_label(local_due.date(), today) + local_due.strftime("%H:%M")
    if due > instant:
        return "Due " + when
    if instant - due < timedelta(minutes=5):
        return "Due now"
    return "Overdue since " + when


def open_counts(db, user_id, instant, zone=None):
    """(due today, overdue) among open tasks, each judged in its own time zone unless one is given."""
    horizon = instant.date() + timedelta(days=1)
    rows = db.execute(
        select(Task.due_date, Task.time_zone).where(
            Task.user_id == user_id, Task.completed.is_(False), Task.due_date.is_not(None), Task.due_date <= horizon
        )
    ).all()
    today_count = overdue_count = 0
    for due_date, task_zone in rows:
        today = local_today(instant, zone or task_zone)
        if due_date == today:
            today_count += 1
        elif due_date < today:
            overdue_count += 1
    return today_count, overdue_count


def level_for(task, preferences):
    threshold = preferences.time_sensitive_priority if preferences else 1
    return "time-sensitive" if threshold and task.priority <= threshold else "active"


def task_message(db, task, kind, preferences, instant):
    project = db.get(Project, task.project_id) if task.project_id else None
    today, overdue = open_counts(db, task.user_id, instant)
    relevance = RELEVANCE.get(task.priority, 0.25)
    if kind == "overdue":
        relevance = min(1.0, relevance + 0.2)
    return Message(
        kind=kind,
        # Limit payload size. Never include notes, checklist text or credentials.
        title=task.title[:160],
        subtitle=project.name[:100] if project else "",
        body=timing(task, kind, instant),
        task_id=task.id,
        thread=task.project_id or "inbox",
        category="TASK_REMINDER",
        level=level_for(task, preferences),
        relevance=relevance,
        badge=today + overdue,
        collapse="task-" + task.id,
        url="/?task=" + task.id,
    )


def summary_message(db, user_id, preferences, instant):
    """None when nothing is due today or overdue, so an empty summary is never sent."""
    today, overdue = open_counts(db, user_id, instant, preferences.summary_zone)
    parts = ([f"{today} due today"] if today else []) + ([f"{overdue} overdue"] if overdue else [])
    if not parts:
        return None
    return Message(
        kind="summary",
        title="Today",
        body=", ".join(parts),
        thread="summary",
        category="TASK_SUMMARY",
        level="passive",
        relevance=0.5,
        badge=today + overdue,
        collapse="summary",
        url="/?view=today",
    )


def sync_message(task_id):
    return Message(kind="sync", title="", body="", task_id=task_id, sync=[task_id])
