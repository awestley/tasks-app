"""Exercise both MCP transports against a running, local demo API. No credentials are printed."""

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client

from mcp import ClientSession, StdioServerParameters

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("TASKWELL_API_URL", "http://127.0.0.1:8000")


async def exercise(session):
    await session.initialize()
    tools = await session.list_tools()
    assert {
        "list_tasks",
        "create_task",
        "update_task",
        "complete_task",
        "delete_task",
        "list_projects",
        "create_project",
        "parse_task",
    } <= {t.name for t in tools.tools}
    preview = await session.call_tool(
        "parse_task", {"text": "Order pizza Friday afternoon", "time_zone": "America/New_York"}
    )
    assert not preview.isError, preview
    parsed = preview.structuredContent or json.loads(preview.content[0].text)
    assert parsed["title"] == "Order pizza"
    assert parsed["due_time"] == "15:00"
    made = await session.call_tool(
        "create_task",
        {
            "title": "MCP verification task",
            "due_date": "2099-10-30",
            "due_time": "15:00",
            "time_zone": "America/New_York",
            "reminder_minutes": 15,
            "checklist": [{"title": "First item"}, {"title": "Second item"}],
        },
    )
    assert not made.isError, made
    task = made.structuredContent
    if not task:
        task = json.loads(made.content[0].text)
    assert task["due_time"] == "15:00" and task["reminder_minutes"] == 15
    assert len(task["checklist"]) == 2
    assert all(item["id"] and not item["completed"] for item in task["checklist"])
    changed_items = [{**task["checklist"][0], "completed": True}, task["checklist"][1]]
    updated = await session.call_tool(
        "update_task",
        {
            "task_id": task["id"],
            "version": task["version"],
            "changes": {"title": "MCP verified", "checklist": changed_items, "reminder_minutes": 30},
        },
    )
    assert not updated.isError, updated
    stale = await session.call_tool("complete_task", {"task_id": task["id"], "version": 1})
    assert stale.isError
    completed = await session.call_tool("complete_task", {"task_id": task["id"], "version": 2})
    assert not completed.isError, completed
    if completed.structuredContent:
        assert all(item["completed"] for item in completed.structuredContent["checklist"])
    deleted = await session.call_tool("delete_task", {"task_id": task["id"], "version": 3})
    assert not deleted.isError, deleted


async def main():
    async with httpx.AsyncClient(base_url=BASE) as client:
        login = await client.post(
            "/auth/dev", headers={"Origin": os.environ.get("PUBLIC_URL", "http://localhost:5173")}
        )
        login.raise_for_status()
        token_response = await client.post(
            "/api/v1/tokens",
            json={"name": "MCP verification"},
            headers={"Origin": os.environ.get("PUBLIC_URL", "http://localhost:5173")},
        )
        token_response.raise_for_status()
        token = token_response.json()
        try:
            params = StdioServerParameters(
                command=sys.executable,
                args=["-m", "taskwell.mcp_server"],
                cwd=str(ROOT / "api"),
                env={**os.environ, "TASKWELL_TOKEN": token["token"], "TASKWELL_API_URL": BASE},
            )
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await exercise(session)
            async with streamablehttp_client(BASE + "/mcp/", headers={"Authorization": "Bearer " + token["token"]}) as (
                read,
                write,
                _,
            ):
                async with ClientSession(read, write) as session:
                    await exercise(session)
            print(
                "PASS: stdio and HTTP MCP discovery, parse, create, update, conflict, checklist, reminders, complete, delete"
            )
        finally:
            await client.delete(
                "/api/v1/tokens/" + token["id"],
                headers={"Origin": os.environ.get("PUBLIC_URL", "http://localhost:5173")},
            )


asyncio.run(main())
