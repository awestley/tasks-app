"""MCP adapter using the same versioned, authenticated API as every client."""

import os
import re
from urllib.parse import urlparse

import httpx
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations

from .schemas import ChecklistItem

mcp = FastMCP(
    "Tasks",
    instructions="Manage the user's tasks and projects. Read before editing, and supply the returned version. Dates are local calendar dates. Only make changes the user has requested.",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
)


def http_app(public_url: str):
    """Build the remote endpoint. The API supplies its settings, because the stdio adapter runs without them."""
    public = urlparse(public_url)
    mcp.settings.transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:*", "localhost:*", public.netloc],
        allowed_origins=[public.scheme + "://" + public.netloc],
    )
    return mcp.streamable_http_app()


async def call(ctx: Context, path: str, method="GET", data=None, params=None):
    request = ctx.request_context.request
    token = (
        request.headers.get("authorization", "").removeprefix("Bearer ")
        if request
        else os.environ.get("TASKWELL_TOKEN", "")
    )
    if not token:
        raise ValueError("Set TASKWELL_TOKEN or send a Bearer token with your MCP request")
    base = os.environ.get("TASKWELL_API_URL", "http://127.0.0.1:8000").rstrip("/")
    url = urlparse(base)
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1"}):
        raise ValueError("TASKWELL_API_URL must use HTTPS, except for localhost")
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.request(
            method, base + "/api/v1" + path, json=data, params=params, headers={"Authorization": "Bearer " + token}
        )
        if not response.is_success:
            try:
                detail = response.json().get("detail", "Request failed")
            except ValueError:
                detail = "Request failed"
            raise ValueError(f"The server returned {response.status_code}: {detail}")
        return response.json() if response.status_code != 204 else {"ok": True}


def task_path(task_id: str, suffix: str = "") -> str:
    """Task IDs become URL path segments, so accept only the form the API issues."""
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", task_id):
        raise ValueError("task_id must be an ID returned by list_tasks")
    return "/tasks/" + task_id + suffix


read_only = ToolAnnotations(readOnlyHint=True, destructiveHint=False)
write = ToolAnnotations(readOnlyHint=False, destructiveHint=False)
destructive = ToolAnnotations(readOnlyHint=False, destructiveHint=True)


@mcp.tool(annotations=read_only)
async def list_tasks(
    ctx: Context,
    query: str = "",
    completed: bool | None = None,
    project_id: str | None = None,
    label: str | None = None,
    due_before: str | None = None,
    offset: int = 0,
    limit: int = 100,
) -> list:
    """Find tasks. Page with offset/limit (max 200). Use project_id='inbox' for unfiled tasks. Dates: YYYY-MM-DD."""
    params = {
        "q": query,
        "offset": offset,
        "limit": limit,
        "completed": completed,
        "project_id": project_id,
        "label": label,
        "due_before": due_before,
    }
    return await call(ctx, "/tasks", params={k: v for k, v in params.items() if v is not None})


@mcp.tool(annotations=read_only)
async def list_projects(ctx: Context) -> list:
    """List the user's project IDs, names and colors."""
    return await call(ctx, "/projects")


@mcp.tool(annotations=write)
async def create_task(
    ctx: Context,
    title: str,
    description: str = "",
    project_id: str | None = None,
    due_date: str | None = None,
    due_time: str | None = None,
    time_zone: str = "UTC",
    reminder_minutes: int | None = None,
    priority: int = 4,
    labels: list[str] | None = None,
    recurrence: str | None = None,
    checklist: list[ChecklistItem] | None = None,
) -> dict:
    """Create a task. Priority 1 is urgent, 4 normal. Recurrence: daily, weekly, monthly; requires a due date. Checklist items have title, optional id, and completed. A reminder needs due_date and due_time (HH:MM) with an IANA time_zone; reminder_minutes=0 means at due time. Clients must opt into push on each device."""
    return await call(
        ctx,
        "/tasks",
        "POST",
        {
            "title": title,
            "description": description,
            "project_id": project_id,
            "due_date": due_date,
            "due_time": due_time,
            "time_zone": time_zone,
            "reminder_minutes": reminder_minutes,
            "priority": priority,
            "labels": labels or [],
            "recurrence": recurrence,
            "checklist": [item.model_dump() for item in checklist or []],
        },
    )


@mcp.tool(annotations=write)
async def update_task(ctx: Context, task_id: str, version: int, changes: dict) -> dict:
    """Edit a task using its current version. Changes may include title, description, project_id, due_date, due_time (HH:MM), time_zone (IANA), reminder_minutes (0 at due time, null disabled), priority, labels, recurrence, completed, checklist. Checklist arrays replace the full list; preserve item IDs. Null clears optional fields. On 409, reread before retrying."""
    allowed = {
        "title",
        "description",
        "project_id",
        "due_date",
        "due_time",
        "time_zone",
        "reminder_minutes",
        "priority",
        "labels",
        "recurrence",
        "completed",
        "checklist",
    }
    if not changes or not set(changes).issubset(allowed):
        raise ValueError("Supply at least one supported task field")
    return await call(ctx, task_path(task_id), "PATCH", {**changes, "version": version})


@mcp.tool(annotations=write)
async def complete_task(ctx: Context, task_id: str, version: int) -> dict:
    """Complete a task and generate its next occurrence if recurring. Requires the current version."""
    return await call(ctx, task_path(task_id, "/complete"), "POST", {"version": version})


@mcp.tool(annotations=destructive)
async def delete_task(ctx: Context, task_id: str, version: int) -> dict:
    """Permanently delete a task. Only do this at the user's explicit request."""
    return await call(ctx, task_path(task_id), "DELETE", params={"version": version})


@mcp.tool(annotations=write)
async def create_project(ctx: Context, name: str, color: str = "#2563eb") -> dict:
    """Create a project. Color must be a six-digit hexadecimal color including #."""
    return await call(ctx, "/projects", "POST", {"name": name, "color": color})


@mcp.tool(annotations=read_only)
async def parse_task(ctx: Context, text: str, time_zone: str) -> dict:
    """Preview English task text, such as Order pizza Friday afternoon. Returns extracted fields without saving. Time zone must be IANA, e.g. America/New_York. Show the interpretation before creating when ambiguous."""
    return await call(ctx, "/tasks/parse", "POST", {"text": text, "time_zone": time_zone})


if __name__ == "__main__":
    mcp.run(transport="stdio")
