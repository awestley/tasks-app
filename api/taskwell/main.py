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
from sqlalchemy import delete, select, text, update
from sqlalchemy.orm import Session

from .auth import authenticate, issue, revoke_apple, session_only, trusted_origin
from .auth import router as auth_router
from . import events
from .config import settings
from .contract import api as contract_api
from .contract import project_ref, task_ref
from .contract import router as contract_router
from .db import Credential, Project, SessionLocal, Task, get_db, now, uid
from .mcp_server import mcp
from .migrations import upgrade_local_database
from .push import apns_ready, web_ready
from .push import router as push_router
from .quick_add import router as quick_router
from .reminders import run as reminder_loop
from .scheduling import recurrence_clock
from .schemas import (
    Profile,
    ProjectCreate,
    ProjectIn,
    ProjectOut,
    TaskCreate,
    TaskIn,
    TaskOut,
    TaskPatch,
    TokenIn,
    TokenOut,
    Version,
)


@asynccontextmanager
async def lifespan(app):
    if not settings.production:
        upgrade_local_database()
    stop = asyncio.Event()
    worker = asyncio.create_task(reminder_loop(stop)) if web_ready() or apns_ready() else None
    try:
        async with mcp.session_manager.run():
            yield
    finally:
        stop.set()
        if worker:
            await worker


app = FastAPI(
    title="Tasks API",
    version="0.1.0",
    lifespan=lifespan,
    description="Private task management. Authenticate with a revocable personal access token or a session.",
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


def route_path(request):
    """The path inside the app, without the base path the shell serves it under."""
    path, prefix = request.url.path, settings.base_path
    return path[len(prefix) :] if prefix and path.startswith(prefix + "/") else path


@app.middleware("http")
async def protect(request: Request, call_next):
    if settings.base_path and request.url.path == settings.base_path:
        return RedirectResponse(settings.base_path + "/", 308)
    path = route_path(request)
    if len(request.headers.get("content-length", "")) > 8 or (
        request.headers.get("content-length", "0").isdigit()
        and int(request.headers.get("content-length", "0")) > 100_000
    ):
        return JSONResponse({"detail": "Request too large"}, 413)
    if path.startswith("/auth/") and path != "/auth/config":
        instant = time.monotonic()
        key = request.client.host if request.client else "unknown"
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
    response.delete_cookie("taskwell_session")
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
def edit_project(project_id: str, data: ProjectIn, user=Depends(authenticate), db: Session = Depends(get_db)):
    project = owned(db, Project, project_id, user)
    project.name, project.color = data.name, data.color
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
        # Portable across SQLite development and PostgreSQL production.
        matches = [t for t in db.scalars(query) if label in t.labels]
        return matches[offset : offset + limit]
    return db.scalars(query.offset(offset).limit(limit)).all()


@api.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(task_id: str, user=Depends(authenticate), db: Session = Depends(get_db)):
    return owned(db, Task, task_id, user)


@api.post("/tasks", response_model=TaskOut, status_code=201)
def create_task(data: TaskCreate, response: Response, user=Depends(authenticate), db: Session = Depends(get_db)):
    if data.id and (found := existing(db, Task, str(data.id), user, response)):
        return found
    if data.project_id:
        owned(db, Project, data.project_id, user)
    task = Task(user_id=user.id, **data.model_dump(exclude={"id"}), **({"id": str(data.id)} if data.id else {}))
    db.add(task)
    db.commit()
    events.publish(user.id, task_ref(task.id), "updated", task.version)
    return task


def next_date(value, recurrence):
    if recurrence == "daily":
        return value + timedelta(days=1)
    if recurrence == "weekly":
        return value + timedelta(days=7)
    month = value.month % 12 + 1
    year = value.year + (value.month == 12)
    return date(year, month, min(value.day, calendar.monthrange(year, month)[1]))


def mutate(db, user, task_id, data):
    task = owned(db, Task, task_id, user)
    changes = data.model_dump(exclude_unset=True)
    version = changes.pop("version")
    undo = changes.pop("undo", None)
    snapshot = TaskIn.model_validate(task).model_dump()
    snapshot.update({k: v for k, v in changes.items() if k != "completed"})
    try:
        validated = TaskIn.model_validate(snapshot)
    except ValidationError as error:
        raise HTTPException(422, "Invalid task: " + str(error.errors()[0]["msg"])) from error
    if validated.project_id:
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
    successor = None
    if complete and not task.completed and validated.recurrence and not task.successor_id:
        successor = Task(
            id=uid(),
            user_id=user.id,
            **{
                **validated.model_dump(),
                "due_date": next_date(validated.due_date, validated.recurrence),
                "due_time": recurrence_clock(
                    next_date(validated.due_date, validated.recurrence), validated.due_time, validated.time_zone
                ),
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


app.include_router(push_router)
app.include_router(quick_router)
app.include_router(api)
app.include_router(contract_api)
app.include_router(contract_router)
app.mount("/mcp", mcp.streamable_http_app())
static = Path(settings.static_directory).resolve()


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str):
    if path.startswith(("api/", "auth/")):
        raise HTTPException(404)
    requested = (static / path).resolve()
    # Hashed build assets can be cached for good; everything else (index.html, embed.js, sw.js) is revalidated.
    fresh = {"Cache-Control": "no-cache"}
    if requested.is_relative_to(static) and requested.is_file():
        return FileResponse(requested, headers=None if path.startswith("assets/") else fresh)
    if (static / "index.html").exists():
        return FileResponse(static / "index.html", headers=fresh)
    raise HTTPException(404, "Build the web app or start the Vite development server")
