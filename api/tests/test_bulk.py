"""Changing and deleting several tasks at once over REST, as selecting tasks in the apps does."""

import pytest


def create(client, path, **fields):
    response = client.post("/api/v1/" + path, json=fields)
    assert response.status_code == 201, response.text
    return response.json()


def target(task):
    return {"task_id": task["id"], "version": task["version"]}


def test_bulk_update_changes_each_and_reports_conflicts(client):
    project = create(client, "projects", name="Home")
    first = create(client, "tasks", title="Paint", labels=["old"])
    second = create(client, "tasks", title="Sand")
    third = create(client, "tasks", title="Prime")
    client.patch(f"/api/v1/tasks/{third['id']}", json={"version": 1, "title": "Prime walls"})
    missing = {"task_id": "00000000-0000-0000-0000-000000000000", "version": 1}
    response = client.patch(
        "/api/v1/tasks",
        json={
            "tasks": [target(first), target(second), target(third), missing],
            "changes": {"project_id": project["id"], "priority": 1, "labels": ["house"]},
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["changed"], body["failed"]) == (2, 2)
    outcomes = {item["task_id"]: item for item in body["results"]}
    assert outcomes[first["id"]] == {"task_id": first["id"], "ok": True, "version": 2, "status": None, "error": None}
    assert outcomes[third["id"]]["status"] == 409 and not outcomes[third["id"]]["ok"]
    assert outcomes[missing["task_id"]]["status"] == 404
    moved = client.get("/api/v1/tasks", params={"project_id": project["id"]}).json()
    assert {t["title"] for t in moved} == {"Paint", "Sand"}
    assert all(t["priority"] == 1 and t["labels"] == ["house"] for t in moved)


def test_bulk_update_completes_moves_to_inbox_and_to_the_other_space(client):
    project = create(client, "projects", name="Garden")
    tasks = [create(client, "tasks", title=f"Weed {n}", project_id=project["id"]) for n in range(2)]
    done = client.patch("/api/v1/tasks", json={"tasks": [target(t) for t in tasks], "changes": {"completed": True}})
    assert done.json()["changed"] == 2
    current = [client.get(f"/api/v1/tasks/{t['id']}").json() for t in tasks]
    assert all(t["completed"] for t in current)
    inbox = client.patch(
        "/api/v1/tasks", json={"tasks": [target(t) for t in current], "changes": {"project_id": None}}
    ).json()
    assert inbox["changed"] == 2
    current = [client.get(f"/api/v1/tasks/{t['id']}").json() for t in tasks]
    assert all(t["project_id"] is None for t in current)
    work = client.patch("/api/v1/tasks", json={"tasks": [target(t) for t in current], "changes": {"space": "work"}})
    assert work.json()["changed"] == 2
    assert {t["title"] for t in client.get("/api/v1/tasks", params={"space": "work"}).json()} == {"Weed 0", "Weed 1"}


def test_bulk_update_reports_a_change_one_task_rejects(client):
    plain = create(client, "tasks", title="No date")
    dated = create(client, "tasks", title="Dated", due_date="2030-01-01")
    response = client.patch(
        "/api/v1/tasks", json={"tasks": [target(plain), target(dated)], "changes": {"due_time": "09:00"}}
    ).json()
    outcomes = {item["task_id"]: item for item in response["results"]}
    assert outcomes[plain["id"]]["status"] == 422 and outcomes[dated["id"]]["ok"]


@pytest.mark.parametrize(
    "body",
    [
        {"tasks": [], "changes": {"priority": 1}},
        {"tasks": [{"task_id": "a", "version": 1}], "changes": {}},
        {"tasks": [{"task_id": "a", "version": 1}], "changes": {"title": "Renamed"}},
        {"tasks": [{"task_id": "a", "version": 1}] * 2, "changes": {"priority": 1}},
        {"tasks": [{"task_id": f"t{i}", "version": 1} for i in range(101)], "changes": {"priority": 1}},
        {"tasks": [{"task_id": "a", "version": 0}], "changes": {"priority": 1}},
    ],
)
def test_bulk_update_rejects_invalid_requests(client, body):
    assert client.patch("/api/v1/tasks", json=body).status_code == 422


def test_bulk_delete_removes_each_and_belongs_to_the_owner(workspace):
    client, other, _ = workspace
    keep = create(client, "tasks", title="Keep")
    gone = [create(client, "tasks", title=f"Remove {n}") for n in range(2)]
    stale = {**target(gone[1]), "version": 5}
    response = client.post("/api/v1/tasks/delete", json={"tasks": [target(gone[0]), stale]})
    assert response.status_code == 200
    body = response.json()
    assert (body["changed"], body["failed"]) == (1, 1)
    assert body["results"][0] == {"task_id": gone[0]["id"], "ok": True, "version": None, "status": None, "error": None}
    assert body["results"][1]["status"] == 409
    # Another account's request cannot see or delete these tasks.
    refused = client.post("/api/v1/tasks/delete", json={"tasks": [target(keep)]}, headers=other).json()
    assert refused["results"][0]["status"] == 404
    titles = {t["title"] for t in client.get("/api/v1/tasks").json()}
    assert titles == {"Keep", "Remove 1"}
