"""The in-app agent, with a fake model and fake MCP servers. No network and no API key are used."""

import asyncio
import json
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool, ToolAnnotations
from sqlalchemy import select

from tasks import agent
from tasks.config import settings
from tasks.db import Credential


class FakeSession:
    def __init__(self, tools, results=None):
        self.tools = tools
        self.results = results or {}
        self.calls = []

    async def list_tools(self):
        return ListToolsResult(tools=self.tools)

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        value = self.results.get(name, {"ok": True})
        return CallToolResult(content=[TextContent(type="text", text=json.dumps(value))], isError=False)


def tool(name, destructive=False):
    return Tool(
        name=name,
        description=name,
        inputSchema={"type": "object", "properties": {"task_id": {"type": "string"}}},
        annotations=ToolAnnotations(destructiveHint=destructive),
    )


class FakeRunner:
    """Calls the named tools in order, as the model would, then ends with a summary."""

    def __init__(self, tools, plan, stop_reason="end_turn", delay=0):
        self.tools = {t.name: t for t in tools}
        self.plan, self.stop_reason, self.delay = plan, stop_reason, delay

    async def until_done(self):
        await asyncio.sleep(self.delay)
        for name, arguments in self.plan:
            await self.tools[name].call(arguments)
        text = SimpleNamespace(type="text", text="Added a checklist and linked the trip note.")
        return SimpleNamespace(content=[text], stop_reason=self.stop_reason)


@pytest.fixture
def harness(workspace, monkeypatch):
    client, other, session = workspace
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    monkeypatch.setattr(agent, "SessionLocal", session)
    tasks_server = FakeSession([tool("get_task"), tool("update_task"), tool("delete_task", destructive=True)])
    notebook = FakeSession([tool("search_notes"), tool("delete_note"), tool("get_task")])
    state = SimpleNamespace(plan=[], stop_reason="end_turn", delay=0, tokens=[], request=None)

    @asynccontextmanager
    async def sessions(token):
        state.tokens.append(token)
        yield [("tasks", tasks_server), ("notebook", notebook)]

    def tool_runner(**request):
        state.request = request
        return FakeRunner(request["tools"], state.plan, state.stop_reason, state.delay)

    monkeypatch.setattr(agent, "open_sessions", sessions)
    fake_client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(tool_runner=tool_runner)))
    monkeypatch.setattr(agent, "client", lambda: fake_client)
    return SimpleNamespace(client=client, other=other, session=session, state=state, tasks=tasks_server, notes=notebook)


def make(client):
    return client.post("/api/v1/tasks", json={"title": "Plan Lisbon trip"}).json()


def wait(client, run_id):
    for _ in range(200):
        run = client.get(f"/api/v1/agent-runs/{run_id}").json()
        if run["status"] not in agent.ACTIVE:
            return run
        time.sleep(0.02)
    raise AssertionError("run did not finish")


def test_run_records_actions_and_revokes_its_credential(harness):
    task = make(harness.client)
    harness.state.plan = [("get_task", {"task_id": task["id"]}), ("search_notes", {"task_id": "Lisbon"})]
    started = harness.client.post(f"/api/v1/tasks/{task['id']}/agent-runs", json={"instruction": "Use my trip notes"})
    assert started.status_code == 202, started.text
    run = wait(harness.client, started.json()["id"])
    assert run["status"] == "done"
    assert run["summary"].startswith("Added a checklist")
    assert [(a["server"], a["tool"], a["ok"]) for a in run["actions"]] == [
        ("tasks", "get_task", True),
        ("notebook", "search_notes", True),
    ]
    request = harness.state.request
    assert request["model"] == settings.agent_model
    assert "Use my trip notes" in request["messages"][0]["content"]
    assert task["id"] in request["messages"][0]["content"]
    # Destructive and blocked tools are never offered, and a duplicate name keeps the first server's tool.
    assert sorted(t.name for t in request["tools"]) == ["get_task", "search_notes", "update_task"]
    with harness.session() as db:
        assert not db.scalars(select(Credential).where(Credential.kind == "agent")).all()
    assert harness.state.tokens and harness.state.tokens[0].startswith("tw_")
    listed = harness.client.get(f"/api/v1/tasks/{task['id']}/agent-runs").json()
    assert [item["id"] for item in listed] == [run["id"]]


def test_one_active_run_per_account_and_ownership(harness):
    task = make(harness.client)
    harness.state.delay = 0.3
    first = harness.client.post(f"/api/v1/tasks/{task['id']}/agent-runs", json={})
    assert first.status_code == 202
    assert harness.client.post(f"/api/v1/tasks/{task['id']}/agent-runs", json={}).status_code == 409
    assert harness.client.get(f"/api/v1/agent-runs/{first.json()['id']}", headers=harness.other).status_code == 404
    assert (
        harness.client.post(f"/api/v1/tasks/{task['id']}/agent-runs", json={}, headers=harness.other).status_code == 404
    )
    wait(harness.client, first.json()["id"])


@pytest.mark.parametrize(
    ("stop_reason", "error"),
    [("refusal", "The model declined this request."), ("tool_use", "Stopped after the maximum number of steps.")],
)
def test_unfinished_runs_are_failures(harness, stop_reason, error):
    task = make(harness.client)
    harness.state.stop_reason = stop_reason
    run = wait(harness.client, harness.client.post(f"/api/v1/tasks/{task['id']}/agent-runs", json={}).json()["id"])
    assert run["status"] == "failed" and run["error"] == error


def test_errors_are_recorded(harness, monkeypatch):
    task = make(harness.client)

    @asynccontextmanager
    async def broken(token):
        raise ConnectionError("unreachable")
        yield

    monkeypatch.setattr(agent, "open_sessions", broken)
    run = wait(harness.client, harness.client.post(f"/api/v1/tasks/{task['id']}/agent-runs", json={}).json()["id"])
    assert run["status"] == "failed" and "ConnectionError" in run["error"]
    with harness.session() as db:
        assert not db.scalars(select(Credential).where(Credential.kind == "agent")).all()


def test_unconfigured_agent_is_unavailable(client, monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    assert client.get("/api/v1/agent").json() == {"available": False, "servers": []}
    task = make(client)
    assert client.post(f"/api/v1/tasks/{task['id']}/agent-runs", json={}).status_code == 503


def test_agent_credentials_cannot_manage_credentials(workspace):
    client, _, session = workspace
    from tasks.auth import issue
    from tasks.db import User

    with session() as db:
        owner = db.scalars(select(User).where(User.apple_sub == "owner")).one()
        token, _ = issue(db, owner, "agent", "Agent run")
    headers = {"Authorization": "Bearer " + token}
    assert client.get("/api/v1/tasks", headers=headers).status_code == 200
    assert client.get("/api/v1/tokens", headers=headers).status_code == 403
    assert client.post("/api/v1/tokens", json={"name": "x"}, headers=headers).status_code == 403
    assert all(item["kind"] != "agent" for item in client.get("/api/v1/sessions").json())


def test_server_list_is_validated(monkeypatch):
    monkeypatch.setattr(settings, "agent_mcp_servers", '[{"name": "notebook", "url": "https://n.test/mcp"}]')
    assert [s.name for s in agent.configured_servers()] == ["notebook"]
    monkeypatch.setattr(settings, "agent_mcp_servers", "not json")
    with pytest.raises(RuntimeError):
        agent.configured_servers()
