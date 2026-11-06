"""Personal Command app contract (westley-app docs/app-contract.md): the manifest, references, and the
required API (resolve, search, references, events). The shell and other apps use only these to show,
link, embed and search tasks and projects."""

import asyncio
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from . import events
from .auth import authenticate
from .config import settings
from .db import Project, Task, get_db
from .search import SearchError, iso, parse_params, search_docs

APP_ID = "tasks"
VERSION = "0.2.0"
_REF = re.compile(r"^pc://([a-z][a-z0-9-]{0,31})/([a-z][a-z0-9-]{0,31})/([A-Za-z0-9._~%-]{1,384})$")
_ID = re.compile(r"^[A-Za-z0-9._~-]{1,128}$")

router = APIRouter(tags=["Personal Command"])
api = APIRouter(prefix="/api/v1", tags=["Personal Command"])


def base():
    return settings.base_path


def task_ref(task_id):
    return f"pc://{APP_ID}/task/{task_id}"


def project_ref(project_id):
    return f"pc://{APP_ID}/project/{project_id}"


def parse_ref(ref):
    """(app, type, id) for a pc:// reference, or None."""
    match = _REF.match(ref or "")
    if not match:
        return None
    ident = unquote(match.group(3))
    return (match.group(1), match.group(2), ident) if _ID.match(ident) else None


@router.get("/manifest.json", include_in_schema=False)
def manifest(user=Depends(authenticate)):
    b = base()
    return JSONResponse(
        {
            "contract": 1,
            "id": APP_ID,
            "name": "Tasks",
            "icon": f"{b}/icon.svg",
            "version": VERSION,
            "api": f"{b}/api/v1",
            "openapi": f"{b}/openapi.json",
            "entities": [
                {"type": "task", "label": "Task", "embed": "tasks-task"},
                {"type": "project", "label": "Project", "embed": "tasks-project"},
            ],
            "embedModule": f"{b}/embed.js",
            "panes": [
                {"id": "today", "label": "Today", "url": f"{b}/#/today"},
                {"id": "inbox", "label": "Inbox", "url": f"{b}/#/inbox"},
                {"id": "upcoming", "label": "Upcoming", "url": f"{b}/#/upcoming"},
                {"id": "all", "label": "All tasks", "url": f"{b}/#/all"},
                {"id": "completed", "label": "Completed", "url": f"{b}/#/completed"},
            ],
            "commands": [
                {"id": "new-task", "label": "New task", "shortcut": "Mod+Shift+T"},
                {"id": "search-tasks", "label": "Search tasks"},
                {"id": "reminders", "label": "Task reminders"},
                {"id": "settings", "label": "Tasks settings"},
            ],
            # Local replica and outbox in the app, client ids, version checks, and a service worker
            # that keeps these files (app-contract.md, section 9).
            "offline": {"precache": [f"{b}/", f"{b}/companion.html", f"{b}/embed.js"]},
            # docs/companion.md in westley-app: the compact view kept beside the workspace.
            "companion": {
                "url": f"{b}/companion.html#today",
                "label": "Tasks",
                "minWidth": 260,
                "defaultWidth": 320,
                "quickAdd": "new-task",
                "badge": f"{b}/api/v1/companion/badge",
            },
        },
        headers={"Cache-Control": "no-cache"},
    )


def due_text(task):
    if not task.due_date:
        return None
    text = "Due " + task.due_date.strftime("%b ") + str(task.due_date.day)
    return text + (" " + task.due_time if task.due_time else "")


def task_summary(task, project_name=None):
    parts = ["Done" if task.completed else due_text(task), project_name or ("Inbox" if not task.project_id else None)]
    return {
        "ref": task_ref(task.id),
        "type": "task",
        "title": task.title,
        "subtitle": " · ".join(p for p in parts if p) or None,
        "icon": None,
        "url": f"{base()}/#/task/{task.id}",
        "updated": iso(task.updated_at),
        "version": task.version,
    }


def project_summary(project, open_count):
    return {
        "ref": project_ref(project.id),
        "type": "project",
        "title": project.name,
        "subtitle": f"{open_count} open task{'' if open_count == 1 else 's'}",
        "icon": None,
        "url": f"{base()}/#/project/{project.id}",
        "updated": iso(project.created_at),
        "version": None,
    }


def open_counts(db, user):
    counts = {}
    for project_id in db.scalars(select(Task.project_id).where(Task.user_id == user.id, Task.completed.is_(False))):
        counts[project_id] = counts.get(project_id, 0) + 1
    return counts


def project_names(db, user):
    return dict(db.execute(select(Project.id, Project.name).where(Project.user_id == user.id)).all())


@api.get("/resolve")
def resolve(ref: str = Query(max_length=500), user=Depends(authenticate), db: Session = Depends(get_db)):
    """A summary of one task or project, for link previews and fallbacks."""
    parsed = parse_ref(ref)
    if not parsed or parsed[0] != APP_ID:
        raise HTTPException(404, "Resource not found")
    _, kind, ident = parsed
    if kind == "task":
        task = db.scalar(select(Task).where(Task.id == ident, Task.user_id == user.id))
        if task:
            project = db.get(Project, task.project_id) if task.project_id else None
            return task_summary(task, project.name if project else None)
    if kind == "project":
        project = db.scalar(select(Project).where(Project.id == ident, Project.user_id == user.id))
        if project:
            return project_summary(project, open_counts(db, user).get(project.id, 0))
    raise HTTPException(404, "Resource not found")


def task_body(task):
    lines = [task.description or ""]
    lines += [item.get("title", "") for item in task.checklist or [] if isinstance(item, dict)]
    lines += task.labels or []
    return "\n".join(line for line in lines if line)


@api.get("/search")
def search(
    q: str | None = None,
    types: str | None = None,
    limit: str | None = None,
    cursor: str | None = None,
    updated_after: str | None = None,
    user=Depends(authenticate),
    db: Session = Depends(get_db),
):
    """The shared search contract (docs/search.md): tasks by title, description, checklist and labels;
    projects by name."""
    try:
        params = parse_params(q, types, limit, cursor, updated_after)
    except SearchError as error:
        return JSONResponse({"error": str(error)}, 422)
    names = project_names(db, user)
    docs = []
    if params.types is None or "task" in params.types:
        for task in db.scalars(select(Task).where(Task.user_id == user.id)):
            summary = task_summary(task, names.get(task.project_id))
            docs.append({**summary, "updated": task.updated_at, "body": task_body(task)})
    if params.types is None or "project" in params.types:
        counts = open_counts(db, user)
        for project in db.scalars(select(Project).where(Project.user_id == user.id)):
            summary = project_summary(project, counts.get(project.id, 0))
            docs.append({**summary, "updated": project.created_at, "body": ""})
    return search_docs(docs, params)


@api.get("/references")
def references(target: str = Query(max_length=500), user=Depends(authenticate), db: Session = Depends(get_db)):
    """Tasks whose description links to or embeds the target ([[type:id]], ![[type:id]] or the full ref)."""
    parsed = parse_ref(target)
    if not parsed:
        return {"items": []}
    _, kind, ident = parsed
    short = f"[[{kind}:{ident}"
    pattern = re.compile(
        re.escape(target) + r"(?![A-Za-z0-9._~%-])|!?\[\[" + re.escape(f"{kind}:{ident}") + r"(\|[^\]\n]*)?\]\]"
    )
    query = select(Task).where(
        Task.user_id == user.id,
        or_(Task.description.contains(short, autoescape=True), Task.description.contains(target, autoescape=True)),
    )
    names = project_names(db, user)
    items = [
        task_summary(task, names.get(task.project_id))
        for task in db.scalars(query.order_by(Task.updated_at.desc()).limit(200))
        if pattern.search(task.description or "") and task_ref(task.id) != target
    ]
    return {"items": items}


def local_today(zone):
    try:
        return datetime.now(ZoneInfo(zone or "UTC")).date()
    except (ZoneInfoNotFoundError, ValueError):
        return datetime.now(timezone.utc).date()


@api.get("/companion/badge")
def companion_badge(user=Depends(authenticate), db: Session = Depends(get_db)):
    """The count on the companion's collapsed strip: open tasks due today or overdue, in each task's zone."""
    query = select(Task.due_date, Task.time_zone).where(
        Task.user_id == user.id, Task.completed.is_(False), Task.due_date.is_not(None)
    )
    count = sum(1 for due, zone in db.execute(query) if due <= local_today(zone))
    label = f"{count} due today" if count else ""
    return JSONResponse({"count": count, "label": label}, headers={"Cache-Control": "no-store"})


@api.get("/events")
async def stream_events(request: Request, user=Depends(authenticate), db: Session = Depends(get_db)):
    """Server-sent events { ref, kind: updated|deleted, version } for this user's tasks and projects."""
    user_id = user.id
    db.close()  # Don't hold a database connection for the life of the stream.
    entry = events.subscribe(user_id)

    async def stream():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    data = await asyncio.wait_for(entry[1].get(), timeout=25)
                    yield f"data: {data}\n\n"
                except TimeoutError:
                    if await request.is_disconnected():
                        break
                    yield ": ping\n\n"
        finally:
            events.unsubscribe(user_id, entry)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
    )
