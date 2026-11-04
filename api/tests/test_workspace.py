from datetime import date

import pytest
from sqlalchemy import select
from taskwell.config import Settings
from taskwell.db import Credential, Project, Task, User
from taskwell.main import next_date


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


def test_mcp_rejects_cookie_auth(client):
    token = client.headers.pop("Authorization").removeprefix("Bearer ")
    client.cookies.set("taskwell_session", token)
    assert client.post("/mcp/", json={}).status_code == 401


def test_contract(client):
    spec = client.get("/openapi.json").json()
    assert "/api/v1/tasks" in spec["paths"]
    assert "version" in spec["components"]["schemas"]["TaskPatch"]["required"]
