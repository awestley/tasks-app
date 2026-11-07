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


def test_a_completed_task_can_be_restored_as_it_was(client):
    restored = make(client, completed=True, completed_at="2026-01-02T03:04:05")
    assert restored["completed"] is True and restored["completed_at"] == "2026-01-02T03:04:05"
    assert (
        make(client, completed=True, completed_at="2026-01-02T03:04:05+01:00")["completed_at"] == "2026-01-02T02:04:05"
    )
    assert make(client, completed=True)["completed_at"]
    assert make(client, completed_at="2026-01-02T03:04:05")["completed_at"] is None
    too_early = {"title": "Water plants", "completed": True, "completed_at": "0001-01-01T00:00:00+14:00"}
    assert client.post("/api/v1/tasks", json=too_early).status_code == 422
