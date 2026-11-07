import asyncio
import json
import os
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import select

from taskwell import mcp_server
from taskwell.auth import issue
from taskwell.config import Settings, settings
from taskwell.db import Credential, Project, Task, User, engine
from taskwell.main import MAX_BODY_BYTES, BodyLimit, next_date


def create(client, **fields):
    response = client.post("/api/v1/tasks", json={"title": "Write something worthwhile", **fields})
    assert response.status_code == 201, response.text
    return response.json()


def test_auth_required_and_cookie_origin(client):
    bearer = client.headers.pop("Authorization")
    assert client.get("/api/v1/tasks").status_code == 401
    client.cookies.set("taskwell_session", bearer.removeprefix("Bearer "))
    assert client.get("/api/v1/me").status_code == 200
    for headers in ({}, {"Origin": "https://attacker.test"}):
        assert client.post("/api/v1/tasks", json={"title": "CSRF"}, headers=headers).status_code == 403
    assert (
        client.post("/api/v1/tasks", json={"title": "Allowed"}, headers={"Origin": "http://localhost:5173"}).status_code
        == 201
    )
    # Development also trusts the API's own origin on this machine, where it serves the built web app.
    local = {"Host": "127.0.0.1:8000", "Origin": "http://127.0.0.1:8000"}
    assert client.post("/api/v1/tasks", json={"title": "Same origin"}, headers=local).status_code == 201
    # DNS rebinding makes a foreign name resolve here, so the origin can match the Host header and still be foreign.
    rebound = {"Host": "evil.test:8000", "Origin": "http://evil.test:8000"}
    assert client.post("/api/v1/tasks", json={"title": "Rebound"}, headers=rebound).status_code == 403


def test_crud_persistence_and_conflicts(client):
    task = create(client, labels=["Work", "work"], priority=1)
    assert task["labels"] == ["work"]
    path = "/api/v1/tasks/" + task["id"]
    changed = client.patch(path, json={"version": 1, "title": "Revised"})
    assert changed.status_code == 200 and changed.json()["version"] == 2
    assert client.patch(path, json={"version": 1, "title": "Lost edit"}).status_code == 409
    assert client.delete(path + "?version=1").status_code == 409
    assert client.delete(path + "?version=2").status_code == 204
    assert client.get("/api/v1/tasks").json() == []


def test_other_user_isolation(workspace):
    client, other, _ = workspace
    project = client.post("/api/v1/projects", json={"name": "Private"}).json()
    task = create(client, project_id=project["id"])
    assert client.get("/api/v1/tasks", headers=other).json() == []
    assert client.get("/api/v1/projects", headers=other).json() == []
    assert (
        client.post(
            "/api/v1/tasks", headers=other, json={"title": "Cross-account", "project_id": project["id"]}
        ).status_code
        == 404
    )
    assert (
        client.patch("/api/v1/tasks/" + task["id"], headers=other, json={"version": 1, "title": "Stolen"}).status_code
        == 404
    )
    assert client.delete("/api/v1/tasks/" + task["id"] + "?version=1", headers=other).status_code == 404
    assert client.delete("/api/v1/projects/" + project["id"], headers=other).status_code == 404


@pytest.mark.parametrize(
    "fields",
    [
        {"title": " "},
        {"priority": 0},
        {"priority": 5},
        {"labels": [""]},
        {"recurrence": "weekly"},
        {"due_date": "2026-02-30"},
        {"recurrence": "yearly"},
        {"unexpected": True},
    ],
)
def test_validation(client, fields):
    assert client.post("/api/v1/tasks", json={"title": "Valid", **fields}).status_code == 422


def test_patch_validation_and_nullable_fields(client):
    task = create(client, due_date="2026-10-26", recurrence="daily")
    path = "/api/v1/tasks/" + task["id"]
    for change in ({"title": None}, {"priority": None}, {"labels": [""]}, {"completed": None}, {"due_date": None}):
        assert client.patch(path, json={"version": 1, **change}).status_code == 422
    result = client.patch(path, json={"version": 1, "due_date": None, "recurrence": None})
    assert result.status_code == 200 and result.json()["due_date"] is None


def test_recurrence_does_not_duplicate_after_retry_or_restore(client):
    task = create(client, due_date="2026-01-31", recurrence="monthly")
    path = "/api/v1/tasks/" + task["id"]
    assert client.post(path + "/complete", json={"version": 1}).status_code == 200
    assert client.post(path + "/complete", json={"version": 1}).status_code == 409
    all_tasks = client.get("/api/v1/tasks").json()
    assert len(all_tasks) == 2
    assert next(t for t in all_tasks if not t["completed"])["due_date"] == "2026-02-28"
    assert client.patch(path, json={"version": 2, "completed": False}).status_code == 200
    assert client.post(path + "/complete", json={"version": 3}).status_code == 200
    assert len(client.get("/api/v1/tasks").json()) == 2


def test_recurrence_calendar_edges():
    assert next_date(date(2028, 1, 31), "monthly") == date(2028, 2, 29)
    assert next_date(date(2026, 12, 31), "monthly") == date(2027, 1, 31)
    assert next_date(date(2026, 12, 31), "daily") == date(2027, 1, 1)
    assert next_date(date(2026, 12, 31), "weekly") == date(2027, 1, 7)


def test_project_delete_preserves_tasks(client):
    project = client.post("/api/v1/projects", json={"name": "Work", "color": "#aabbcc"}).json()
    task = create(client, project_id=project["id"])
    assert client.delete("/api/v1/projects/" + project["id"]).status_code == 204
    saved = client.get("/api/v1/tasks").json()[0]
    assert saved["project_id"] is None and saved["version"] == 2 and saved["id"] == task["id"]


def test_search_filters_pagination(client):
    create(client, title="A 100% effort", labels=["work"], due_date="2026-10-26")
    create(client, title="Another plan", labels=["home"], due_date="2026-10-27")
    for query in ("q=%25", "label=work", "due_before=2026-10-26"):
        assert len(client.get("/api/v1/tasks?" + query).json()) == 1
    assert client.get("/api/v1/tasks?limit=1&offset=1").json()[0]["title"] == "Another plan"
    assert client.get("/api/v1/tasks?limit=201").status_code == 422


def test_token_revocation_scope_and_hash(workspace):
    client, other, session = workspace
    response = client.post("/api/v1/tokens", json={"name": "MCP"})
    assert response.status_code == 201
    token = response.json()
    headers = {"Authorization": "Bearer " + token["token"]}
    assert client.get("/api/v1/me", headers=headers).status_code == 200
    assert "token" not in client.get("/api/v1/tokens").json()[0]
    assert client.post("/api/v1/tokens", json={"name": "Escalation"}, headers=headers).status_code == 403
    assert client.delete("/api/v1/me", headers=headers).status_code == 403
    assert client.delete("/api/v1/tokens/" + token["id"], headers=other).status_code == 404
    with session() as db:
        stored = db.get(Credential, token["id"])
        assert stored.digest != token["token"] and len(stored.digest) == 64
    assert client.delete("/api/v1/tokens/" + token["id"]).status_code == 204
    assert client.get("/api/v1/me", headers=headers).status_code == 401


def test_logout(client):
    assert client.post("/auth/logout").status_code == 200
    assert client.get("/api/v1/me").status_code == 401


def test_account_deletion(workspace):
    client, other, session = workspace
    create(client)
    client.post("/api/v1/projects", json={"name": "Work"})
    client.post("/api/v1/tokens", json={"name": "Test"})
    owner = client.get("/api/v1/me").json()["id"]
    assert client.delete("/api/v1/me").status_code == 204
    assert client.get("/api/v1/me").status_code == 401
    assert client.get("/api/v1/me", headers=other).status_code == 200
    with session() as db:
        assert db.get(User, owner) is None
        for model in (Credential, Project, Task):
            assert db.scalars(select(model).where(model.user_id == owner)).all() == []


def test_production_rejects_unsafe_config():
    with pytest.raises(RuntimeError):
        Settings(environment="production", dev_login=True).validate_production()
    with pytest.raises(RuntimeError):
        Settings(environment="production", secret_key="x" * 40, dev_login=False).validate_production()
    complete = dict(
        environment="production",
        secret_key="x" * 40,
        dev_login=False,
        public_url="https://tasks.example.com",
        database_url="postgresql://localhost/tasks",
        apple_team_id="T",
        apple_key_id="K",
        apple_private_key="P",
        apple_web_client_id="W",
    )
    with pytest.raises(RuntimeError, match="ALLOWED_APPLE_ACCOUNTS"):
        Settings(**complete, allowed_apple_accounts=" , ").validate_production()
    with pytest.raises(RuntimeError, match="without a path"):
        Settings(
            **{**complete, "public_url": "https://tasks.example.com/app"}, allowed_apple_accounts="o"
        ).validate_production()
    with pytest.raises(RuntimeError, match="ALLOWED_APPLE_ACCOUNTS"):
        Settings(**complete, allowed_apple_accounts="REPLACE_WITH_YOUR_APPLE_EMAIL").validate_production()
    Settings(**complete, allowed_apple_accounts="001234.owner").validate_production()
    # The shell decides who can sign in, so running inside it needs neither Apple nor the allowlist.
    Settings(
        environment="production",
        secret_key="x" * 40,
        dev_login=False,
        public_url="https://shell.example.com",
        shell_url="https://shell.example.com/",
        base_path="/apps/tasks",
        database_url="postgresql://localhost/tasks",
    ).validate_production()


def test_mcp_rejects_cookie_auth(client):
    token = client.headers.pop("Authorization").removeprefix("Bearer ")
    client.cookies.set("taskwell_session", token)
    assert client.post("/mcp/", json={}).status_code == 401


def test_contract(client):
    spec = client.get("/openapi.json").json()
    assert "/api/v1/tasks" in spec["paths"]
    assert "version" in spec["components"]["schemas"]["TaskPatch"]["required"]


def test_openapi_snapshot_is_current(client):
    snapshot = json.loads((Path(__file__).resolve().parents[2] / "docs/openapi.json").read_text())
    assert client.get("/openapi.json").json() == snapshot, "Run scripts/export_openapi.py to update the snapshot"


def test_tests_never_use_a_development_database():
    assert engine.url.database.startswith(tempfile.gettempdir())


def test_body_limit_applies_without_content_length(client):
    client.headers.pop("Authorization")
    assert client.post("/api/v1/tasks", content=b"a" * (MAX_BODY_BYTES + 1)).status_code == 413

    def chunks():
        for _ in range(3):
            yield b"a" * MAX_BODY_BYTES

    response = client.post("/api/v1/tasks", content=chunks())
    assert response.status_code == 413
    assert "content-length" not in response.request.headers


def run_body_limit(pieces):
    """Drive the middleware with separate network reads, which the test client always joins into one."""
    received, sent, reads = [], [], iter(pieces)

    async def inner(scope, receive, send):
        received.append(await receive())

    async def receive():
        return next(reads)

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "headers": [], "method": "POST", "path": "/"}
    asyncio.run(BodyLimit(inner)(scope, receive, send))
    return received, sent


def test_body_limit_counts_every_read_and_replays_accepted_bodies():
    piece = {"type": "http.request", "body": b"a" * 60_000, "more_body": True}
    last = {"type": "http.request", "body": b"b", "more_body": False}
    received, sent = run_body_limit([piece, piece, last])
    assert not received and sent[0]["status"] == 413
    received, sent = run_body_limit([piece, last])
    assert received == [{"type": "http.request", "body": b"a" * 60_000 + b"b", "more_body": False}] and not sent


def test_rate_limit_uses_the_address_the_proxy_reports(client, monkeypatch):
    client.headers.pop("Authorization")
    monkeypatch.setattr(settings, "client_ip_header", "x-forwarded-for")
    hit = lambda address: client.get("/auth/nothing", headers={"X-Forwarded-For": address}).status_code  # noqa: E731
    assert {hit(f"203.0.113.{i}") for i in range(35)} == {404}
    assert [hit("198.51.100.1") for _ in range(31)][-2:] == [404, 429]
    # A client cannot escape its bucket by sending its own value in front of the proxy's.
    assert hit("1.2.3.4, 198.51.100.1") == 429
    assert hit("198.51.100.2") == 404


def test_rate_limit_falls_back_to_the_connection_address(client):
    client.headers.pop("Authorization")
    codes = [client.get("/auth/nothing", headers={"X-Forwarded-For": f"203.0.113.{i}"}).status_code for i in range(31)]
    assert codes[-2:] == [404, 429]


def test_static_files_are_cached_by_kind(client, monkeypatch, tmp_path):
    client.headers.pop("Authorization")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets/index-abc.js").write_text("js")
    (tmp_path / "sw.js").write_text("worker")
    (tmp_path / "index.html").write_text("<html>")
    monkeypatch.setattr("taskwell.main.static", tmp_path)
    assert client.get("/assets/index-abc.js").headers["cache-control"] == "public, max-age=31536000, immutable"
    assert client.get("/sw.js").headers["cache-control"] == "no-cache"
    for path in ("/", "/today"):
        page = client.get(path)
        assert page.text == "<html>" and page.headers["cache-control"] == "no-cache"
    assert client.get("/assets/index-old.js").status_code == 404


@pytest.mark.parametrize("task_id", ["../projects/abc", "..", "../../me", "a" * 36 + "/complete", "x/" + "a" * 34])
def test_mcp_tools_refuse_crafted_task_ids(task_id):
    for call in (
        mcp_server.delete_task(None, task_id, 1),
        mcp_server.complete_task(None, task_id, 1),
        mcp_server.update_task(None, task_id, 1, {"title": "x"}),
    ):
        with pytest.raises(ValueError, match="task_id"):
            asyncio.run(call)


def test_invalid_references_return_client_errors(client):
    assert client.post("/api/v1/tasks", json={"title": "Blank", "project_id": ""}).status_code == 404
    task = create(client)
    assert client.patch("/api/v1/tasks/" + task["id"], json={"version": 1, "project_id": ""}).status_code == 404
    assert client.get("/%00").status_code == 404


@pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"), reason="Only PostgreSQL rejects NUL characters in text")
def test_postgres_rejections_are_client_errors(client):
    assert client.post("/api/v1/tasks", json={"title": "a\x00b"}).status_code == 422
    assert client.post("/api/v1/projects", json={"name": "a\x00b"}).status_code == 422
    assert client.get("/api/v1/tasks", params={"q": "a\x00b"}).status_code == 422
    assert client.patch("/api/v1/tasks/a%00b", json={"version": 1, "title": "x"}).status_code == 422


def test_label_filter_ignores_case(client):
    create(client, labels=["Work"])
    for label in ("work", "Work", " WORK "):
        assert len(client.get("/api/v1/tasks", params={"label": label}).json()) == 1
    assert client.get("/api/v1/tasks", params={"label": "home"}).json() == []


def test_project_patch_changes_only_what_it_receives(client):
    project = client.post("/api/v1/projects", json={"name": "Before", "color": "#aabbcc"}).json()
    path = "/api/v1/projects/" + project["id"]
    assert client.patch(path, json={"name": "After"}).json()["color"] == "#aabbcc"
    changed = client.patch(path, json={"color": "#112233"}).json()
    assert (changed["name"], changed["color"]) == ("After", "#112233")
    assert client.patch(path, json={}).json()["name"] == "After"
    for bad in ({"name": None}, {"color": None}, {"name": ""}, {"color": "red"}):
        assert client.patch(path, json=bad).status_code == 422


def test_revision_changes_with_every_task_change(workspace):
    client, other, _ = workspace
    revision = lambda headers=None: client.get("/api/v1/tasks/revision", headers=headers).json()["revision"]  # noqa: E731
    previous = [revision()]

    def changed():
        current = revision()
        assert current != previous[0], "The revision should change"
        previous[0] = current
        assert revision() == current, "The revision should be stable without changes"

    project = client.post("/api/v1/projects", json={"name": "Work"}).json()
    task = create(client, project_id=project["id"])
    changed()
    path = "/api/v1/tasks/" + task["id"]
    assert client.patch(path, json={"version": 1, "title": "Edited"}).status_code == 200
    changed()
    assert client.delete("/api/v1/projects/" + project["id"]).status_code == 204
    changed()
    assert client.post(path + "/complete", json={"version": 3}).status_code == 200
    changed()
    assert client.delete(path + "?version=4").status_code == 204
    changed()
    before = revision(other)
    create(client)
    assert revision(other) == before, "Another user's tasks should not change this user's revision"


def test_other_sessions_can_be_listed_and_revoked(workspace):
    client, other, session = workspace
    with session() as db:
        owner = db.scalar(select(User).where(User.apple_sub == "owner"))
        phone_token, phone = issue(db, owner, "native")
        browser_token, browser = issue(db, owner, "web")
    client.post("/api/v1/tokens", json={"name": "Not a session"})
    listed = client.get("/api/v1/sessions").json()
    assert {row["kind"] for row in listed} == {"native", "web"} and len(listed) == 3
    assert [row["current"] for row in listed].count(True) == 1
    assert "digest" not in listed[0]
    assert client.delete("/api/v1/sessions/" + phone.id, headers=other).status_code == 404
    assert client.delete("/api/v1/sessions/" + phone.id).status_code == 204
    assert client.get("/api/v1/me", headers={"Authorization": "Bearer " + phone_token}).status_code == 401
    assert client.get("/api/v1/me", headers={"Authorization": "Bearer " + browser_token}).status_code == 200
    current = next(row for row in client.get("/api/v1/sessions").json() if row["current"])
    assert client.delete("/api/v1/sessions/" + current["id"]).status_code == 422
    token = client.post("/api/v1/tokens", json={"name": "Scoped"}).json()
    scoped = {"Authorization": "Bearer " + token["token"]}
    assert client.get("/api/v1/sessions", headers=scoped).status_code == 403
    assert client.delete("/api/v1/sessions/" + browser.id, headers=scoped).status_code == 403
    assert client.delete("/api/v1/sessions/" + token["id"]).status_code == 404


def test_public_url_and_client_ids_are_normalized():
    assert Settings(public_url="https://tasks.example.com/").public_url == "https://tasks.example.com"
    assert Settings(apple_native_client_ids=" a, b ,,").native_client_ids == ["a", "b"]
    assert Settings(apple_native_client_ids="").native_client_ids == []


def test_mcp_transport_uses_the_configured_public_url():
    assert "localhost:5173" in mcp_server.mcp.settings.transport_security.allowed_hosts
    assert mcp_server.mcp.settings.transport_security.allowed_origins == ["http://localhost:5173"]


def test_production_does_not_publish_api_docs():
    environment = {
        **os.environ,
        "ENVIRONMENT": "production",
        "SECRET_KEY": "x" * 40,
        "PUBLIC_URL": "https://tasks.example.com",
        "DATABASE_URL": "postgresql://localhost/tasks",
        "APPLE_TEAM_ID": "T",
        "APPLE_KEY_ID": "K",
        "APPLE_PRIVATE_KEY": "P",
        "APPLE_WEB_CLIENT_ID": "W",
        "ALLOWED_APPLE_ACCOUNTS": "owner",
    }
    script = "from taskwell.main import app; print(app.docs_url, app.redoc_url, app.openapi_url)"
    result = subprocess.run([sys.executable, "-c", script], env=environment, capture_output=True, text=True)
    assert result.stdout.split() == ["None", "None", "None"], result.stderr


def test_rate_limit_applies_under_the_base_path(client, monkeypatch):
    client.headers.pop("Authorization")
    monkeypatch.setattr(settings, "base_path", "/apps/tasks")
    codes = [client.get("/apps/tasks/auth/nothing").status_code for _ in range(31)]
    assert codes[-1] == 429


def test_body_limit_passes_live_event_streams_through():
    """GET requests with no body reach the app at once, so the event stream is not held back."""
    received, sent = run_body_limit([{"type": "http.request", "body": b"", "more_body": False}])
    assert received == [{"type": "http.request", "body": b"", "more_body": False}] and not sent


def test_rate_limit_counts_only_sign_in_attempts(client):
    client.headers.pop("Authorization")
    for path in ("/auth/logout", "/auth/dev"):
        assert {client.post(path).status_code for _ in range(35)} <= {401, 403, 404}
    assert client.get("/auth/config").status_code == 200
