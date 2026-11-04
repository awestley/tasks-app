import base64
import os
import uuid
from datetime import datetime, timedelta

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select
from taskwell.config import settings
from taskwell.db import PushSubscription, ReminderDelivery
from taskwell.reminders import tick


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
        "apple_native_client_ids": "com.example.taskwell.ios",
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


@pytest.fixture
def simulation(push_config, monkeypatch):
    url = os.getenv("PUSH_SIMULATION_URL")
    if not url:
        pytest.skip("Start the local Postman push simulation and set PUSH_SIMULATION_URL")
    monkeypatch.setattr(settings, "push_simulation_url", url)
    return push_config


def create_due(client, **changes):
    response = client.post(
        "/api/v1/tasks",
        json={
            "title": "Reminder test",
            "due_date": "2026-10-30",
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
        json={"kind": "apns", "token": token, "topic": "com.example.taskwell.ios", "sandbox": True},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_real_http_apns_and_encrypted_webpush_delivery(workspace, simulation):
    client, _, sessions = workspace
    register_apns(client)
    assert client.post("/api/v1/push/subscriptions", json=simulation).status_code == 201
    create_due(client)
    due = datetime(2026, 10, 30, 18, 45)
    tick(sessions, due - timedelta(seconds=1))
    with sessions() as db:
        assert not db.scalars(select(ReminderDelivery)).all()
    tick(sessions, due)
    tick(sessions, due + timedelta(minutes=1))
    with sessions() as db:
        deliveries = db.scalars(select(ReminderDelivery)).all()
        assert len(deliveries) == 2
        assert [(d.status, d.attempts, d.error) for d in deliveries] == [("sent", 1, None), ("sent", 1, None)]


def test_retry_and_completed_task_cancels_pending_delivery(workspace, simulation):
    client, _, sessions = workspace
    register_apns(client, "ff")
    task = create_due(client)
    due = datetime(2026, 10, 30, 18, 45)
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
    tick(sessions, datetime(2026, 10, 30, 18, 45))
    with sessions() as db:
        assert db.get(PushSubscription, expired["id"]) is None
        delivery = db.scalar(select(ReminderDelivery))
        assert (delivery.status, delivery.error) == ("failed", "Provider HTTP 403")


def test_rescheduled_task_and_active_lease_suppress_delivery(workspace, simulation):
    client, _, sessions = workspace
    subscription = register_apns(client)
    task = create_due(client)
    due = datetime(2026, 10, 30, 18, 45)
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
    assert client.patch("/api/v1/tasks/" + task["id"], json={"version": 1, "due_date": "2026-11-03"}).status_code == 200
    tick(sessions, due + timedelta(minutes=3))
    with sessions() as db:
        assert db.scalar(select(ReminderDelivery)).status == "cancelled"
    assert client.delete("/api/v1/tasks/" + task["id"] + "?version=2").status_code == 204
    with sessions() as db:
        assert not db.scalars(select(ReminderDelivery)).all()
