"""Calendar dates and wall times stay in the task's IANA time zone."""

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def zone_name(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ValueError("Use a valid IANA time zone, such as America/New_York") from error
    return value


def due_instant(day, clock, zone):
    if not day or not clock:
        return None
    wall = datetime.combine(day, time.fromisoformat(clock))
    local = wall.replace(tzinfo=ZoneInfo(zone), fold=0)
    # Reject spring-forward gaps. For fall-back ambiguity, use the first occurrence.
    if local.astimezone(timezone.utc).astimezone(local.tzinfo).replace(tzinfo=None) != wall:
        raise ValueError("This time does not exist on that date in this time zone")
    return local.astimezone(timezone.utc).replace(tzinfo=None)


def reminder_instant(task):
    if task.reminder_minutes is None or task.completed:
        return None
    try:
        due = due_instant(task.due_date, task.due_time, task.time_zone)
        return due - timedelta(minutes=task.reminder_minutes) if due else None
    except (ValueError, OverflowError, LookupError, TypeError):
        # A removed time zone or an extreme date must only cost this task its reminder, never everyone else's.
        return None


def recurrence_clock(day, clock, zone):
    """Shift a recurring time forward by the DST gap while preserving minutes."""
    if not clock:
        return None
    wall = datetime.combine(day, time.fromisoformat(clock)).replace(tzinfo=ZoneInfo(zone), fold=0)
    shifted = wall.astimezone(timezone.utc).astimezone(wall.tzinfo)
    return shifted.strftime("%H:%M")
