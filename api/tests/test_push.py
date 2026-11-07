import base64
import os
import threading
import uuid
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select

from tasks.config import settings
from tasks.db import Challenge, Credential, PushSubscription, ReminderDelivery, Task, now
from tasks.reminders import purge, tick
from tasks.scheduling import reminder_instant

# A task saved after its reminder time never fires, so these dates must stay in the future.
DUE = datetime(2099, 10, 30, 18, 45)


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


@pytest.fixture
def push_config(monkeypatch):
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    # pywebpush expects base64url DER or a filename, rather than a PEM string.
    der = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    for name, value in {
        "apns_private_key": pem,
        "apns_team_id": "TESTTEAM",
        "apns_key_id": "TESTKEY",
        "apple_native_client_ids": "com.example.tasks.ios",
        "vapid_private_key": b64(der),
        "vapid_public_key": b64(public),
        "vapid_subject": "mailto:test@example.com",
    }.items():
        monkeypatch.setattr(settings, name, value)
    return {
        "kind": "web",
        "endpoint": "https://fcm.googleapis.com/fcm/send/test",
        "p256dh": b64(public),
        "auth": b64(os.urandom(16)),
    }


def test_subscription_ownership_validation_idempotence(workspace, push_config):
    client, other, _ = workspace
    response = client.post("/api/v1/push/subscriptions", json=push_config)
    assert response.status_code == 201, response.text
    subscription = response.json()
    assert client.post("/api/v1/push/subscriptions", json=push_config).json()["id"] == subscription["id"]
    assert client.post("/api/v1/push/subscriptions", headers=other, json=push_config).status_code == 409
    assert client.get("/api/v1/push/subscriptions", headers=other).json() == []
    assert client.delete("/api/v1/push/subscriptions/" + subscription["id"], headers=other).status_code == 404
    assert "endpoint" not in client.get("/api/v1/push/subscriptions").text
    for endpoint in [
        "http://127.0.0.1/admin",
        "https://example.com/",
        "https://fcm.googleapis.com.evil.test/",
        "https://fcm.googleapis.com:444/",
    ]:
        assert client.post("/api/v1/push/subscriptions", json={**push_config, "endpoint": endpoint}).status_code == 422
    assert client.post("/api/v1/push/subscriptions", json={**push_config, "p256dh": "bad"}).status_code == 422
    assert (
        client.post(
            "/api/v1/push/subscriptions", json={"kind": "apns", "token": "a" * 64, "topic": "other.app"}
        ).status_code
        == 422
    )
    assert client.delete("/api/v1/push/subscriptions/" + subscription["id"]).status_code == 204


@pytest.mark.parametrize(
    "endpoint",
    [
        # urllib.parse reads these as hosts on a push service; the HTTP client connects elsewhere.
        "https://attacker.example\\.push.apple.com/x",
        "https://fcm.googleapis.com\\@attacker.example/x",
        "https://attacker.example%2f.push.apple.com/x",
        "https://attacker.example\t.push.apple.com/x",
        "https://attacker.example#.push.apple.com/x",
        "https://attacker.example?.push.apple.com/x",
        "https://user@fcm.googleapis.com/x",
        "https://[::1].push.apple.com/x",
        "https://fcm.googleapis.com/x y",
        "https://fcm.googleapis.com/café",
    ],
)
def test_web_endpoints_that_could_reach_another_host_are_rejected(workspace, push_config, endpoint):
    client, _, _ = workspace
    assert client.post("/api/v1/push/subscriptions", json={**push_config, "endpoint": endpoint}).status_code == 422


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://fcm.googleapis.com/fcm/send/abc:DEF-_1",
        "https://fcm.googleapis.com:443/fcm/send/abc",
        "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA-_=",
        "https://web.push.apple.com/QHn_abc",
        "https://wns2-bl2p.notify.windows.com/w/?token=BQYAAAB%2f%3d",
    ],
)
def test_web_endpoints_from_real_push_services_are_accepted(workspace, push_config, endpoint):
    client, _, _ = workspace
    response = client.post("/api/v1/push/subscriptions", json={**push_config, "endpoint": endpoint})
    assert response.status_code == 201, response.text


@pytest.fixture
def redirecting_provider(monkeypatch):
    """A provider that answers everything with a redirect and records each request's path."""
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def answer(self):
            seen.append(self.path)
            self.send_response(302)
            self.send_header("Location", "/redirected")
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_GET = do_POST = answer

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setattr(settings, "push_simulation_url", f"http://127.0.0.1:{server.server_port}")
    yield seen
    server.shutdown()
    server.server_close()


@pytest.fixture
def simulation(push_config, monkeypatch, provider_url):
    # Set PUSH_SIMULATION_URL to use the Postman simulation instead of the in-process fake.
    monkeypatch.setattr(settings, "push_simulation_url", os.getenv("PUSH_SIMULATION_URL") or provider_url)
    return push_config


def create_due(client, **changes):
    response = client.post(
        "/api/v1/tasks",
        json={
            "title": "Reminder test",
            "due_date": "2099-10-30",
            "due_time": "15:00",
            "time_zone": "America/New_York",
            "reminder_minutes": 15,
            **changes,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def register_apns(client, prefix="aa"):
    token = prefix + uuid.uuid4().hex + uuid.uuid4().hex
    response = client.post(
        "/api/v1/push/subscriptions",
        json={"kind": "apns", "token": token, "topic": "com.example.tasks.ios", "sandbox": True},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_real_http_apns_and_encrypted_webpush_delivery(workspace, simulation):
    client, _, sessions = workspace
    register_apns(client)
    assert client.post("/api/v1/push/subscriptions", json=simulation).status_code == 201
    create_due(client)
    due = DUE
    tick(sessions, due - timedelta(seconds=1))
    with sessions() as db:
        assert not db.scalars(select(ReminderDelivery)).all()
    tick(sessions, due)
    tick(sessions, due + timedelta(minutes=1))
    with sessions() as db:
        deliveries = db.scalars(select(ReminderDelivery)).all()
        assert len(deliveries) == 2
        assert [(d.status, d.attempts, d.error) for d in deliveries] == [("sent", 1, None), ("sent", 1, None)]


def test_web_push_does_not_follow_redirects(workspace, push_config, redirecting_provider):
    client, _, sessions = workspace
    assert client.post("/api/v1/push/subscriptions", json=push_config).status_code == 201
    create_due(client)
    tick(sessions, DUE)
    assert redirecting_provider == ["/web/send"]
    with sessions() as db:
        delivery = db.scalar(select(ReminderDelivery))
        assert (delivery.status, delivery.error) == ("pending", "Push transport failed")


def test_stored_web_endpoint_that_fails_the_check_is_removed_without_sending(
    workspace, push_config, redirecting_provider
):
    client, _, sessions = workspace
    subscription = client.post("/api/v1/push/subscriptions", json=push_config).json()
    with sessions() as db:
        # Written directly: a row saved before the check existed can still hold this address.
        row = db.get(PushSubscription, subscription["id"])
        row.details = {**row.details, "endpoint": "https://attacker.example\\.push.apple.com/x"}
        db.commit()
    create_due(client)
    tick(sessions, DUE)
    assert redirecting_provider == []
    with sessions() as db:
        assert db.get(PushSubscription, subscription["id"]) is None


def test_retry_and_completed_task_cancels_pending_delivery(workspace, simulation):
    client, _, sessions = workspace
    register_apns(client, "ff")
    task = create_due(client)
    due = DUE
    tick(sessions, due)
    with sessions() as db:
        delivery = db.scalar(select(ReminderDelivery))
        assert (delivery.status, delivery.attempts, delivery.error) == ("pending", 1, "Provider HTTP 503")
    tick(sessions, due + timedelta(seconds=30))
    with sessions() as db:
        assert db.scalar(select(ReminderDelivery)).attempts == 1
    tick(sessions, due + timedelta(minutes=2))
    with sessions() as db:
        assert db.scalar(select(ReminderDelivery)).status == "sent"
    # A new scheduled time must get its own delivery, then cancellation suppresses a retry.
    with sessions() as db:
        endpoint = db.scalar(select(PushSubscription))
        endpoint.details = {**endpoint.details, "token": "ff" + uuid.uuid4().hex * 2}
        db.commit()
    response = client.patch("/api/v1/tasks/" + task["id"], json={"version": 1, "due_time": "15:15"})
    assert response.status_code == 200
    tick(sessions, due + timedelta(minutes=15))
    assert client.post("/api/v1/tasks/" + task["id"] + "/complete", json={"version": 2}).status_code == 200
    tick(sessions, due + timedelta(minutes=20))
    with sessions() as db:
        assert sorted(d.status for d in db.scalars(select(ReminderDelivery))) == ["cancelled", "sent"]


def test_expired_subscription_cleanup_and_permanent_errors(workspace, simulation):
    client, _, sessions = workspace
    expired = register_apns(client, "ee")
    register_apns(client, "bb")
    create_due(client)
    tick(sessions, DUE)
    with sessions() as db:
        assert db.get(PushSubscription, expired["id"]) is None
        delivery = db.scalar(select(ReminderDelivery))
        assert (delivery.status, delivery.error) == ("failed", "Provider HTTP 403")


def test_rescheduled_task_and_active_lease_suppress_delivery(workspace, simulation):
    client, _, sessions = workspace
    subscription = register_apns(client)
    task = create_due(client)
    due = DUE
    with sessions() as db:
        db.add(
            ReminderDelivery(
                task_id=task["id"],
                subscription_id=subscription["id"],
                scheduled_for=due,
                next_attempt=due,
                lease_until=due + timedelta(minutes=2),
            )
        )
        db.commit()
    tick(sessions, due)
    with sessions() as db:
        assert db.scalar(select(ReminderDelivery)).attempts == 0
    assert client.patch("/api/v1/tasks/" + task["id"], json={"version": 1, "due_date": "2099-11-03"}).status_code == 200
    tick(sessions, due + timedelta(minutes=3))
    with sessions() as db:
        assert db.scalar(select(ReminderDelivery)).status == "cancelled"
    assert client.delete("/api/v1/tasks/" + task["id"] + "?version=2").status_code == 204
    with sessions() as db:
        assert not db.scalars(select(ReminderDelivery)).all()


def statuses(sessions):
    with sessions() as db:
        return sorted(d.status for d in db.scalars(select(ReminderDelivery)))


def test_reminder_instant_is_none_for_values_that_cannot_form_one():
    bad = dict(completed=False, reminder_minutes=5, due_time="00:00")
    assert reminder_instant(SimpleNamespace(due_date=date(1, 1, 1), time_zone="UTC", **bad)) is None
    assert reminder_instant(SimpleNamespace(due_date=date(2099, 1, 1), time_zone="Removed/Zone", **bad)) is None


@pytest.mark.parametrize(
    "fields,instant",
    [
        # The earliest reminder: 7 days before a due time at the far east of the date line.
        (
            {
                "due_date": "2099-11-20",
                "due_time": "00:30",
                "time_zone": "Pacific/Kiritimati",
                "reminder_minutes": 10080,
            },
            datetime(2099, 11, 12, 10, 30),
        ),
        # The latest delivery: 1 day late, for a due time at the far west of the date line.
        (
            {"due_date": "2099-11-20", "due_time": "23:59", "time_zone": "Etc/GMT+12", "reminder_minutes": 0},
            datetime(2099, 11, 22, 11, 59),
        ),
    ],
)
def test_loading_reminders_by_date_keeps_the_extreme_cases(workspace, simulation, fields, instant):
    client, _, sessions = workspace
    register_apns(client)
    assert client.post("/api/v1/tasks", json={"title": "Edge", **fields}).status_code == 201
    tick(sessions, instant)
    assert statuses(sessions) == ["sent"]


def test_purge_removes_only_what_can_no_longer_matter(workspace, simulation):
    client, _, sessions = workspace
    device = register_apns(client)
    task = create_due(client)
    instant = now()
    with sessions() as db:
        total = len(db.scalars(select(Credential)).all())
        owner = db.scalars(select(Credential)).first().user_id
        db.add(
            Credential(user_id=owner, digest="expired", name="Old", kind="web", expires_at=instant - timedelta(days=1))
        )
        db.add(Challenge(id="old", nonce="n", client_id="c", kind="web", expires_at=instant - timedelta(days=1)))
        for name, age in (("old", 31), ("recent", 29)):
            db.add(
                ReminderDelivery(
                    task_id=task["id"],
                    subscription_id=device["id"],
                    scheduled_for=instant - timedelta(days=age),
                    next_attempt=instant,
                    status="sent",
                    error=name,
                )
            )
        db.commit()
    purge(sessions, instant)
    with sessions() as db:
        assert len(db.scalars(select(Credential)).all()) == total
        assert db.get(Challenge, "old") is None
        assert [d.error for d in db.scalars(select(ReminderDelivery))] == ["recent"]
    assert client.get("/api/v1/me").status_code == 200


def test_one_bad_stored_task_does_not_stop_other_reminders(workspace, simulation):
    client, _, sessions = workspace
    register_apns(client)
    owner = client.get("/api/v1/me").json()["id"]
    bad = dict(user_id=owner, due_time="00:00", reminder_minutes=5)
    with sessions() as db:
        # Written directly, as the API now rejects the date and a time zone can disappear from the system.
        db.add(Task(title="Overflow", due_date=date(1, 1, 1), time_zone="UTC", **bad))
        db.add(Task(title="Removed zone", due_date=date(2099, 10, 30), time_zone="Removed/Zone", **bad))
        db.commit()
    create_due(client)
    tick(sessions, DUE)
    assert statuses(sessions) == ["sent"]


def test_reminders_already_past_when_saved_do_not_fire(workspace, simulation):
    client, _, sessions = workspace
    register_apns(client)
    earlier = now() - timedelta(hours=2)
    response = client.post(
        "/api/v1/tasks",
        json={
            "title": "Earlier today",
            "due_date": earlier.date().isoformat(),
            "due_time": earlier.strftime("%H:%M"),
            "time_zone": "UTC",
            "reminder_minutes": 0,
        },
    )
    assert response.status_code == 201, response.text
    tick(sessions)
    assert statuses(sessions) == []
    # Moving it to a time that is still ahead makes it due again.
    later = now() + timedelta(hours=2)
    response = client.patch(
        "/api/v1/tasks/" + response.json()["id"],
        json={"version": 1, "due_date": later.date().isoformat(), "due_time": later.strftime("%H:%M")},
    )
    assert response.status_code == 200, response.text
    tick(sessions, later + timedelta(minutes=1))
    assert statuses(sessions) == ["sent"]


def test_new_device_does_not_receive_reminders_from_before_it_existed(workspace, simulation):
    client, _, sessions = workspace
    first = register_apns(client)
    create_due(client)
    tick(sessions, DUE)
    second = register_apns(client)
    with sessions() as db:
        db.get(PushSubscription, second["id"]).created_at = DUE + timedelta(minutes=5)
        db.commit()
    tick(sessions, DUE + timedelta(minutes=6))
    with sessions() as db:
        deliveries = db.scalars(select(ReminderDelivery)).all()
        assert [(d.subscription_id, d.status) for d in deliveries] == [(first["id"], "sent")]
