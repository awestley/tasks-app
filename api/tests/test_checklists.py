import pytest


def make(client, **fields):
    response = client.post("/api/v1/tasks", json={"title": "Weekly review", **fields})
    assert response.status_code == 201, response.text
    return response.json()


def test_checklist_create_edit_and_omitted_patch_preserves_items(client):
    task = make(
        client, checklist=[{"title": " Review inbox "}, {"id": "notes", "title": "Write notes", "completed": True}]
    )
    assert task["checklist"][0]["title"] == "Review inbox"
    assert task["checklist"][0]["id"]
    assert task["checklist"][0]["completed"] is False
    path = "/api/v1/tasks/" + task["id"]
    response = client.patch(path, json={"version": 1, "title": "Updated review"})
    assert response.status_code == 200
    assert response.json()["checklist"] == task["checklist"]
    changed = [{**task["checklist"][0], "completed": True, "title": "Process inbox"}]
    response = client.patch(path, json={"version": 2, "checklist": changed})
    assert response.status_code == 200 and response.json()["checklist"] == changed
    assert client.patch(path, json={"version": 2, "checklist": []}).status_code == 409
    assert client.get("/api/v1/tasks").json()[0]["checklist"] == changed
    assert client.patch(path, json={"version": 3, "checklist": []}).json()["checklist"] == []


@pytest.mark.parametrize(
    "items",
    [
        None,
        [{"title": " "}],
        [{"title": "x" * 501}],
        [{"id": "bad/id", "title": "Bad ID"}],
        [{"id": "duplicate", "title": "First"}, {"id": "duplicate", "title": "Second"}],
        [{"title": str(i)} for i in range(101)],
        [{"title": "Extra", "private": True}],
    ],
)
def test_checklist_validation_on_create_and_patch(client, items):
    assert client.post("/api/v1/tasks", json={"title": "Invalid", "checklist": items}).status_code == 422
    task = make(client)
    assert client.patch("/api/v1/tasks/" + task["id"], json={"version": 1, "checklist": items}).status_code == 422
    assert client.get("/api/v1/tasks").json()[0]["version"] == 1


def test_checklist_completion_restore_and_recurring_reset(client):
    task = make(
        client,
        due_date="2026-10-27",
        recurrence="weekly",
        checklist=[{"id": "inbox", "title": "Inbox"}, {"id": "notes", "title": "Notes", "completed": True}],
    )
    path = "/api/v1/tasks/" + task["id"]
    completed = client.post(path + "/complete", json={"version": 1}).json()
    assert all(item["completed"] for item in completed["checklist"])
    tasks = client.get("/api/v1/tasks").json()
    successor = next(t for t in tasks if t["id"] != task["id"])
    assert successor["due_date"] == "2026-11-03"
    assert [i["id"] for i in successor["checklist"]] == ["inbox", "notes"]
    assert not any(i["completed"] for i in successor["checklist"])
    unchecked = [{**i, "completed": False} for i in completed["checklist"]]
    assert client.patch(path, json={"version": 2, "checklist": unchecked}).status_code == 422
    restored = client.patch(path, json={"version": 2, "completed": False}).json()
    assert all(i["completed"] for i in restored["checklist"])
    assert client.patch(path, json={"version": 3, "checklist": unchecked}).status_code == 200
    assert client.post(path + "/complete", json={"version": 4}).status_code == 200
    assert len(client.get("/api/v1/tasks").json()) == 2


def test_last_checkmark_does_not_complete_task_and_other_account_cannot_edit(workspace):
    client, other, _ = workspace
    task = make(client, checklist=[{"id": "one", "title": "Only item"}])
    change = {"version": 1, "checklist": [{"id": "one", "title": "Only item", "completed": True}]}
    path = "/api/v1/tasks/" + task["id"]
    assert client.patch(path, json=change, headers=other).status_code == 404
    response = client.patch(path, json=change)
    assert response.status_code == 200 and response.json()["completed"] is False
