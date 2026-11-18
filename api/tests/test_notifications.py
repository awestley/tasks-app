"""Snooze, follow-ups, summaries, payload contents, alarm suppression and sync pushes."""

import os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import fake_providers
import pytest
from sqlalchemy import select
from test_push import DUE, create_due, push_config, register_apns, simulation  # noqa: F401

from tasks.db import ReminderDelivery, Task, now
from tasks.notify import Message, timing
from tasks.push import web_payload
from tasks.reminders import tick

# DUE is the reminder time: 15 minutes before 15:00 in New York.
DUE_TIME = DUE + timedelta(minutes=15)


@pytest.fixture
def pushes(simulation):  # noqa: F811
    if os.getenv("PUSH_SIMULATION_URL"):
        pytest.skip("Payload checks need the in-process provider")
    fake_providers.pushes.clear()
    return fake_providers.pushes


def deliveries(sessions, kind=None):
    with sessions() as db:
        query = select(ReminderDelivery).order_by(ReminderDelivery.scheduled_for)
        if kind:
            query = query.where(ReminderDelivery.kind == kind)
        return [(d.kind, d.scheduled_for, d.status) for d in db.scalars(query)]


def alerts(pushes):
    return [p for p in pushes if p["headers"].get("apns-push-type") == "alert"]


def save_settings(client, **values):
    response = client.put("/api/v1/notifications/settings", json=values)
    assert response.status_code == 200, response.text
    return response.json()


def test_get_single_task_is_owner_only(workspace):
    client, other, _ = workspace
    task = client.post("/api/v1/tasks", json={"title": "One"}).json()
    response = client.get("/api/v1/tasks/" + task["id"])
    assert response.status_code == 200
    assert response.json()["alert_style"] == "notification"
    assert response.json()["snoozed_until"] is None
    assert client.get("/api/v1/tasks/" + task["id"], headers=other).status_code == 404


def test_settings_defaults_validation_and_ownership(workspace):
    client, other, _ = workspace
    assert client.get("/api/v1/notifications/settings").json() == {
        "summary_time": None,
        "summary_zone": "UTC",
        "overdue_minutes": None,
        "time_sensitive_priority": 1,
    }
    saved = save_settings(
        client, summary_time="08:00", summary_zone="Europe/London", overdue_minutes=60, time_sensitive_priority=2
    )
    assert saved["overdue_minutes"] == 60
    assert client.get("/api/v1/notifications/settings").json() == saved
    assert client.get("/api/v1/notifications/settings", headers=other).json()["summary_time"] is None
    for bad in (
        {"summary_time": "8:00"},
        {"summary_zone": "Nowhere/Zone"},
        {"overdue_minutes": 45},
        {"time_sensitive_priority": 3},
    ):
        assert client.put("/api/v1/notifications/settings", json=bad).status_code == 422


def test_snooze_validation(workspace):
    client, other, _ = workspace
    task = create_due(client)
    path = "/api/v1/tasks/" + task["id"] + "/snooze"
    assert client.post(path, json={}).status_code == 422
    assert client.post(path, json={"minutes": 5, "until": "2099-01-01T00:00:00Z"}).status_code == 422
    assert client.post(path, json={"until": "2099-01-01T00:00:00"}).status_code == 422
    assert client.post(path, json={"until": "2000-01-01T00:00:00Z"}).status_code == 422
    assert client.post(path, json={"minutes": 10081}).status_code == 422
    assert client.post(path, json={"minutes": 15}, headers=other).status_code == 404
    snoozed = client.post(path, json={"minutes": 15})
    assert snoozed.status_code == 200, snoozed.text
    assert snoozed.json()["version"] == 2
    assert snoozed.json()["snoozed_until"]
    assert client.post("/api/v1/tasks/" + task["id"] + "/complete", json={"version": 2}).status_code == 200
    assert client.get("/api/v1/tasks/" + task["id"]).json()["snoozed_until"] is None
    assert client.post(path, json={"minutes": 15}).status_code == 422


def snooze_to(sessions, task_id, instant):
    """Snoozing uses the real clock, so tests move the stored time to the year 2099."""
    with sessions() as db:
        db.get(Task, task_id).snoozed_until = instant
        db.commit()


def test_snooze_is_delivered_once_and_cleared_by_rescheduling(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    task = create_due(client)
    tick(sessions, DUE)
    later = DUE + timedelta(minutes=30)
    snooze_to(sessions, task["id"], later)
    tick(sessions, later - timedelta(seconds=1))
    tick(sessions, later)
    tick(sessions, later + timedelta(minutes=1))
    assert deliveries(sessions) == [("reminder", DUE, "sent"), ("snooze", later, "sent")]
    sent = alerts(pushes)
    # The snooze replaces the reminder on the device instead of adding a second notification.
    assert [p["headers"]["apns-collapse-id"] for p in sent] == ["task-" + task["id"]] * 2
    assert sent[1]["payload"]["kind"] == "snooze"
    # Rescheduling clears a snooze.
    snooze_to(sessions, task["id"], later + timedelta(hours=1))
    version = client.get("/api/v1/tasks/" + task["id"]).json()["version"]
    assert (
        client.patch("/api/v1/tasks/" + task["id"], json={"version": version, "due_time": "18:00"}).status_code == 200
    )
    assert client.get("/api/v1/tasks/" + task["id"]).json()["snoozed_until"] is None


def test_snooze_without_a_due_date_or_reminder(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    task = client.post("/api/v1/tasks", json={"title": "Call back"}).json()
    snooze_to(sessions, task["id"], DUE)
    tick(sessions, DUE)
    assert deliveries(sessions) == [("snooze", DUE, "sent")]
    assert alerts(pushes)[0]["payload"]["aps"]["alert"]["body"] == "Snoozed"


def test_overdue_follow_up_once_per_occurrence(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    save_settings(client, overdue_minutes=60)
    create_due(client)
    follow_up = DUE_TIME + timedelta(minutes=60)
    for instant in (DUE, follow_up - timedelta(seconds=1), follow_up, follow_up + timedelta(minutes=5)):
        tick(sessions, instant)
    assert deliveries(sessions) == [("reminder", DUE, "sent"), ("overdue", follow_up, "sent")]
    overdue = alerts(pushes)[-1]["payload"]
    assert overdue["aps"]["alert"]["body"] == "Overdue since 15:00"
    assert overdue["aps"]["relevance-score"] == pytest.approx(0.45)
    # A completed task gets no follow-up.
    second = create_due(client, due_date="2099-10-31")
    assert client.post("/api/v1/tasks/" + second["id"] + "/complete", json={"version": 1}).status_code == 200
    tick(sessions, follow_up + timedelta(days=1))
    assert [d for d in deliveries(sessions, "overdue")] == [("overdue", follow_up, "sent")]


def test_snooze_past_the_follow_up_replaces_it(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    save_settings(client, overdue_minutes=30)
    task = create_due(client)
    snooze_to(sessions, task["id"], DUE_TIME + timedelta(hours=2))
    tick(sessions, DUE_TIME + timedelta(minutes=30))
    assert deliveries(sessions, "overdue") == []


def test_follow_up_needs_a_reminder(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    save_settings(client, overdue_minutes=30)
    create_due(client, reminder_minutes=None)
    tick(sessions, DUE_TIME + timedelta(minutes=30))
    assert deliveries(sessions) == []


def test_payload_grouping_urgency_and_badge(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    project = client.post("/api/v1/projects", json={"name": "Home"}).json()
    urgent = create_due(client, title="Pay rent", project_id=project["id"], priority=1)
    create_due(client, title="Water plants", priority=3)
    client.post("/api/v1/tasks", json={"title": "Earlier", "due_date": "2099-10-29"})
    tick(sessions, DUE)
    sent = {p["payload"]["task_id"]: p for p in alerts(pushes)}
    rent = sent[urgent["id"]]
    aps = rent["payload"]["aps"]
    assert aps["alert"] == {"title": "Pay rent", "subtitle": "Home", "body": "Due 15:00"}
    assert aps["thread-id"] == project["id"]
    assert aps["category"] == "TASK_REMINDER"
    assert aps["interruption-level"] == "time-sensitive"
    assert aps["relevance-score"] == 1.0
    assert aps["mutable-content"] == 1
    assert aps["target-content-id"] == urgent["id"]
    # Two due today and one overdue, in the tasks' own time zones.
    assert aps["badge"] == 3
    assert rent["headers"]["apns-priority"] == "10"
    plants = next(p for p in sent.values() if p is not rent)["payload"]["aps"]
    assert (plants["thread-id"], plants["interruption-level"], plants["relevance-score"]) == ("inbox", "active", 0.5)
    assert "subtitle" not in plants["alert"]


def test_time_sensitive_follows_the_setting(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    save_settings(client, time_sensitive_priority=0)
    create_due(client, priority=1)
    tick(sessions, DUE)
    assert alerts(pushes)[0]["payload"]["aps"]["interruption-level"] == "active"


def test_summary_at_local_time_and_skipped_when_empty(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    save_settings(client, summary_time="08:00", summary_zone="America/New_York")
    winter = datetime(2099, 1, 15, 13, 0)  # 08:00 EST
    tick(sessions, winter)
    assert deliveries(sessions, "summary") == [("summary", winter, "cancelled")]
    client.post("/api/v1/tasks", json={"title": "Today", "due_date": "2099-07-15"})
    client.post("/api/v1/tasks", json={"title": "Late", "due_date": "2099-07-10"})
    summer = datetime(2099, 7, 15, 12, 0)  # 08:00 EDT
    tick(sessions, summer - timedelta(seconds=1))
    tick(sessions, summer)
    tick(sessions, summer + timedelta(minutes=1))
    assert deliveries(sessions, "summary")[-1] == ("summary", summer, "sent")
    payload = alerts(pushes)[-1]
    aps = payload["payload"]["aps"]
    assert aps["alert"] == {"title": "Today", "body": "1 due today, 1 overdue"}
    assert (aps["interruption-level"], aps["thread-id"], aps["category"], aps["badge"]) == (
        "passive",
        "summary",
        "TASK_SUMMARY",
        2,
    )
    assert "sound" not in aps and "task_id" not in payload["payload"]
    assert payload["headers"]["apns-priority"] == "5"
    # Too late to be useful: more than two hours after the time.
    tick(sessions, datetime(2099, 7, 16, 14, 1))
    assert len(deliveries(sessions, "summary")) == 2


def test_summary_moves_past_a_spring_forward_gap(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    zone = ZoneInfo("America/New_York")
    day = next(
        date(2099, 3, d)
        for d in range(1, 32)
        if datetime(2099, 3, d, 12, tzinfo=zone).utcoffset() != datetime(2099, 3, 1, 12, tzinfo=zone).utcoffset()
    )
    client.post("/api/v1/tasks", json={"title": "Due", "due_date": day.isoformat()})
    save_settings(client, summary_time="02:30", summary_zone="America/New_York")
    instant = datetime(day.year, day.month, day.day, 7, 30)  # 03:30 EDT
    tick(sessions, instant)
    assert deliveries(sessions, "summary") == [("summary", instant, "sent")]


def test_armed_alarm_suppresses_only_that_device(workspace, pushes):
    client, other, sessions = workspace
    phone = register_apns(client)
    mac = register_apns(client)
    task = create_due(client, alert_style="alarm")
    path = "/api/v1/push/subscriptions/" + phone["id"] + "/alarms"
    assert (
        client.put(path, json={"alarms": [{"task_id": task["id"], "at": "2099-10-30T14:45:00-04:00"}]}).status_code
        == 204
    )
    assert client.put(path, headers=other, json={"alarms": []}).status_code == 404
    assert client.put(path, json={"alarms": [{"task_id": "x", "at": "2099-01-01T00:00:00Z"}] * 65}).status_code == 422
    # Registering the same device again keeps its alarms.
    with sessions() as db:
        from tasks.db import PushSubscription

        token = db.get(PushSubscription, phone["id"]).details["token"]
    again = client.post(
        "/api/v1/push/subscriptions",
        json={"kind": "apns", "token": token, "topic": "com.example.tasks.ios", "sandbox": True},
    )
    assert again.json()["id"] == phone["id"]
    tick(sessions, DUE)
    with sessions() as db:
        rows = db.scalars(select(ReminderDelivery).where(ReminderDelivery.kind == "reminder")).all()
        assert [(r.subscription_id, r.status) for r in rows] == [(mac["id"], "sent")]


def test_sync_push_after_completing_a_notified_task(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    notified = create_due(client)
    quiet = create_due(client, due_date="2099-11-20")
    tick(sessions, DUE)
    assert client.post("/api/v1/tasks/" + quiet["id"] + "/complete", json={"version": 1}).status_code == 200
    assert deliveries(sessions, "sync") == []
    assert client.post("/api/v1/tasks/" + notified["id"] + "/complete", json={"version": 1}).status_code == 200
    # Editing again before the sync goes out does not queue a second one.
    assert client.patch("/api/v1/tasks/" + notified["id"], json={"version": 2, "completed": False}).status_code == 200
    assert len(deliveries(sessions, "sync")) == 1
    # Syncs are queued at the real time, unlike the reminders above.
    tick(sessions, now() + timedelta(seconds=1))
    assert [status for *_, status in deliveries(sessions, "sync")] == ["sent"]
    background = [p for p in pushes if p["headers"]["apns-push-type"] == "background"]
    assert background[0]["payload"] == {"aps": {"content-available": 1}, "sync": [notified["id"]]}
    assert background[0]["headers"]["apns-priority"] == "5"


def test_sync_survives_deleting_the_task(workspace, pushes):
    client, _, sessions = workspace
    register_apns(client)
    task = create_due(client, alert_style="alarm")
    assert len(deliveries(sessions, "sync")) == 1
    tick(sessions, now() + timedelta(seconds=1))
    assert client.delete("/api/v1/tasks/" + task["id"] + "?version=1").status_code == 204
    tick(sessions, now() + timedelta(seconds=1))
    assert [status for *_, status in deliveries(sessions, "sync")] == ["sent", "sent"]


def test_web_payload_and_timing_text():
    message = Message(
        kind="reminder", title="T", subtitle="Home", body="Due 15:00", task_id="abc", collapse="task-abc", badge=2
    )
    data = web_payload(message, "delivery")
    assert data["tag"] == "task-abc" and data["actions"] is True and data["badge"] == 2
    assert web_payload(Message(kind="summary", title="Today", body="1 due today"), "d")["actions"] is False

    class Stub:
        due_date = date(2099, 10, 30)
        due_time = "15:00"
        time_zone = "America/New_York"

    assert timing(Stub, "reminder", DUE_TIME - timedelta(days=1)) == "Due tomorrow 15:00"
    assert timing(Stub, "reminder", DUE_TIME - timedelta(days=3)) == "Due Fri 15:00"
    assert timing(Stub, "reminder", DUE_TIME - timedelta(days=20)) == "Due Oct 30 15:00"
    assert timing(Stub, "reminder", DUE_TIME + timedelta(minutes=1)) == "Due now"
    assert timing(Stub, "overdue", DUE_TIME + timedelta(days=1)) == "Overdue since yesterday 15:00"
    assert timing(Stub, "overdue", DUE_TIME + timedelta(days=3)) == "Overdue since Oct 30 15:00"
