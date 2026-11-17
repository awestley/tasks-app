#!/usr/bin/env python3
"""Copy open Todoist projects and tasks into Tasks.

Usage:
  python3 scripts/import_todoist.py            # dry run: show what would be created
  python3 scripts/import_todoist.py --apply    # create projects and tasks

The Todoist token comes from TODOIST_TOKEN or ~/.todoist_token (a bare token or a TODOIST_TOKEN=... line).
It is never printed. Tasks are signed in through the local workspace, or TASKS_TOKEN for another server.

Each imported Todoist ID is recorded in ~/.config/tasks/todoist-import.json, so running again skips
everything already copied and only adds what is new.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TODOIST_URL = os.environ.get("TODOIST_API_URL", "https://api.todoist.com/api/v1")
TASKS_URL = os.environ.get("TASKS_API_URL", "http://127.0.0.1:8000")
TOKEN_FILE = Path.home() / ".todoist_token"
STATE_FILE = Path(
    os.environ.get(
        "TODOIST_IMPORT_STATE", Path.home() / ".config/tasks/todoist-import.json"
    )
)

# Todoist's named project colors.
COLORS = {
    "berry_red": "#b8256f",
    "red": "#db4035",
    "orange": "#ff9933",
    "yellow": "#fad000",
    "olive_green": "#afb83b",
    "lime_green": "#7ecc49",
    "green": "#299438",
    "mint_green": "#6accbc",
    "teal": "#158fad",
    "sky_blue": "#14aaf5",
    "light_blue": "#96c3eb",
    "blue": "#4073ff",
    "grape": "#884dff",
    "violet": "#af38eb",
    "lavender": "#eb96eb",
    "magenta": "#e05194",
    "salmon": "#ff8d85",
    "charcoal": "#808080",
    "grey": "#b8b8b8",
    "taupe": "#ccac93",
}
WEEKDAYS = r"\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b"
MONTHS = r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b"
UTC_ZONE = timezone.utc  # noqa: UP017 (datetime.UTC needs Python 3.11; macOS ships 3.9)
TITLE_LIMIT, DESCRIPTION_LIMIT, LABEL_LIMIT, CHECKLIST_LIMIT = 500, 10000, 20, 100


class Failure(Exception):
    pass


def request(method, url, token, body=None, form=False):
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    data = None
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        raise Failure(
            f"{method} {urllib.parse.urlsplit(url).path} returned {error.code}: {detail}"
        ) from None
    except urllib.error.URLError as error:
        raise Failure(
            f"Could not reach {urllib.parse.urlsplit(url).netloc}: {error.reason}"
        ) from None


def todoist_token():
    token = os.environ.get("TODOIST_TOKEN", "").strip()
    if not token and TOKEN_FILE.exists():
        for line in TOKEN_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                token = (
                    line.split("=", 1)[1].strip()
                    if line.startswith("TODOIST_TOKEN=")
                    else line
                )
                break
    if not token:
        raise Failure(f"Set TODOIST_TOKEN or put the token in {TOKEN_FILE}")
    return token.strip("'\"")


def fetch_todoist(token):
    """One full sync returns every open item, comment and reminder in a single request."""
    kinds = ["projects", "sections", "items", "notes", "reminders"]
    data = request(
        "POST",
        TODOIST_URL + "/sync",
        token,
        {"sync_token": "*", "resource_types": json.dumps(kinds)},
        form=True,
    )
    return {
        kind: [x for x in data.get(kind) or [] if not x.get("is_deleted")]
        for kind in kinds
    }


def local_zone():
    target = os.path.realpath("/etc/localtime")
    return target.split("zoneinfo/", 1)[1] if "zoneinfo/" in target else "UTC"


def parse_due(due, default_zone):
    """Returns (date, "HH:MM" or None, zone name)."""
    raw = due["date"]
    zone = due.get("timezone") or default_zone
    if "T" not in raw:
        return date.fromisoformat(raw[:10]), None, zone
    if raw.endswith("Z"):
        moment = (
            datetime.fromisoformat(raw[:-1])
            .replace(tzinfo=UTC_ZONE)
            .astimezone(ZoneInfo(zone))
        )
    else:
        moment = datetime.fromisoformat(raw[:19])
    return moment.date(), moment.strftime("%H:%M"), zone


def recurrence(text):
    """Maps a Todoist repeat phrase to daily, weekly or monthly. Returns (value, exact)."""
    s = (text or "").lower().strip()
    if s.startswith("every!"):
        s = "every " + s[6:].strip()
    plain = re.sub(r"\b(at|from|until|starting|ending)\b.*$", "", s).strip()
    # Intervals such as "every 2 weeks" or "every other day" cannot be expressed exactly.
    exact = (
        not re.search(r"every\s+(other|\d+)\b", plain)
        and "," not in plain
        and " and " not in plain
    )
    if re.search(r"\b(years?|annual)", plain) or re.search(MONTHS, plain):
        return None, False
    if re.search(r"\b(months?|monthly)\b", plain) or re.search(
        r"\b\d+(st|nd|rd|th)\b|\blast day\b", plain
    ):
        # "every 3rd friday" repeats monthly here, but on the date rather than the weekday.
        return "monthly", exact and not re.search(WEEKDAYS, plain)
    if re.search(r"\bweekday|workday", plain):
        return "daily", False
    if re.search(r"\b(weeks?|weekly)\b", plain) or re.search(WEEKDAYS, plain):
        return "weekly", exact
    if re.search(
        r"\b(days?|daily)\b|\bhours?\b|^every (morning|evening|night|afternoon)", plain
    ):
        return "daily", exact and "hour" not in plain
    return None, False


def priority(value):
    # Todoist reports 4 as urgent and 1 as normal. Here 1 is urgent and 4 is none.
    return 5 - int(value or 1)


def label_name(text):
    return text.strip().lower()[:40]


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def tasks_token():
    token = os.environ.get("TASKS_TOKEN", "").strip()
    if token:
        return token
    # Local workspace sign-in for development servers; it answers only requests from this computer.
    req = urllib.request.Request(
        TASKS_URL + "/auth/dev/native", data=b"", method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read())["access_token"]
    except urllib.error.HTTPError as error:
        raise Failure(
            f"Local sign-in at {TASKS_URL} returned {error.code}. Start the server with DEV_LOGIN=true, "
            "or set TASKS_TOKEN to an integration token."
        ) from None
    except urllib.error.URLError as error:
        raise Failure(
            f"Could not reach {TASKS_URL}: {error.reason}. Is the server running?"
        ) from None


def build_plan(data, sections_as_labels, default_zone):
    notes = []
    projects = [p for p in data["projects"] if not p.get("is_archived")]
    open_project_ids = {p["id"] for p in projects}
    sections = {
        s["id"]: s["name"] for s in data["sections"] if not s.get("is_archived")
    }
    comments = {}
    for note in sorted(data["notes"], key=lambda n: n.get("posted_at") or ""):
        comments.setdefault(note["item_id"], []).append(note)
    reminders = {}
    for reminder in data["reminders"]:
        reminders.setdefault(reminder.get("item_id"), []).append(reminder)

    items = [
        i
        for i in data["items"]
        if not i.get("checked") and i.get("project_id") in open_project_ids
    ]
    by_id = {i["id"]: i for i in items}
    children = {}
    for item in sorted(items, key=lambda i: i.get("child_order") or 0):
        if item.get("parent_id") in by_id:
            children.setdefault(item["parent_id"], []).append(item)

    def descendants(item_id):
        for child in children.get(item_id, []):
            yield child
            yield from descendants(child["id"])

    planned_projects = []
    for project in sorted(
        projects, key=lambda p: (not p.get("inbox_project"), p.get("child_order") or 0)
    ):
        if project.get("inbox_project"):
            continue
        name = project["name"][:100]
        planned_projects.append(
            {
                "todoist_id": project["id"],
                "name": name,
                "color": COLORS.get(project.get("color"), "#808080"),
            }
        )
        if project.get("parent_id") in open_project_ids:
            notes.append(
                f"Project '{name}' was nested in Todoist and becomes a top-level project."
            )
    project_names = {p["id"]: p["name"] for p in projects}
    inbox_ids = {p["id"] for p in projects if p.get("inbox_project")}

    planned_tasks = []
    top_level = [i for i in items if i.get("parent_id") not in by_id]
    for item in sorted(
        top_level, key=lambda i: (i["project_id"], i.get("child_order") or 0)
    ):
        title = item["content"].strip() or "Untitled"
        where = f"'{title[:60]}'"
        description = (item.get("description") or "").strip()
        task = {
            "title": title[:TITLE_LIMIT],
            "priority": priority(item.get("priority")),
            "labels": [label_name(x) for x in item.get("labels") or [] if x.strip()],
            "checklist": [],
        }
        if len(title) > TITLE_LIMIT:
            notes.append(f"{where}: title shortened to {TITLE_LIMIT} characters.")
        section = sections.get(item.get("section_id"))
        if section and sections_as_labels:
            task["labels"].insert(0, label_name(section))

        due = item.get("due")
        if due and due.get("date"):
            day, clock, zone = parse_due(due, default_zone)
            task.update(due_date=day.isoformat(), time_zone=zone)
            if clock:
                task["due_time"] = clock
            if due.get("is_recurring"):
                repeat, exact = recurrence(due.get("string"))
                if repeat:
                    task["recurrence"] = repeat
                if not exact:
                    kept = f"repeats {repeat}" if repeat else "does not repeat here"
                    notes.append(
                        f"{where}: Todoist repeat '{due.get('string')}' {kept}."
                    )
                    description += f"\n\nRepeated in Todoist: {due.get('string')}"
        if item.get("deadline"):
            description += f"\n\nDeadline in Todoist: {item['deadline'].get('date')}"

        offsets = []
        for reminder in reminders.get(item["id"], []):
            if (
                reminder.get("type") == "relative"
                and reminder.get("minute_offset") is not None
            ):
                offsets.append(int(reminder["minute_offset"]))
            elif (
                reminder.get("type") == "absolute"
                and task.get("due_time")
                and (reminder.get("due") or {}).get("date")
            ):
                at_day, at_clock, _ = parse_due(reminder["due"], task["time_zone"])
                due_at = datetime.fromisoformat(
                    f"{task['due_date']}T{task['due_time']}"
                )
                at = datetime.fromisoformat(
                    f"{at_day.isoformat()}T{at_clock or '00:00'}"
                )
                minutes = int((due_at - at).total_seconds() // 60)
                if minutes >= 0:
                    offsets.append(minutes)
                else:
                    notes.append(f"{where}: a reminder after the due time was skipped.")
            else:
                notes.append(
                    f"{where}: a {reminder.get('type', 'unknown')} reminder was skipped."
                )
        offsets = [m for m in offsets if 0 <= m <= 10080]
        if offsets and task.get("due_time"):
            task["reminder_minutes"] = max(offsets)
            if len(offsets) > 1:
                notes.append(
                    f"{where}: kept the earliest-firing of {len(offsets)} reminders."
                )
        elif offsets:
            notes.append(f"{where}: reminder skipped because the task has no due time.")

        for child in descendants(item["id"]):
            text = child["content"].strip() or "Untitled"
            task["checklist"].append({"title": text[:TITLE_LIMIT]})
            lost = [k for k in ("due", "description", "labels") if child.get(k)]
            if lost or comments.get(child["id"]):
                notes.append(
                    f"{where}: subtask '{text[:40]}' became a checklist item without its {', '.join(lost) or 'comments'}."
                )
        if len(task["checklist"]) > CHECKLIST_LIMIT:
            notes.append(
                f"{where}: only the first {CHECKLIST_LIMIT} of {len(task['checklist'])} subtasks were kept."
            )
            task["checklist"] = task["checklist"][:CHECKLIST_LIMIT]

        for note in comments.get(item["id"], []):
            stamp = (note.get("posted_at") or "")[:10]
            body = (note.get("content") or "").strip()
            attachment = note.get("file_attachment") or {}
            if attachment.get("file_url"):
                body += f"\n{attachment.get('file_name') or 'Attachment'}: {attachment['file_url']}"
            if body:
                description += f"\n\nComment {stamp}:\n{body}"

        labels = list(dict.fromkeys(task["labels"]))
        if len(labels) > LABEL_LIMIT:
            notes.append(f"{where}: only the first {LABEL_LIMIT} labels were kept.")
        task["labels"] = labels[:LABEL_LIMIT]
        description = description.strip()
        if len(description) > DESCRIPTION_LIMIT:
            notes.append(
                f"{where}: description and comments shortened to {DESCRIPTION_LIMIT} characters."
            )
            description = description[: DESCRIPTION_LIMIT - 1] + "…"
        task["description"] = description
        planned_tasks.append(
            {
                "todoist_id": item["id"],
                "project": None
                if item["project_id"] in inbox_ids
                else item["project_id"],
                "project_name": "Inbox"
                if item["project_id"] in inbox_ids
                else project_names[item["project_id"]],
                "task": task,
            }
        )
    return planned_projects, planned_tasks, notes


def show(planned_projects, planned_tasks, notes, state):
    new_projects = [
        p for p in planned_projects if p["todoist_id"] not in state.get("projects", {})
    ]
    new_tasks = [
        t for t in planned_tasks if t["todoist_id"] not in state.get("tasks", {})
    ]
    print(f"Projects: {len(planned_projects)} found, {len(new_projects)} to create")
    print(f"Tasks: {len(planned_tasks)} found, {len(new_tasks)} to create")
    current = None
    for entry in sorted(new_tasks, key=lambda t: t["project_name"] != "Inbox"):
        if entry["project_name"] != current:
            current = entry["project_name"]
            print(f"\n{current}")
        task = entry["task"]
        bits = []
        if task.get("due_date"):
            bits.append(
                task["due_date"]
                + (" " + task["due_time"] if task.get("due_time") else "")
            )
        if task.get("recurrence"):
            bits.append(task["recurrence"])
        if task["priority"] < 4:
            bits.append(f"p{task['priority']}")
        if task["labels"]:
            bits.append(", ".join("@" + x for x in task["labels"]))
        if task["checklist"]:
            bits.append(f"{len(task['checklist'])} checklist items")
        print(f"  - {task['title']}" + (f"  ({'; '.join(bits)})" if bits else ""))
    if notes:
        print(f"\nCheck these ({len(notes)}):")
        for note in notes:
            print("  - " + note)


def apply(planned_projects, planned_tasks, state):
    token = tasks_token()
    key = TASKS_URL.rstrip("/")
    server = state.setdefault(key, {"projects": {}, "tasks": {}})
    existing = {
        p["name"].lower(): p["id"]
        for p in request("GET", TASKS_URL + "/api/v1/projects", token)
    }
    made_projects = made_tasks = 0
    for project in planned_projects:
        if project["todoist_id"] in server["projects"]:
            continue
        local_id = existing.get(project["name"].lower())
        if not local_id:
            body = {"name": project["name"], "color": project["color"]}
            local_id = request("POST", TASKS_URL + "/api/v1/projects", token, body)[
                "id"
            ]
            made_projects += 1
        server["projects"][project["todoist_id"]] = local_id
        save_state(state)
    failures = []
    for entry in planned_tasks:
        if entry["todoist_id"] in server["tasks"]:
            continue
        body = dict(entry["task"])
        body["project_id"] = (
            server["projects"].get(entry["project"]) if entry["project"] else None
        )
        try:
            created = request("POST", TASKS_URL + "/api/v1/tasks", token, body)
        except Failure as error:
            failures.append(f"'{body['title'][:60]}': {error}")
            continue
        server["tasks"][entry["todoist_id"]] = created["id"]
        made_tasks += 1
        save_state(state)
    print(f"\nCreated {made_projects} projects and {made_tasks} tasks on {key}.")
    if failures:
        print(f"{len(failures)} tasks were not created:")
        for failure in failures:
            print("  - " + failure)
        return 1
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Copy open Todoist projects and tasks into Tasks."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="create the projects and tasks (default is a dry run)",
    )
    parser.add_argument(
        "--drop-sections",
        action="store_true",
        help="ignore Todoist sections instead of adding them as labels",
    )
    parser.add_argument(
        "--time-zone",
        default=local_zone(),
        help="zone for Todoist dates that have none (default: this Mac's)",
    )
    args = parser.parse_args()
    try:
        ZoneInfo(args.time_zone)
        data = fetch_todoist(todoist_token())
        planned_projects, planned_tasks, notes = build_plan(
            data, not args.drop_sections, args.time_zone
        )
        state = load_state()
        show(
            planned_projects, planned_tasks, notes, state.get(TASKS_URL.rstrip("/"), {})
        )
        if not args.apply:
            print("\nDry run. Nothing was created. Run again with --apply to import.")
            return 0
        return apply(planned_projects, planned_tasks, state)
    except Failure as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
