import pytest

from tasks.config import settings

NOTE = "pc://notes/note/lx3k2abc123def456"


def make(client, **fields):
    response = client.post("/api/v1/tasks", json={"title": "Plan trip", **fields})
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def notebook(monkeypatch):
    monkeypatch.setattr(settings, "notebook_web_url", "https://notes.example.test")


def test_task_links_add_list_update_and_remove(client, notebook):
    task = make(client)
    assert task["ref"] == "pc://tasks/task/" + task["id"]
    path = f"/api/v1/tasks/{task['id']}/links"
    added = client.post(path, json={"ref": NOTE, "title": "Trip notes"})
    assert added.status_code == 201, added.text
    link = added.json()
    assert link["ref"] == NOTE and link["title"] == "Trip notes"
    assert link["url"] == "https://notes.example.test/#note/lx3k2abc123def456"
    # Linking the same item again refreshes it instead of adding a duplicate.
    again = client.post(path, json={"ref": NOTE, "title": "Itinerary"})
    assert again.status_code == 200 and again.json()["id"] == link["id"]
    assert [item["title"] for item in client.get(path).json()] == ["Itinerary"]
    detail = client.get(f"/api/v1/tasks/{task['id']}").json()
    assert [item["ref"] for item in detail["links"]] == [NOTE]
    # Links do not change the task's version, so they never conflict with an edit on another device.
    assert detail["version"] == 1
    assert client.delete(f"{path}/{link['id']}").status_code == 204
    assert client.delete(f"{path}/{link['id']}").status_code == 404
    assert client.get(path).json() == []


def test_pasted_addresses_become_references(client, notebook):
    task = make(client)
    path = f"/api/v1/tasks/{task['id']}/links"
    note = client.post(path, json={"url": "https://notes.example.test/#note/abc123"}).json()
    assert note["ref"] == "pc://notes/note/abc123" and note["title"] == "Note"
    other = make(client, title="Book flights")
    own = client.post(path, json={"url": f"{settings.public_url}/#task/{other['id']}", "title": "Flights"}).json()
    assert own["ref"] == other["ref"]
    page = client.post(path, json={"url": "https://example.com/visa", "title": "Visa rules"}).json()
    assert page["ref"] is None and page["url"] == "https://example.com/visa"


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"ref": "notes/note/1"},
        {"ref": "pc://Notes/note/1"},
        {"ref": "pc://notes/note/has space"},
        {"url": "javascript:alert(1)"},
        {"url": "http://example.com/plain-http"},
        {"ref": NOTE, "extra": True},
        {"ref": NOTE, "title": "x" * 201},
    ],
)
def test_invalid_links_are_rejected(client, body):
    task = make(client)
    assert client.post(f"/api/v1/tasks/{task['id']}/links", json=body).status_code == 422


def test_links_belong_to_their_owner(workspace):
    client, other, _ = workspace
    task = make(client)
    path = f"/api/v1/tasks/{task['id']}/links"
    link = client.post(path, json={"ref": NOTE, "title": "Notes"}).json()
    assert client.get(path, headers=other).status_code == 404
    assert client.post(path, json={"ref": NOTE}, headers=other).status_code == 404
    assert client.delete(f"{path}/{link['id']}", headers=other).status_code == 404
    assert client.get("/api/v1/references", params={"target": NOTE}, headers=other).json() == []
    ref = "pc://tasks/task/" + task["id"]
    assert client.get("/api/v1/resolve", params={"ref": ref}, headers=other).status_code == 404


def test_references_and_resolve(client):
    task = make(client)
    project = client.post("/api/v1/projects", json={"name": "Travel"}).json()
    assert project["ref"] == "pc://tasks/project/" + project["id"]
    client.post(f"/api/v1/tasks/{task['id']}/links", json={"ref": NOTE, "title": "Notes"})
    client.post(f"/api/v1/projects/{project['id']}/links", json={"ref": NOTE, "title": "Notes"})
    found = client.get("/api/v1/references", params={"target": NOTE}).json()
    assert {(item["type"], item["id"]) for item in found} == {("task", task["id"]), ("project", project["id"])}
    linked_task = next(item for item in found if item["type"] == "task")
    assert linked_task["completed"] is False and linked_task["url"].endswith("/#task/" + task["id"])
    assert client.get("/api/v1/references", params={"target": "not a ref"}).status_code == 422
    resolved = client.get("/api/v1/resolve", params={"ref": project["ref"]}).json()
    assert resolved["title"] == "Travel" and resolved["type"] == "project"
    assert client.get("/api/v1/resolve", params={"ref": NOTE}).status_code == 404


def test_deleting_owners_removes_links_and_recurrence_keeps_them(client):
    task = make(client, due_date="2026-11-20", recurrence="weekly")
    client.post(f"/api/v1/tasks/{task['id']}/links", json={"ref": NOTE, "title": "Notes"})
    client.post(f"/api/v1/tasks/{task['id']}/complete", json={"version": 1})
    found = client.get("/api/v1/references", params={"target": NOTE}).json()
    assert len(found) == 2, "the next occurrence keeps the series' links"
    for item in found:
        current = client.get("/api/v1/tasks/" + item["id"]).json()
        assert client.delete(f"/api/v1/tasks/{item['id']}", params={"version": current["version"]}).status_code == 204
    project = client.post("/api/v1/projects", json={"name": "Travel"}).json()
    client.post(f"/api/v1/projects/{project['id']}/links", json={"ref": NOTE, "title": "Notes"})
    assert client.delete("/api/v1/projects/" + project["id"]).status_code == 204
    assert client.get("/api/v1/references", params={"target": NOTE}).json() == []


def test_link_limit(client):
    task = make(client)
    path = f"/api/v1/tasks/{task['id']}/links"
    for index in range(50):
        assert client.post(path, json={"ref": f"pc://notes/note/n{index}"}).status_code == 201
    assert client.post(path, json={"ref": "pc://notes/note/one-more"}).status_code == 422
