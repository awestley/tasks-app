"""The MCP tools over the HTTP endpoint, calling the API in process. No network or separate server."""

import json

import pytest

from tasks import main

HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
    # The endpoint refuses unknown hosts (DNS rebinding protection).
    "Host": "localhost:8000",
}


@pytest.fixture
def mcp(workspace, monkeypatch):
    client, other, session = workspace
    # The endpoint checks the bearer token itself before the tools run; use the test database for that too.
    monkeypatch.setattr(main, "SessionLocal", session)

    def rpc(method, params=None, headers=None):
        body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
        response = client.post("/mcp/", json=body, headers={**HEADERS, **(headers or {})})
        assert response.status_code == 200, response.text
        return response.json()

    def tool(name, arguments=None, headers=None):
        result = rpc("tools/call", {"name": name, "arguments": arguments or {}}, headers)["result"]
        if result.get("isError"):
            raise AssertionError(result["content"][0]["text"])
        if result.get("structuredContent") is not None:
            content = result["structuredContent"]
            return content.get("result", content)
        return json.loads(result["content"][0]["text"])

    def failure(name, arguments):
        result = rpc("tools/call", {"name": name, "arguments": arguments})["result"]
        assert result.get("isError"), result
        return result["content"][0]["text"]

    rpc.tool, rpc.failure, rpc.client, rpc.other = tool, failure, client, other
    return rpc


def test_tools_and_prompts_are_listed(mcp):
    tools = {tool["name"]: tool for tool in mcp("tools/list")["result"]["tools"]}
    assert {
        "search",
        "list_tasks",
        "get_task",
        "get_project",
        "create_task",
        "add_task",
        "update_task",
        "update_tasks",
        "delete_tasks",
        "delete_project",
        "link_item",
        "find_linked",
    } <= set(tools)
    assert "list_project_links" not in tools
    assert tools["delete_tasks"]["annotations"]["destructiveHint"] is True
    assert tools["delete_project"]["annotations"]["destructiveHint"] is True
    assert tools["search"]["annotations"]["readOnlyHint"] is True
    item = tools["update_tasks"]["inputSchema"]["$defs"]["TaskVersion"]
    assert set(item["required"]) == {"task_id", "version"}
    prompts = {prompt["name"] for prompt in mcp("prompts/list")["result"]["prompts"]}
    assert {"flesh_out_task", "plan_project", "capture_in_notebook"} <= prompts
    text = mcp("prompts/get", {"name": "plan_project", "arguments": {"project_id": "p"}})["result"]
    assert "get_project" in text["messages"][0]["content"]["text"]


def test_search_finds_checklist_items_and_projects(mcp):
    task = mcp.tool("create_task", {"title": "Plan trip", "checklist": [{"title": "Book the ferry"}]})
    mcp.tool("create_project", {"name": "Ferry repairs"})
    found = mcp.tool("search", {"query": "ferry"})
    assert {item["type"] for item in found["items"]} == {"task", "project"}
    hit = next(item for item in found["items"] if item["type"] == "task")
    assert hit["ref"] == task["ref"] and "ferry" in hit["snippet"]["text"].lower()
    assert [item["type"] for item in mcp.tool("search", {"query": "ferry", "types": "project"})["items"]] == ["project"]
    assert "q_required" in mcp.failure("search", {"query": "   "})


def test_get_project_includes_links(mcp):
    project = mcp.tool("create_project", {"name": "Travel"})
    mcp.tool("link_item", {"project_id": project["id"], "ref": "pc://notes/note/abc", "title": "Trip notes"})
    read = mcp.tool("get_project", {"project_id": project["id"]})
    assert read["name"] == "Travel" and read["ref"] == project["ref"]
    assert [link["title"] for link in read["links"]] == ["Trip notes"]


def test_find_linked_includes_description_mentions(mcp):
    stored = mcp.tool("create_task", {"title": "Linked"})
    mcp.tool("link_item", {"task_id": stored["id"], "ref": "pc://notes/note/abc", "title": "Notes"})
    mentioned = mcp.tool("create_task", {"title": "Mentioned", "description": "See [[note:abc|the notes]]."})
    found = mcp.tool("find_linked", {"ref": "pc://notes/note/abc"})
    assert {item["ref"] for item in found["items"]} == {stored["ref"], mentioned["ref"]}


def test_update_tasks_changes_each_and_reports_conflicts(mcp):
    project = mcp.tool("create_project", {"name": "Home"})
    first = mcp.tool("create_task", {"title": "Paint"})
    second = mcp.tool("create_task", {"title": "Sand"})
    third = mcp.tool("create_task", {"title": "Prime"})
    mcp.tool("update_task", {"task_id": third["id"], "version": 1, "changes": {"title": "Prime walls"}})
    result = mcp.tool(
        "update_tasks",
        {
            "tasks": [
                {"task_id": first["id"], "version": 1},
                {"task_id": second["id"], "version": 1},
                {"task_id": third["id"], "version": 1},
            ],
            "changes": {"project_id": project["id"], "priority": 1},
        },
    )
    assert result["changed"] == 2 and result["failed"] == 1
    stale = next(item for item in result["results"] if not item["ok"])
    assert stale["task_id"] == third["id"] and "409" in stale["error"]
    moved = mcp.tool("list_tasks", {"project_id": project["id"]})
    assert {task["title"] for task in moved} == {"Paint", "Sand"}
    assert all(task["priority"] == 1 for task in moved)
    rename = {"tasks": [{"task_id": first["id"], "version": 2}], "changes": {"title": "x"}}
    assert "Changes may include" in mcp.failure("update_tasks", rename)
    duplicate = [{"task_id": first["id"], "version": 2}] * 2
    assert "once" in mcp.failure("update_tasks", {"tasks": duplicate, "changes": {"priority": 2}})
    too_many = [{"task_id": f"00000000-0000-0000-0000-{i:012d}", "version": 1} for i in range(101)]
    assert "100" in mcp.failure("update_tasks", {"tasks": too_many, "changes": {"priority": 2}})


def test_delete_tasks_and_delete_project(mcp):
    project = mcp.tool("create_project", {"name": "Old"})
    kept = mcp.tool("create_task", {"title": "Keep me", "project_id": project["id"]})
    gone = mcp.tool("create_task", {"title": "Remove me"})
    result = mcp.tool("delete_tasks", {"tasks": [{"task_id": gone["id"], "version": 1}]})
    assert result == {"changed": 1, "failed": 0, "results": [{"task_id": gone["id"], "ok": True, "version": None}]}
    mcp.tool("delete_project", {"project_id": project["id"]})
    assert mcp.tool("get_task", {"task_id": kept["id"]})["project_id"] is None
    assert "404" in mcp.failure("get_task", {"task_id": gone["id"]})


def test_undo_removes_the_untouched_next_occurrence(mcp):
    task = mcp.tool("create_task", {"title": "Water plants", "due_date": "2026-11-20", "recurrence": "weekly"})
    done = mcp.tool("complete_task", {"task_id": task["id"], "version": 1})
    assert len(mcp.tool("list_tasks", {"query": "Water plants"})) == 2
    assert "undo" in mcp.failure(
        "update_task", {"task_id": task["id"], "version": done["version"], "changes": {"title": "x"}, "undo": True}
    )
    mcp.tool(
        "update_task",
        {"task_id": task["id"], "version": done["version"], "changes": {"completed": False}, "undo": True},
    )
    remaining = mcp.tool("list_tasks", {"query": "Water plants"})
    assert [(t["id"], t["completed"]) for t in remaining] == [(task["id"], False)]


def test_tools_act_only_for_the_caller(mcp):
    task = mcp.tool("create_task", {"title": "Private"})
    result = mcp("tools/call", {"name": "get_task", "arguments": {"task_id": task["id"]}}, mcp.other)["result"]
    assert result["isError"] and "404" in result["content"][0]["text"]
    assert mcp.tool("search", {"query": "Private"}, mcp.other)["items"] == []
    batch = {"tasks": [{"task_id": task["id"], "version": 1}], "changes": {"priority": 1}}
    assert mcp.tool("update_tasks", batch, mcp.other)["failed"] == 1
    assert mcp.tool("get_task", {"task_id": task["id"]})["priority"] == 4


def test_spaces_through_the_tools(mcp):
    work = mcp.tool("create_project", {"name": "Quarterly report", "space": "work"})
    assert [p["name"] for p in mcp.tool("list_projects", {"space": "work"})] == ["Quarterly report"]
    filed = mcp.tool("create_task", {"title": "Draft numbers", "project_id": work["id"]})
    loose = mcp.tool("create_task", {"title": "Book review"})
    assert filed["space"] == "work" and loose["space"] == "personal"
    batch = [{"task_id": filed["id"], "version": 1}, {"task_id": loose["id"], "version": 1}]
    assert mcp.tool("update_tasks", {"tasks": batch, "changes": {"space": "personal"}})["changed"] == 2
    moved = mcp.tool("get_task", {"task_id": filed["id"]})
    # Changing only the space takes a task out of its project.
    assert moved["space"] == "personal" and moved["project_id"] is None
    assert {t["title"] for t in mcp.tool("list_tasks", {"space": "personal"})} == {"Draft numbers", "Book review"}


def test_add_task_reads_the_line_like_quick_add(mcp):
    home = mcp.tool("create_project", {"name": "Home", "space": "work"})
    added = mcp.tool(
        "add_task",
        {"text": "Call the plumber tomorrow 3pm p2 @phone #Home", "time_zone": "America/New_York"},
    )
    task = added["task"]
    assert task["title"] == "Call the plumber"
    assert task["due_time"] == "15:00" and task["due_date"] and task["time_zone"] == "America/New_York"
    assert task["priority"] == 2 and task["labels"] == ["phone"]
    # The project decides the space.
    assert task["project_id"] == home["id"] and task["space"] == "work"
    assert added["recognized"]
    plain = mcp.tool("add_task", {"text": "  Read the manual ", "time_zone": "UTC", "space": "work"})
    assert plain["task"]["title"] == "Read the manual" and plain["task"]["space"] == "work"
    assert plain["recognized"] == [] and plain["task"]["due_date"] is None
    assert "text" in mcp.failure("add_task", {"text": " ", "time_zone": "UTC"})


def test_a_repeated_create_with_the_same_id_returns_the_first(mcp):
    chosen = "3f0c8a52-6a51-4d55-9a3c-2f1d1b7a9e10"
    first = mcp.tool("add_task", {"text": "Water plants friday", "time_zone": "UTC", "id": chosen})
    again = mcp.tool("add_task", {"text": "Water plants friday", "time_zone": "UTC", "id": chosen})
    assert first["task"]["id"] == again["task"]["id"] == chosen
    assert len(mcp.tool("list_tasks", {"query": "Water plants"})) == 1
    created = mcp.tool("create_task", {"title": "Once", "id": chosen.replace("3f", "4f", 1)})
    assert mcp.tool("create_task", {"title": "Once", "id": created["id"]})["id"] == created["id"]
    project = "5a1b2c3d-0000-4000-8000-000000000001"
    assert mcp.tool("create_project", {"name": "P", "id": project})["id"] == project
    assert mcp.tool("create_project", {"name": "P", "id": project})["id"] == project
    assert len(mcp.tool("list_projects")) == 1
    assert "UUID" in mcp.failure("create_task", {"title": "x", "id": "not-a-uuid"})
    taken = mcp("tools/call", {"name": "create_task", "arguments": {"title": "x", "id": chosen}}, mcp.other)
    assert taken["result"]["isError"] and "409" in taken["result"]["content"][0]["text"]


def test_errors_carry_the_api_message(mcp):
    task = mcp.tool("create_task", {"title": "Check errors"})
    message = mcp.failure("update_task", {"task_id": task["id"], "version": 1, "changes": {"priority": 9}})
    assert "422" in message and "priority" in message
    assert "409" in mcp.failure("update_task", {"task_id": task["id"], "version": 5, "changes": {"priority": 2}})
