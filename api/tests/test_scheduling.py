from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest

from taskwell.db import Task
from taskwell.quick_add import parse_task
from taskwell.scheduling import due_instant, reminder_instant

ZONE = "America/New_York"
TUESDAY = datetime(2026, 10, 27, 14, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "text,title,day,clock",
    [
        ("Order Pizza Friday Afternoon", "Order Pizza", "2026-10-30", "15:00"),
        ("Order Pizza on Friday at noon", "Order Pizza", "2026-10-30", "12:00"),
        ("Call mom tomorrow at 10am", "Call mom", "2026-10-28", "10:00"),
        ("Read tonight", "Read", "2026-10-27", "19:00"),
        ("Lunch next Monday noon", "Lunch", "2026-11-02", "12:00"),
        ("Pay rent 2026-11-01 at 09:30", "Pay rent", "2026-11-01", "09:30"),
        ("Review in 2 days", "Review", "2026-10-29", None),
        ("Stretch at 9am", "Stretch", "2026-10-28", "09:00"),
        ("Read tomorrow morning", "Read", "2026-10-28", "09:00"),
    ],
)
def test_english_entry(text, title, day, clock):
    result = parse_task(text, ZONE, instant=TUESDAY)
    assert (result.title, str(result.due_date), result.due_time) == (title, day, clock)
    assert result.reminder_minutes == (0 if clock else None)


def test_parse_metadata_and_non_destructive_fallback():
    result = parse_task(
        "Review every week Friday afternoon p1 @work #Work remind me 15 minutes before",
        ZONE,
        projects=[SimpleNamespace(id="mine", name="Work")],
        instant=TUESDAY,
    )
    assert result.title == "Review"
    assert (result.priority, result.project_id, result.labels, result.recurrence, result.reminder_minutes) == (
        1,
        "mine",
        ["work"],
        "weekly",
        15,
    )
    for text in ["Buy bread", "Friday afternoon", "Review remind me 15 minutes before", "Buy 2026-02-30 tickets"]:
        result = parse_task(text, ZONE, instant=TUESDAY)
        assert result.title == text
        assert not result.recognized


def test_timezone_and_dst():
    # Same instant is still Monday in Los Angeles and Tuesday in Tokyo.
    instant = datetime(2026, 10, 27, 2, tzinfo=timezone.utc)
    assert str(parse_task("Call tomorrow", "America/Los_Angeles", instant=instant).due_date) == "2026-10-27"
    assert str(parse_task("Call tomorrow", "Asia/Tokyo", instant=instant).due_date) == "2026-10-28"
    assert due_instant(date(2026, 11, 1), "01:30", ZONE) == datetime(2026, 11, 1, 5, 30)
    with pytest.raises(ValueError, match="does not exist"):
        due_instant(date(2027, 3, 14), "02:30", ZONE)


def test_parser_route_is_read_only_and_owns_project_lookup(workspace):
    client, other, _ = workspace
    project = client.post("/api/v1/projects", json={"name": "Secret"}).json()
    result = client.post("/api/v1/tasks/parse", json={"text": "Pizza Friday afternoon #Secret", "time_zone": ZONE})
    assert result.status_code == 200
    assert result.json()["project_id"] == project["id"]
    result = client.post(
        "/api/v1/tasks/parse", headers=other, json={"text": "Pizza Friday afternoon #Secret", "time_zone": ZONE}
    )
    assert result.json()["project_id"] is None and "#Secret" in result.json()["title"]
    assert client.get("/api/v1/tasks").json() == []
    assert (
        client.post("/api/v1/tasks/parse", json={"text": "Pizza tomorrow", "time_zone": "Fake/Zone"}).status_code == 422
    )


@pytest.mark.parametrize(
    "fields",
    [
        {"due_time": "15:00"},
        {"reminder_minutes": 0},
        {"time_zone": "Fake/Zone"},
        {"due_date": "2026-10-30", "due_time": "25:00"},
        {"due_date": "2027-03-14", "due_time": "02:30", "time_zone": ZONE},
        {"due_date": "2026-10-30", "due_time": "15:00", "reminder_minutes": -1},
    ],
)
def test_invalid_schedules_rejected(client, fields):
    assert client.post("/api/v1/tasks", json={"title": "Test", **fields}).status_code == 422


def test_reminder_patch_conflict_and_recurrence_across_dst(client):
    task = client.post(
        "/api/v1/tasks",
        json={
            "title": "Review",
            "due_date": "2026-10-30",
            "due_time": "15:00",
            "time_zone": ZONE,
            "reminder_minutes": 15,
            "recurrence": "weekly",
        },
    ).json()
    assert reminder_instant(SimpleNamespace(**{**task, "due_date": date.fromisoformat(task["due_date"])})) == datetime(
        2026, 10, 30, 18, 45
    )
    path = "/api/v1/tasks/" + task["id"]
    assert client.patch(path, json={"version": 1, "title": "Weekly review"}).status_code == 200
    assert client.patch(path, json={"version": 1, "reminder_minutes": None}).status_code == 409
    assert client.post(path + "/complete", json={"version": 2}).status_code == 200
    successor = next(t for t in client.get("/api/v1/tasks").json() if t["id"] != task["id"])
    assert successor["due_date"] == "2026-11-06" and successor["due_time"] == "15:00"
    assert reminder_instant(
        SimpleNamespace(**{**successor, "due_date": date.fromisoformat(successor["due_date"])})
    ) == datetime(2026, 11, 6, 19, 45)
    assert (
        client.patch("/api/v1/tasks/" + successor["id"], json={"version": 1, "reminder_minutes": None}).json()[
            "reminder_minutes"
        ]
        is None
    )


def test_recurring_spring_gap_moves_forward(client):
    task = client.post(
        "/api/v1/tasks",
        json={
            "title": "Daily",
            "due_date": "2027-03-13",
            "due_time": "02:30",
            "time_zone": ZONE,
            "reminder_minutes": 0,
            "recurrence": "daily",
        },
    ).json()
    assert client.post("/api/v1/tasks/" + task["id"] + "/complete", json={"version": 1}).status_code == 200
    successor = next(t for t in client.get("/api/v1/tasks").json() if t["id"] != task["id"])
    assert (successor["due_date"], successor["due_time"]) == ("2027-03-14", "03:30")
    # The shift applies to that date only. The series keeps its original time.
    assert client.post("/api/v1/tasks/" + successor["id"] + "/complete", json={"version": 1}).status_code == 200
    following = next(t for t in client.get("/api/v1/tasks", params={"completed": False}).json())
    assert (following["due_date"], following["due_time"]) == ("2027-03-15", "02:30")


def complete_open_task(client):
    task = client.get("/api/v1/tasks", params={"completed": False}).json()[0]
    assert (
        client.post("/api/v1/tasks/" + task["id"] + "/complete", json={"version": task["version"]}).status_code == 200
    )
    return client.get("/api/v1/tasks", params={"completed": False}).json()[0]


def test_monthly_series_keeps_its_day_after_a_short_month(client):
    client.post("/api/v1/tasks", json={"title": "Rent", "due_date": "2027-01-31", "recurrence": "monthly"})
    assert [complete_open_task(client)["due_date"] for _ in range(4)] == [
        "2027-02-28",
        "2027-03-31",
        "2027-04-30",
        "2027-05-31",
    ]


def test_choosing_a_new_date_or_time_starts_a_new_series(client):
    client.post(
        "/api/v1/tasks",
        json={
            "title": "Rent",
            "due_date": "2027-01-31",
            "due_time": "09:00",
            "time_zone": ZONE,
            "recurrence": "monthly",
        },
    )
    february = complete_open_task(client)
    assert february["due_date"] == "2027-02-28"
    # An unrelated edit keeps the series.
    assert client.patch("/api/v1/tasks/" + february["id"], json={"version": 1, "title": "Pay rent"}).status_code == 200
    march = complete_open_task(client)
    assert march["due_date"] == "2027-03-31"
    response = client.patch(
        "/api/v1/tasks/" + march["id"], json={"version": 1, "due_date": "2027-03-15", "due_time": "10:00"}
    )
    assert response.status_code == 200
    april = complete_open_task(client)
    assert (april["due_date"], april["due_time"]) == ("2027-04-15", "10:00")


def test_extreme_due_years_are_rejected(client):
    for day in ("0001-01-01", "1899-12-31", "3000-01-01", "9999-12-31"):
        response = client.post(
            "/api/v1/tasks",
            json={
                "title": "Test",
                "due_date": day,
                "due_time": "00:00",
                "time_zone": "Asia/Tokyo",
                "reminder_minutes": 5,
            },
        )
        assert response.status_code == 422, day


def test_stored_task_that_no_longer_validates_stays_readable_and_fixable(workspace):
    client, _, sessions = workspace
    owner = client.get("/api/v1/me").json()["id"]
    with sessions() as db:
        # 02:30 does not exist on this date, as if a time zone rule change had created the gap after saving.
        broken = Task(user_id=owner, title="Gap", due_date=date(2027, 3, 14), due_time="02:30", time_zone=ZONE)
        db.add(broken)
        db.commit()
    tasks = client.get("/api/v1/tasks")
    assert tasks.status_code == 200 and tasks.json()[0]["due_time"] == "02:30"
    path = "/api/v1/tasks/" + broken.id
    response = client.patch(path, json={"version": 1, "title": "Still a gap"})
    assert response.status_code == 422 and "does not exist" in response.json()["detail"]
    response = client.patch(path, json={"version": 1, "due_time": "03:30"})
    assert response.status_code == 200 and response.json()["due_time"] == "03:30"


def quick_add_cases():
    import json
    from pathlib import Path

    data = json.loads((Path(__file__).parent / "quick_add_cases.json").read_text())
    projects = [SimpleNamespace(**p) for p in data["projects"]]
    instant = datetime.fromisoformat(data["now"])
    return [(case, data["zone"], projects, instant) for case in data["cases"]]


@pytest.mark.parametrize(
    "case,zone,projects,instant", quick_add_cases(), ids=lambda v: v["text"] if isinstance(v, dict) else ""
)
def test_shared_quick_add_cases(case, zone, projects, instant):
    # The web app runs the same cases against web/src/parse.ts (web/tests/unit/parse.test.ts).
    result = parse_task(case["text"], zone, projects=projects, instant=instant)
    got = {
        "title": result.title,
        "due_date": str(result.due_date) if result.due_date else None,
        "due_time": result.due_time,
        "recurrence": result.recurrence,
        "priority": result.priority,
        "labels": result.labels,
        "project": result.project_id,
        "reminder_minutes": result.reminder_minutes,
    }
    want = {
        "title": case["title"],
        "due_date": case.get("due_date"),
        "due_time": case.get("due_time"),
        "recurrence": case.get("recurrence"),
        "priority": case.get("priority"),
        "labels": case.get("labels", []),
        "project": case.get("project"),
        "reminder_minutes": case.get("reminder_minutes"),
    }
    assert got == want
