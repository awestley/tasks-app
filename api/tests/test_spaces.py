"""Work and personal spaces keep tasks apart."""


def create(client, path, **fields):
    response = client.post("/api/v1/" + path, json=fields)
    assert response.status_code == 201, response.text
    return response.json()


def patch(client, task, **changes):
    response = client.patch(f"/api/v1/tasks/{task['id']}", json={"version": task["version"], **changes})
    assert response.status_code == 200, response.text
    return response.json()


def test_tasks_and_projects_default_to_personal(client):
    assert create(client, "projects", name="Home")["space"] == "personal"
    assert create(client, "tasks", title="Groceries")["space"] == "personal"


def test_lists_filter_by_space(client):
    work = create(client, "projects", name="Launch", space="work")
    home = create(client, "projects", name="Garden")
    create(client, "tasks", title="Email the team", space="work")
    create(client, "tasks", title="Water plants", project_id=home["id"])

    def titles(space):
        return {t["title"] for t in client.get("/api/v1/tasks", params={"space": space}).json()}

    assert titles("work") == {"Email the team"}
    assert titles("personal") == {"Water plants"}
    assert [p["id"] for p in client.get("/api/v1/projects", params={"space": "work"}).json()] == [work["id"]]
    assert client.get("/api/v1/tasks", params={"space": "both"}).status_code == 422


def test_a_task_takes_its_projects_space(client):
    work = create(client, "projects", name="Launch", space="work")
    task = create(client, "tasks", title="Draft plan", project_id=work["id"], space="personal")
    assert task["space"] == "work"
    loose = create(client, "tasks", title="Call back")
    moved = patch(client, loose, project_id=work["id"])
    assert moved["space"] == "work" and moved["project_id"] == work["id"]


def test_changing_only_the_space_leaves_the_project(client):
    work = create(client, "projects", name="Launch", space="work")
    task = create(client, "tasks", title="Book flights", project_id=work["id"])
    moved = patch(client, task, space="personal")
    assert moved["space"] == "personal" and moved["project_id"] is None
    # With both, the project decides.
    back = patch(client, moved, space="personal", project_id=work["id"])
    assert back["space"] == "work"


def test_moving_a_project_moves_its_tasks(client):
    project = create(client, "projects", name="Taxes")
    task = create(client, "tasks", title="Find receipts", project_id=project["id"])
    response = client.patch(f"/api/v1/projects/{project['id']}", json={"space": "work"})
    assert response.status_code == 200 and response.json()["space"] == "work"
    fresh = client.get(f"/api/v1/tasks/{task['id']}").json()
    assert fresh["space"] == "work" and fresh["version"] == task["version"] + 1
    assert client.patch(f"/api/v1/projects/{project['id']}", json={"space": None}).status_code == 422


def test_deleting_a_project_keeps_tasks_in_its_space(client):
    project = create(client, "projects", name="Q3", space="work")
    task = create(client, "tasks", title="Review", project_id=project["id"])
    assert client.delete(f"/api/v1/projects/{project['id']}").status_code == 204
    fresh = client.get(f"/api/v1/tasks/{task['id']}").json()
    assert fresh["project_id"] is None and fresh["space"] == "work"


def test_a_recurring_task_repeats_in_its_space(client):
    task = create(client, "tasks", title="Timesheet", space="work", due_date="2030-01-07", recurrence="weekly")
    response = client.post(f"/api/v1/tasks/{task['id']}/complete", json={"version": task["version"]})
    assert response.status_code == 200
    following = [
        t for t in client.get("/api/v1/tasks", params={"completed": False}).json() if t["title"] == "Timesheet"
    ]
    assert [t["space"] for t in following] == ["work"]
