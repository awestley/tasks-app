import asyncio
import calendar
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import ValidationError
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.exc import DataError
from sqlalchemy.orm import Session

from . import events
from .auth import authenticate, issue, revoke_apple, session_only, trusted_origin
from .auth import router as auth_router
from .config import settings
from .contract import api as contract_api
from .contract import project_ref, task_ref
from .contract import router as contract_router
from .db import Credential, Project, SessionLocal, Task, get_db, now, uid
from .mcp_server import http_app, mcp
from .migrations import upgrade_local_database
from .push import router as push_router
from .quick_add import router as quick_router
from .reminders import run as background_work
from .scheduling import recurrence_clock
from .schemas import (
    Profile,
    ProjectCreate,
    ProjectOut,
    ProjectPatch,
    SessionOut,
    TaskCreate,
    TaskIn,
    TaskOut,
    TaskPatch,
    TaskRevision,
    TokenIn,
    TokenOut,
    Version,
)


@asynccontextmanager
async def lifespan(app):
    if not settings.production:
        upgrade_local_database()
    stop = asyncio.Event()
    worker = asyncio.create_task(background_work(stop))
    try:
        async with mcp.session_manager.run():
            yield
    finally:
        stop.set()
        await worker


app = FastAPI(
    title="Tasks API",
    version="0.1.0",
    lifespan=lifespan,
    description="Private task management. Authenticate with a revocable personal access token or a session.",
    # A personal server has no reason to publish its API. docs/openapi.json holds the same description.
    docs_url=None if settings.production else "/docs",
    redoc_url=None if settings.production else "/redoc",
    openapi_url=None if settings.production else "/openapi.json",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.public_url],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)
app.include_router(auth_router)
api = APIRouter(prefix="/api/v1", tags=["Workspace"])
rate_windows = defaultdict(deque)
MAX_BODY_BYTES = 100_000


class BodyLimit:
    """Enforce the size limit on received bytes, because chunked requests declare no Content-Length."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        too_large = JSONResponse({"detail": "Request too large"}, 413)
        declared = dict(scope["headers"]).get(b"content-length", b"0")
        if len(declared) > 8 or (declared.isdigit() and int(declared) > MAX_BODY_BYTES):
            await too_large(scope, receive, send)
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] != "http.request":
                return  # The client disconnected.
            body += message.get("body", b"")
            if len(body) > MAX_BODY_BYTES:
                await too_large(scope, receive, send)
                return
            if not message.get("more_body"):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay, send)


def client_address(request):
    """Behind a proxy every connection comes from the proxy, so use the address it reports."""
    if settings.client_ip_header:
        # A proxy appends what it saw, so only the last entry cannot be supplied by the client.
        reported = request.headers.get(settings.client_ip_header, "").split(",")[-1].strip()
        if reported:
            return reported
    return request.client.host if request.client else "unknown"


def route_path(request):
    """The path inside the app, without the base path the shell serves it under."""
    path, prefix = request.url.path, settings.base_path
    return path[len(prefix) :] if prefix and path.startswith(prefix + "/") else path


@app.middleware("http")
async def protect(request: Request, call_next):
    if settings.base_path and request.url.path == settings.base_path:
        return RedirectResponse(settings.base_path + "/", 308)
    path = route_path(request)
    # Only what could be a sign-in attempt counts. /auth/dev does not exist in production.
    if path.startswith("/auth/") and path not in {"/auth/config", "/auth/dev", "/auth/logout"}:
        instant = time.monotonic()
        key = client_address(request)
        if len(rate_windows) > 10000:
            rate_windows.clear()
        window = rate_windows[key]
        while window and window[0] < instant - 60:
            window.popleft()
        if len(window) >= 30:
            return JSONResponse(
                {"detail": "Too many sign-in attempts. Retry in a minute."}, 429, headers={"Retry-After": "60"}
            )
        window.append(instant)
    if path.startswith("/mcp"):
        if not request.headers.get("authorization", "").startswith("Bearer "):
            return JSONResponse({"detail": "Bearer token required"}, 401)
        if request.headers.get("origin") and not trusted_origin(request):
            return JSONResponse({"detail": "Invalid request origin"}, 403)
        with SessionLocal() as db:
            try:
                authenticate(request, db)
            except HTTPException as error:
                return JSONResponse({"detail": error.detail}, error.status_code)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    # Inside the shell, panes are same-origin frames; on its own the app can't be framed at all.
    frames = "'self'" if settings.shell_mode else "'none'"
    response.headers["X-Frame-Options"] = "SAMEORIGIN" if settings.shell_mode else "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
        f"frame-ancestors {frames}; form-action 'self' https://appleid.apple.com"
    )
    if path in {"/docs", "/redoc", "/docs/oauth2-redirect"}:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https://fastapi.tiangolo.com; connect-src 'self'; frame-ancestors 'none'"
        )
    if settings.production:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if path.startswith(("/api/", "/auth/")) and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    return response


class BasePath:
    """Serve the app under settings.base_path (e.g. /apps/tasks) as well as at the root. The platform keeps
    the prefix on the request; setting root_path lets routing ignore it and keeps generated URLs right."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        prefix = settings.base_path
        if prefix and scope["type"] in {"http", "websocket"} and scope["path"].startswith(prefix + "/"):
            scope = {**scope, "root_path": scope.get("root_path", "") + prefix}
        await self.app(scope, receive, send)


app.add_middleware(BasePath)


# Added last so it runs first, before any other middleware or handler reads the body.
app.add_middleware(BodyLimit)


@app.exception_handler(DataError)
def data_the_database_rejects(request: Request, error: DataError):
    # For example, PostgreSQL text cannot contain NUL characters, wherever they appear in a request.
    return JSONResponse({"detail": "The request contains text that cannot be stored."}, 422)


@app.get("/health", tags=["Operations"])
def health(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


def owned(db, model, resource_id, user):
    result = db.scalar(select(model).where(model.id == resource_id, model.user_id == user.id))
    if not result:
        raise HTTPException(404, "Resource not found")
    return result


@api.get("/me", response_model=Profile)
def me(user=Depends(authenticate)):
    return user


@api.delete("/me", status_code=204)
def delete_me(request: Request, user=Depends(authenticate), db: Session = Depends(get_db)):
    session_only(request)
    revoke_apple(user)
    db.delete(user)
    db.commit()
    response = Response(status_code=204)
    response.delete_cookie("tasks_session")
    return response


@api.get("/projects", response_model=list[ProjectOut])
def projects(user=Depends(authenticate), db: Session = Depends(get_db)):
    return db.scalars(select(Project).where(Project.user_id == user.id).order_by(Project.created_at)).all()


@api.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, user=Depends(authenticate), db: Session = Depends(get_db)):
    return owned(db, Project, project_id, user)


def existing(db, model, resource_id, user, response):
    """Replaying a create with a client-chosen id returns the item instead of failing (offline replay)."""
    found = db.get(model, resource_id)
    if found and found.user_id == user.id:
        response.status_code = 200
        return found
    if found:
        raise HTTPException(409, "This id is already in use")
    return None


@api.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(data: ProjectCreate, response: Response, user=Depends(authenticate), db: Session = Depends(get_db)):
    fields = data.model_dump(exclude={"id"})
    if data.id and (found := existing(db, Project, str(data.id), user, response)):
        return found
    project = Project(user_id=user.id, **fields, **({"id": str(data.id)} if data.id else {}))
    db.add(project)
    db.commit()
    events.publish(user.id, project_ref(project.id), "updated")
    return project


@api.patch("/projects/{project_id}", response_model=ProjectOut)
def edit_project(project_id: str, data: ProjectPatch, user=Depends(authenticate), db: Session = Depends(get_db)):
    project = owned(db, Project, project_id, user)
    for name, value in data.model_dump(exclude_unset=True).items():
        setattr(project, name, value)
    db.commit()
    events.publish(user.id, project_ref(project.id), "updated")
    return project


@api.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, user=Depends(authenticate), db: Session = Depends(get_db)):
    project = owned(db, Project, project_id, user)
    moved = db.execute(
        update(Task)
        .where(Task.project_id == project.id, Task.user_id == user.id)
        .values(project_id=None, version=Task.version + 1, updated_at=now())
        .returning(Task.id, Task.version)
    ).all()
    db.delete(project)
    db.commit()
    events.publish(user.id, project_ref(project_id), "deleted")
    for task_id, version in moved:
        events.publish(user.id, task_ref(task_id), "updated", version)


@api.get("/tasks/revision", response_model=TaskRevision)
def task_revision(user=Depends(authenticate), db: Session = Depends(get_db)):
    """Changes whenever a task is added, edited or deleted, so a client can skip downloading an unchanged list."""
    count, latest = db.execute(
        select(func.count(Task.id), func.max(Task.updated_at)).where(Task.user_id == user.id)
    ).one()
    return {"revision": f"{count}:{latest.isoformat() if latest else ''}"}


@api.get("/tasks", response_model=list[TaskOut])
def tasks(
    q: str = Query("", max_length=500),
    project_id: str | None = None,
    completed: bool | None = None,
    label: str | None = None,
    due_before: date | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
    user=Depends(authenticate),
    db: Session = Depends(get_db),
):
    query = select(Task).where(Task.user_id == user.id)
    if q:
        query = query.where(Task.title.icontains(q, autoescape=True) | Task.description.icontains(q, autoescape=True))
    if project_id:
        query = query.where(Task.project_id.is_(None) if project_id == "inbox" else Task.project_id == project_id)
    if completed is not None:
        query = query.where(Task.completed == completed)
    if due_before:
        query = query.where(Task.due_date <= due_before)
    query = query.order_by(Task.created_at, Task.id)
    if label:
        # Portable across SQLite development and PostgreSQL production. Labels are stored in lowercase.
        wanted = label.strip().lower()
        matches = [t for t in db.scalars(query) if wanted in t.labels]
        return matches[offset : offset + limit]
    return db.scalars(query.offset(offset).limit(limit)).all()


@api.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(task_id: str, user=Depends(authenticate), db: Session = Depends(get_db)):
    return owned(db, Task, task_id, user)


@api.post("/tasks", response_model=TaskOut, status_code=201)
def create_task(data: TaskCreate, response: Response, user=Depends(authenticate), db: Session = Depends(get_db)):
    if data.id and (found := existing(db, Task, str(data.id), user, response)):
        return found
    if data.project_id is not None:
        owned(db, Project, data.project_id, user)
    task = Task(user_id=user.id, **data.model_dump(exclude={"id"}), **({"id": str(data.id)} if data.id else {}))
    db.add(task)
    db.commit()
    events.publish(user.id, task_ref(task.id), "updated", task.version)
    return task


def next_date(value, recurrence, anchor_day=None):
    if recurrence == "daily":
        return value + timedelta(days=1)
    if recurrence == "weekly":
        return value + timedelta(days=7)
    month = value.month % 12 + 1
    year = value.year + (value.month == 12)
    return date(year, month, min(anchor_day or value.day, calendar.monthrange(year, month)[1]))


def mutate(db, user, task_id, data):
    task = owned(db, Task, task_id, user)
    changes = data.model_dump(exclude_unset=True)
    version = changes.pop("version")
    undo = changes.pop("undo", None)
    # Read the stored values without validating them, so a task that no longer passes can still be corrected.
    snapshot = {name: getattr(task, name) for name in TaskIn.model_fields}
    snapshot.update({k: v for k, v in changes.items() if k != "completed"})
    try:
        validated = TaskIn.model_validate(snapshot)
    except ValidationError as error:
        raise HTTPException(422, "Invalid task: " + str(error.errors()[0]["msg"])) from error
    if validated.project_id is not None:
        owned(db, Project, validated.project_id, user)
    changes.update(validated.model_dump())
    complete = changes.get("completed", task.completed)
    if complete is None:
        raise HTTPException(422, "completed cannot be null")
    if complete and task.completed and any(not item.completed for item in validated.checklist):
        raise HTTPException(422, "Reopen the task before unchecking checklist items")
    if complete:
        changes["checklist"] = [{**item.model_dump(), "completed": True} for item in validated.checklist]
    changes["completed_at"] = (task.completed_at or now()) if complete else None
    discard = None
    if undo and not complete and task.completed and task.successor_id:
        found = db.get(Task, task.successor_id)
        if found and found.user_id == user.id and found.version == 1 and not found.completed:
            discard = found
            changes["successor_id"] = None
    # Occurrences can be clamped to a short month or shifted by a DST gap. Keep the original day and
    # time for the series until the user chooses a new schedule, so the shift does not become permanent.
    same_series = validated.recurrence == task.recurrence
    anchor_day = task.recurrence_day if same_series and validated.due_date == task.due_date else None
    anchor_time = task.recurrence_time if same_series and validated.due_time == task.due_time else None
    changes.update(recurrence_day=anchor_day, recurrence_time=anchor_time)
    successor = None
    if complete and not task.completed and validated.recurrence and not task.successor_id:
        series_day = anchor_day or validated.due_date.day
        series_time = anchor_time or validated.due_time
        upcoming = next_date(validated.due_date, validated.recurrence, series_day)
        successor = Task(
            id=uid(),
            user_id=user.id,
            recurrence_day=series_day,
            recurrence_time=series_time,
            **{
                **validated.model_dump(),
                "due_date": upcoming,
                "due_time": recurrence_clock(upcoming, series_time, validated.time_zone),
                "checklist": [{**item.model_dump(), "completed": False} for item in validated.checklist],
            },
        )
        changes["successor_id"] = successor.id
    changes.update(version=version + 1, updated_at=now())
    result = db.execute(
        update(Task)
        .where(Task.id == task.id, Task.user_id == user.id, Task.version == version)
        .values(**changes)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(409, "This task changed on another device. Refresh and try again.")
    if successor:
        db.add(successor)
    if discard:
        db.delete(discard)
    db.commit()
    db.refresh(task)
    events.publish(user.id, task_ref(task.id), "updated", task.version)
    if discard:
        events.publish(user.id, task_ref(discard.id), "deleted")
    if successor:
        events.publish(user.id, task_ref(successor.id), "updated", 1)
    return task


@api.patch("/tasks/{task_id}", response_model=TaskOut)
def edit_task(task_id: str, data: TaskPatch, user=Depends(authenticate), db: Session = Depends(get_db)):
    return mutate(db, user, task_id, data)


@api.post("/tasks/{task_id}/complete", response_model=TaskOut)
def complete_task(task_id: str, data: Version, user=Depends(authenticate), db: Session = Depends(get_db)):
    return mutate(db, user, task_id, TaskPatch(version=data.version, completed=True))


@api.delete("/tasks/{task_id}", status_code=204)
def delete_task(task_id: str, version: int = Query(ge=1), user=Depends(authenticate), db: Session = Depends(get_db)):
    owned(db, Task, task_id, user)
    result = db.execute(delete(Task).where(Task.id == task_id, Task.user_id == user.id, Task.version == version))
    if result.rowcount != 1:
        raise HTTPException(409, "This task changed on another device. Refresh and try again.")
    db.commit()
    events.publish(user.id, task_ref(task_id), "deleted")


@api.get("/tokens", response_model=list[TokenOut])
def tokens(request: Request, user=Depends(authenticate), db: Session = Depends(get_db)):
    session_only(request)
    return db.scalars(select(Credential).where(Credential.user_id == user.id, Credential.kind == "api")).all()


@api.post("/tokens", status_code=201)
def create_token(data: TokenIn, request: Request, user=Depends(authenticate), db: Session = Depends(get_db)):
    session_only(request)
    token, credential = issue(db, user, "api", data.name)
    return {**TokenOut.model_validate(credential).model_dump(), "token": token}


@api.delete("/tokens/{token_id}", status_code=204)
def delete_token(token_id: str, request: Request, user=Depends(authenticate), db: Session = Depends(get_db)):
    session_only(request)
    token = owned(db, Credential, token_id, user)
    if token.kind != "api":
        raise HTTPException(404)
    db.delete(token)
    db.commit()


@api.get("/sessions", response_model=list[SessionOut])
def sessions(request: Request, user=Depends(authenticate), db: Session = Depends(get_db)):
    session_only(request)
    rows = db.scalars(
        select(Credential)
        .where(Credential.user_id == user.id, Credential.kind != "api", Credential.expires_at > now())
        .order_by(Credential.created_at.desc())
    )
    return [
        SessionOut(
            id=row.id,
            kind=row.kind,
            created_at=row.created_at,
            expires_at=row.expires_at,
            current=row.id == request.state.credential.id,
        )
        for row in rows
    ]


@api.delete("/sessions/{session_id}", status_code=204)
def delete_session(session_id: str, request: Request, user=Depends(authenticate), db: Session = Depends(get_db)):
    session_only(request)
    session = owned(db, Credential, session_id, user)
    if session.kind == "api":
        raise HTTPException(404)
    if session.id == request.state.credential.id:
        raise HTTPException(422, "Use Sign out to end the session on this device.")
    db.delete(session)
    db.commit()


app.include_router(push_router)
app.include_router(quick_router)
app.include_router(api)
app.include_router(contract_api)
app.include_router(contract_router)
app.mount("/mcp", http_app(settings.public_url))
static = Path(settings.static_directory).resolve()


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str):
    if path.startswith(("api/", "auth/")) or "\x00" in path:
        raise HTTPException(404)
    requested = (static / path).resolve()
    # Vite fingerprints everything in assets/, so those can be cached for good. Everything else keeps its name
    # (index.html, embed.js, sw.js) and must revalidate.
    immutable = {"Cache-Control": "public, max-age=31536000, immutable"}
    fresh = {"Cache-Control": "no-cache"}
    if requested.is_relative_to(static) and requested.is_file():
        return FileResponse(requested, headers=immutable if path.startswith("assets/") else fresh)
    if path.startswith("assets/"):
        # An HTML fallback here would be blocked as a script, leaving stale pages blank after a deploy.
        raise HTTPException(404)
    if (static / "index.html").exists():
        return FileResponse(static / "index.html", headers=fresh)
    raise HTTPException(404, "Build the web app or start the Vite development server")
