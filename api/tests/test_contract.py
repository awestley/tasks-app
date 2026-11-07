"""Personal Command contract: shell sign in, base path, manifest, resolve, search, references, events."""

import asyncio
import json
import time
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from sqlalchemy import delete, select

from tasks import auth, events, main
from tasks.config import Settings, settings
from tasks.db import Credential, User
from tasks.search import SearchError, fold, make_snippet, parse_params, score_match, search_docs

SHELL = "http://shell.test"


def create(client, path="/api/v1/tasks", **fields):
    defaults = {"title": "Write something worthwhile"} if path.endswith("/tasks") else {}
    response = client.post(path, json={**defaults, **fields})
    assert response.status_code in (200, 201), response.text
    return response.json()


@pytest.fixture
def shell(monkeypatch, workspace):
    """Run as an app inside the shell, with the shell's signing key faked."""
    key = ec.generate_private_key(ec.SECP256R1())
    monkeypatch.setattr(settings, "shell_url", SHELL)
    monkeypatch.setattr(settings, "public_url", SHELL)
    monkeypatch.setattr(settings, "base_path", "/apps/tasks")

    class Keys:
        def get_signing_key_from_jwt(self, token):
            return type("Key", (), {"key": key.public_key()})()

    monkeypatch.setattr(auth, "shell_keys", lambda: Keys())

    def sign(sub="owner-sub", **claims):
        now = int(time.time())
        payload = {"iss": SHELL, "aud": "personal-command", "iat": now, "exp": now + 900, "sub": sub, **claims}
        return jwt.encode(payload, key, algorithm="ES256", headers={"kid": "k1"})

    client = workspace[0]
    client.headers.pop("Authorization")
    return client, sign


# Search: the shared cases from westley-app packages/runtime/test/search.test.js.


def test_search_params_validate_and_split_terms():
    for kwargs, code in [
        ({}, "q_required"),
        ({"q": "x" * 201}, "q_too_long"),
        ({"q": "a", "limit": "0"}, "bad_limit"),
        ({"q": "a", "updated_after": "nope"}, "bad_updated_after"),
        ({"q": "a", "updated_after": "0001-01-01T00:00:00+14:00"}, "bad_updated_after"),
        ({"q": "a", "updated_after": "9999-12-31T23:59:59-14:00"}, "bad_updated_after"),
    ]:
        with pytest.raises(SearchError, match=code):
            parse_params(**kwargs)
    params = parse_params(q='Café  "weekly review" café', types="task,BAD,note", limit="500")
    assert params.terms == ["cafe", "weekly review"]
    assert params.types == ["task", "note"]
    assert params.limit == 50


def test_score_ranks_title_over_body_and_needs_every_term():
    t = lambda q: parse_params(q=q).terms  # noqa: E731
    assert score_match(t("rent"), "Rent") == 1
    assert score_match(t("rent"), "Rent due") > score_match(t("rent"), "Pay the rent")
    assert score_match(t("rent"), "Pay the rent") > score_match(t("rent"), "Current")
    assert score_match(t("rent"), "Current") > score_match(t("rent"), "x", "rent is due")
    assert score_match(t("rent landlord"), "Rent", "nothing") == 0
    assert score_match(t("rent landlord"), "Rent", "call the landlord") > 0
    assert score_match(t("a b c"), "a", "xb xc") == 0.533


def test_snippet_centres_on_the_match_and_returns_offsets_not_html():
    body = "filler " * 40 + "the <b>landlord</b> called about rent " + "more " * 40
    snippet = make_snippet(["landlord"], body)
    assert snippet["text"].startswith("…") and snippet["text"].endswith("…")
    assert "<b>landlord</b>" in snippet["text"]
    a, b = snippet["highlights"][0]
    assert fold(snippet["text"][a:b]) == "landlord"
    assert make_snippet(["x"], "") is None
    # Offsets count UTF-16 code units, as the shell slices strings in JavaScript.
    assert make_snippet(["rent"], "🙂 rent")["highlights"] == [[3, 7]]


def test_search_docs_filters_sorts_pages_and_drops_the_body():
    from datetime import datetime, timezone

    docs = [
        {
            "ref": f"pc://t/{'note' if i == 4 else 'task'}/{i}",
            "type": "note" if i == 4 else "task",
            "title": f"Report {i}",
            "body": "quarterly numbers",
            "url": f"/apps/t/#/{i}",
            "updated": datetime(2026, 11, i + 1, tzinfo=timezone.utc),
        }
        for i in range(5)
    ]
    params = parse_params(q="report", types="task", limit="2")
    page1 = search_docs(docs, params)
    assert [i["title"] for i in page1["items"]] == ["Report 3", "Report 2"]
    assert "body" not in page1["items"][0] and page1["items"][0]["updated"] == "2026-11-04T00:00:00.000Z"
    params.cursor = page1["next_cursor"]
    page2 = search_docs(docs, params)
    assert [i["title"] for i in page2["items"]] == ["Report 1", "Report 0"] and page2["next_cursor"] is None
    by_body = search_docs(docs, parse_params(q="quarterly"))
    assert len(by_body["items"]) == 5 and len(by_body["items"][0]["snippet"]["highlights"]) == 1


# The app inside the shell.


def test_shell_token_signs_in_and_keys_data_by_sub(shell):
    client, sign = shell
    assert client.get("/apps/tasks/api/v1/me").status_code == 401
    me = client.get("/apps/tasks/api/v1/me", headers={"Authorization": "Bearer " + sign()})
    assert me.status_code == 200
    again = client.get("/api/v1/me", headers={"Authorization": "Bearer " + sign()})
    assert again.json()["id"] == me.json()["id"]
    other = client.get("/api/v1/me", headers={"Authorization": "Bearer " + sign("someone-else")})
    assert other.json()["id"] != me.json()["id"]
    for bad in (
        sign(exp=int(time.time()) - 120),
        sign(aud="elsewhere"),
        sign(iss="https://attacker.test"),
        jwt.encode({"sub": "x", "iss": SHELL, "aud": "personal-command", "exp": 9e9, "iat": 0}, "s" * 32, "HS256"),
    ):
        assert client.get("/api/v1/me", headers={"Authorization": "Bearer " + bad}).status_code == 401


def test_shell_cookie_needs_the_shell_origin_for_writes(shell):
    client, sign = shell
    client.cookies.set("pc_session", sign())
    assert client.get("/apps/tasks/api/v1/tasks").status_code == 200
    path = "/apps/tasks/api/v1/tasks"
    assert client.post(path, json={"title": "No origin"}).status_code == 403
    assert client.post(path, json={"title": "Wrong"}, headers={"Origin": "https://attacker.test"}).status_code == 403
    assert client.post(path, json={"title": "Shell"}, headers={"Origin": SHELL}).status_code == 201
    # Sign in and sign out belong to the shell.
    assert client.post("/apps/tasks/auth/logout", headers={"Origin": SHELL}).status_code == 400
    assert client.get("/apps/tasks/auth/apple/start", follow_redirects=False).status_code == 404
    assert client.get("/apps/tasks/auth/config").json()["shell"] is True
    client.cookies.clear()


def test_personal_access_tokens_still_work_in_the_shell(shell, workspace):
    client, sign = shell
    bearer = {"Authorization": "Bearer " + sign()}
    token = client.post("/apps/tasks/api/v1/tokens", json={"name": "MCP"}, headers=bearer).json()["token"]
    assert client.get("/apps/tasks/api/v1/me", headers={"Authorization": "Bearer " + token}).status_code == 200


def test_base_path_frames_and_manifest(shell):
    client, sign = shell
    bearer = {"Authorization": "Bearer " + sign()}
    redirect = client.get("/apps/tasks", follow_redirects=False)
    assert redirect.status_code == 308 and redirect.headers["location"] == "/apps/tasks/"
    assert client.get("/health").status_code == 200 and client.get("/apps/tasks/health").status_code == 200
    response = client.get("/apps/tasks/manifest.json", headers=bearer)
    assert "frame-ancestors 'self'" in response.headers["content-security-policy"]
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    manifest = response.json()
    assert manifest["contract"] == 1 and manifest["id"] == "tasks" and manifest["name"] == "Tasks"
    assert manifest["api"] == "/apps/tasks/api/v1" and manifest["embedModule"] == "/apps/tasks/embed.js"
    assert all(p["url"].startswith("/apps/tasks/#/") for p in manifest["panes"])
    assert {e["embed"] for e in manifest["entities"]} == {"tasks-task", "tasks-project"}
    companion = manifest["companion"]
    assert (
        companion["url"] == "/apps/tasks/companion.html#today"
        and companion["badge"] == "/apps/tasks/api/v1/companion/badge"
    )
    assert companion["quickAdd"] in {c["id"] for c in manifest["commands"]}
    assert {p["id"] for p in manifest["panes"]} >= {"today", "inbox", "upcoming", "completed"}
    assert manifest["offline"]["precache"] == ["/apps/tasks/", "/apps/tasks/companion.html", "/apps/tasks/embed.js"]
    assert client.get("/apps/tasks/manifest.json").status_code == 401
    openapi = client.get("/apps/tasks/openapi.json").json()
    assert "/api/v1/resolve" in openapi["paths"] and openapi["servers"][0]["url"] == "/apps/tasks"


def test_standalone_cannot_be_framed(client):
    response = client.get("/health")
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["x-frame-options"] == "DENY"


# Contract endpoints (work the same standalone and in the shell).


def test_read_one_and_client_chosen_ids(workspace):
    client, other, _ = workspace
    project_id, task_id = str(uuid.uuid4()), str(uuid.uuid4())
    project = create(client, "/api/v1/projects", name="Home", id=project_id)
    assert project["id"] == project_id
    task = create(client, id=task_id, project_id=project_id)
    assert task["id"] == task_id
    # Replaying the same create (an offline outbox retrying) returns the task instead of duplicating it.
    replay = client.post("/api/v1/tasks", json={"title": "Write something worthwhile", "id": task_id})
    assert replay.status_code == 200 and replay.json()["version"] == 1
    assert len(client.get("/api/v1/tasks").json()) == 1
    assert client.post("/api/v1/tasks", json={"title": "Taken", "id": task_id}, headers=other).status_code == 409
    assert client.post("/api/v1/tasks", json={"title": "Bad", "id": "not-a-uuid"}).status_code == 422
    assert client.get(f"/api/v1/tasks/{task_id}").json()["title"] == "Write something worthwhile"
    assert client.get(f"/api/v1/projects/{project_id}").json()["name"] == "Home"
    assert client.get(f"/api/v1/tasks/{task_id}", headers=other).status_code == 404


def test_companion_badge_counts_open_tasks_due_today_or_overdue(workspace):
    client = workspace[0]
    assert client.get("/api/v1/companion/badge").json() == {"count": 0, "label": ""}
    create(client, title="Overdue", due_date="2020-01-01")
    create(client, title="Far away", due_date="2999-01-01")
    create(client, title="Someday")
    done = create(client, title="Done", due_date="2020-01-02")
    client.patch(f"/api/v1/tasks/{done['id']}", json={"version": done["version"], "completed": True})
    assert client.get("/api/v1/companion/badge").json() == {"count": 1, "label": "1 due today"}


def test_resolve(workspace):
    client, other, _ = workspace
    project = create(client, "/api/v1/projects", name="Home")
    task = create(client, title="Pay rent", project_id=project["id"], due_date="2026-11-07")
    summary = client.get("/api/v1/resolve", params={"ref": f"pc://tasks/task/{task['id']}"}).json()
    assert summary["title"] == "Pay rent" and summary["type"] == "task" and summary["version"] == 1
    assert summary["subtitle"] == "Due Nov 7 · Home"
    assert summary["url"].endswith(f"/#/task/{task['id']}") and summary["updated"].endswith("Z")
    project_summary = client.get("/api/v1/resolve", params={"ref": f"pc://tasks/project/{project['id']}"}).json()
    assert project_summary["title"] == "Home" and project_summary["subtitle"] == "1 open task"
    for ref in (f"pc://notes/task/{task['id']}", "pc://tasks/task/missing", "nonsense"):
        assert client.get("/api/v1/resolve", params={"ref": ref}).status_code == 404
    assert client.get("/api/v1/resolve", params={"ref": summary["ref"]}, headers=other).status_code == 404


def test_search_endpoint(workspace):
    client, other, _ = workspace
    create(client, title="Pay rent", description="Call the landlord first")
    create(client, title="Buy groceries", checklist=[{"title": "Café beans"}])
    create(client, "/api/v1/projects", name="Rental flat")
    assert client.get("/api/v1/search").json() == {"error": "q_required"}
    assert client.get("/api/v1/search", params={"q": "a", "limit": "x"}).status_code == 422
    rent = client.get("/api/v1/search", params={"q": "rent"}).json()
    assert [(i["title"], i["score"]) for i in rent["items"]] == [("Rental flat", 0.9), ("Pay rent", 0.8)]
    assert rent["next_cursor"] is None
    landlord = client.get("/api/v1/search", params={"q": "rent landlord"}).json()["items"]
    assert len(landlord) == 1 and landlord[0]["snippet"]["text"] == "Call the landlord first"
    assert client.get("/api/v1/search", params={"q": "cafe"}).json()["items"][0]["title"] == "Buy groceries"
    only = client.get("/api/v1/search", params={"q": "rent", "types": "project"}).json()["items"]
    assert [i["type"] for i in only] == ["project"]
    paged = client.get("/api/v1/search", params={"q": "rent", "limit": 1}).json()
    assert len(paged["items"]) == 1 and paged["next_cursor"]
    rest = client.get("/api/v1/search", params={"q": "rent", "limit": 1, "cursor": paged["next_cursor"]}).json()
    assert rest["items"][0]["title"] == "Pay rent"
    later = client.get("/api/v1/search", params={"q": "rent", "updated_after": "2999-01-01T00:00:00Z"}).json()
    assert later["items"] == []
    assert client.get("/api/v1/search", params={"q": "rent"}, headers=other).json()["items"] == []


def test_references(workspace):
    client, other, _ = workspace
    linked = create(client, title="Prepare", description="See [[note:2024-meeting]] first")
    create(client, title="Embeds", description="Agenda:\n![[note:2024-meeting|Meeting]]")
    create(client, title="Full", description="pc://notes/note/2024-meeting")
    create(client, title="Similar", description="[[note:2024-meeting-2]] and pc://notes/note/2024-meeting-2")
    items = client.get("/api/v1/references", params={"target": "pc://notes/note/2024-meeting"}).json()["items"]
    assert sorted(i["title"] for i in items) == ["Embeds", "Full", "Prepare"]
    by_task = create(client, title="Parent", description=f"Blocked by [[task:{linked['id']}]]")
    items = client.get("/api/v1/references", params={"target": f"pc://tasks/task/{linked['id']}"}).json()["items"]
    assert [i["ref"] for i in items] == [f"pc://tasks/task/{by_task['id']}"]
    assert client.get("/api/v1/references", params={"target": "bad"}).json() == {"items": []}
    target = {"target": "pc://notes/note/2024-meeting"}
    assert client.get("/api/v1/references", params=target, headers=other).json() == {"items": []}


def test_changes_are_published(workspace):
    client, _, session = workspace
    received = []

    async def listen():
        user_id = client.get("/api/v1/me").json()["id"]
        entry = events.subscribe(user_id)
        loop = asyncio.get_running_loop()
        task = await loop.run_in_executor(None, create, client)
        changed = await loop.run_in_executor(
            None, lambda: client.patch(f"/api/v1/tasks/{task['id']}", json={"version": 1, "completed": True})
        )
        assert changed.status_code == 200
        await loop.run_in_executor(None, lambda: client.delete(f"/api/v1/tasks/{task['id']}?version=2"))
        for _ in range(3):
            received.append(json.loads(await asyncio.wait_for(entry[1].get(), 2)))
        events.unsubscribe(user_id, entry)
        return task

    task = asyncio.run(listen())
    ref = f"pc://tasks/task/{task['id']}"
    assert received == [
        {"ref": ref, "kind": "updated", "version": 1},
        {"ref": ref, "kind": "updated", "version": 2},
        {"ref": ref, "kind": "deleted", "version": None},
    ]


def test_events_stream(client):
    with client.stream("GET", "/api/v1/events") as response:
        assert response.headers["content-type"].startswith("text/event-stream")
        lines = response.iter_lines()
        assert next(lines) == ": connected"
        task = create(client)
        while (line := next(lines)) == "":
            pass
        assert json.loads(line.removeprefix("data: ")) == {
            "ref": f"pc://tasks/task/{task['id']}",
            "kind": "updated",
            "version": 1,
        }


def test_events_stream_ends_with_its_session(workspace):
    client, _, session = workspace
    token = client.headers["Authorization"].removeprefix("Bearer ")
    with session() as db:
        owner = db.scalar(select(User).where(User.apple_sub == "owner"))
        other_device, _ = auth.issue(db, owner, "native")
    with client.stream("GET", "/api/v1/events") as response:
        lines = response.iter_lines()
        assert next(lines) == ": connected"
        with session() as db:
            db.execute(delete(Credential).where(Credential.digest == auth.digest(token)))
            db.commit()
        # Another device's change reaches the stream, which ends instead of passing it on.
        written = client.post(
            "/api/v1/tasks",
            json={"title": "After the session ended"},
            headers={"Authorization": "Bearer " + other_device},
        )
        assert written.status_code == 201
        assert [line for line in lines if line.startswith("data:")] == []


def test_a_shell_token_counts_for_a_stream_only_until_it_expires():
    alive = SimpleNamespace(kind="shell", id=None, expires=time.time() + 60)
    expired = SimpleNamespace(kind="shell", id=None, expires=time.time() - auth.SHELL_LEEWAY - 1)
    assert auth.still_signed_in(None, alive)
    assert not auth.still_signed_in(None, expired)


def test_revision_can_be_worked_out_from_the_tasks(client):
    # web/src/store.ts compares this with its own copy, to skip downloading what it already has.
    assert client.get("/api/v1/tasks/revision").json()["revision"] == "0:"
    create(client)
    create(client, title="Another")
    tasks = client.get("/api/v1/tasks").json()
    latest = max(task["updated_at"] for task in tasks)
    assert client.get("/api/v1/tasks/revision").json()["revision"] == f"{len(tasks)}:{latest}"


def test_search_survives_an_absurd_cursor_and_refuses_an_absurd_date(client):
    create(client, title="Findable")
    assert client.get("/api/v1/search", params={"q": "findable", "cursor": "o" + "z" * 5000}).status_code == 200
    assert client.get("/api/v1/search", params={"q": "findable", "cursor": "o" + "z" * 30}).status_code == 200
    response = client.get("/api/v1/search", params={"q": "findable", "updated_after": "0001-01-01T00:00:00+14:00"})
    assert (response.status_code, response.json()) == (422, {"error": "bad_updated_after"})


def test_production_publishes_the_api_description_only_inside_the_shell():
    assert main.openapi_path(Settings(environment="production", shell_url="https://shell.example")) == "/openapi.json"
    assert main.openapi_path(Settings(environment="production", shell_url="")) is None
    assert main.openapi_path(Settings(environment="development", shell_url="")) == "/openapi.json"


def test_several_first_requests_for_a_shell_user_share_one_user(workspace, monkeypatch):
    _, _, session = workspace
    with session() as db:
        first = auth.shell_user(db, {"sub": "new-sub"}).id
    with session() as db:
        real, calls = db.scalar, []

        def scalar(query):
            # As if another request created the user just after this one looked.
            calls.append(query)
            return None if len(calls) == 1 else real(query)

        monkeypatch.setattr(db, "scalar", scalar)
        assert auth.shell_user(db, {"sub": "new-sub"}).id == first
        assert len(calls) == 2


def test_unreachable_shell_keys_do_not_look_like_a_signed_out_session(shell, monkeypatch):
    client, sign = shell

    class Unreachable:
        def get_signing_key_from_jwt(self, token):
            raise jwt.PyJWKClientConnectionError("unreachable")

    monkeypatch.setattr(auth, "shell_keys", lambda: Unreachable())
    response = client.get("/apps/tasks/api/v1/me", headers={"Authorization": "Bearer " + sign()})
    assert response.status_code == 503


def test_mcp_credentials_are_checked_off_the_event_loop(client, monkeypatch):
    checked = []

    def check(request, db):
        try:
            asyncio.get_running_loop()
            checked.append("on the loop")
        except RuntimeError:
            checked.append("off the loop")
        raise HTTPException(401, "Refused")

    monkeypatch.setattr(main, "authenticate", check)
    assert client.post("/mcp/").status_code == 401
    assert checked == ["off the loop"]


def test_summaries_show_the_year_only_outside_this_one(client):
    year = datetime.now(timezone.utc).year
    for due, shown in [(f"{year}-06-15", "Due Jun 15"), (f"{year + 1}-06-15", f"Due Jun 15, {year + 1}")]:
        task = create(client, due_date=due, time_zone="UTC")
        resolved = client.get("/api/v1/resolve", params={"ref": f"pc://tasks/task/{task['id']}"}).json()
        assert resolved["subtitle"] == shown + " · Inbox"
