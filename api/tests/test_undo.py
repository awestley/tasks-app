def make(client, **fields):
    response = client.post("/api/v1/tasks", json={"title": "Water plants", **fields})
    assert response.status_code == 201
    return response.json()


def test_undo_completion_removes_untouched_recurring_successor(client):
    task = make(client, due_date="2026-11-04", recurrence="weekly")
    path = "/api/v1/tasks/" + task["id"]
    assert client.patch(path, json={"version": 1, "completed": True}).status_code == 200
    assert len(client.get("/api/v1/tasks").json()) == 2
    reopened = client.patch(path, json={"version": 2, "completed": False, "undo": True}).json()
    assert reopened["completed"] is False
    assert [t["id"] for t in client.get("/api/v1/tasks").json()] == [task["id"]]
    # Completing again creates a fresh successor.
    assert client.patch(path, json={"version": 3, "completed": True}).status_code == 200
    assert len(client.get("/api/v1/tasks").json()) == 2


def test_undo_keeps_a_successor_that_was_edited_and_plain_reopen_keeps_it(client):
    task = make(client, due_date="2026-11-04", recurrence="daily")
    path = "/api/v1/tasks/" + task["id"]
    client.patch(path, json={"version": 1, "completed": True})
    successor = next(t for t in client.get("/api/v1/tasks").json() if t["id"] != task["id"])
    client.patch("/api/v1/tasks/" + successor["id"], json={"version": 1, "title": "Water the ferns"})
    client.patch(path, json={"version": 2, "completed": False, "undo": True})
    assert len(client.get("/api/v1/tasks").json()) == 2
    other = make(client, due_date="2026-11-04", recurrence="daily")
    other_path = "/api/v1/tasks/" + other["id"]
    client.patch(other_path, json={"version": 1, "completed": True})
    client.patch(other_path, json={"version": 2, "completed": False})
    assert len(client.get("/api/v1/tasks").json()) == 4
