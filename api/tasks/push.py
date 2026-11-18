"""User-owned endpoints and bounded delivery to Web Push/APNs providers."""

import base64
import hashlib
import json
import re
import time
from datetime import UTC, datetime, timezone

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from urllib3.exceptions import LocationParseError
from urllib3.util import parse_url

from .auth import authenticate
from .config import settings
from .db import PushSubscription, get_db
from .schemas import Model

router = APIRouter(prefix="/api/v1/push", tags=["Push"])

WEB_PUSH_HOSTS = {"fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"}
WEB_PUSH_HOST_SUFFIXES = (".push.apple.com", ".notify.windows.com")


def web_ready():
    return bool(settings.vapid_private_key and settings.vapid_public_key and settings.vapid_subject)


def apns_ready():
    return bool(
        settings.apns_private_key and settings.apns_key_id and settings.apns_team_id and settings.native_client_ids
    )


def web_endpoint_allowed(endpoint):
    """Whether a Web Push endpoint is an HTTPS URL on a known push service.

    The URL is read with urllib3 because the HTTP client that sends the push uses it. urllib.parse disagrees on some
    input: with a backslash before ".push.apple.com" it reports a push.apple.com host, but the request goes elsewhere.
    """
    if not endpoint or "\\" in endpoint or not re.fullmatch(r"[!-~]+", endpoint):
        return False
    try:
        url = parse_url(endpoint)
    except LocationParseError:
        return False
    host = url.host or ""
    return bool(
        url.scheme == "https"
        and not url.auth
        and url.port in (None, 443)
        and not url.fragment
        and re.fullmatch(r"[a-z0-9.-]+", host)
        and (host in WEB_PUSH_HOSTS or host.endswith(WEB_PUSH_HOST_SUFFIXES))
    )


class PushConfigOut(Model):
    web_enabled: bool
    vapid_public_key: str | None
    apns_enabled: bool


class SubscriptionOut(Model):
    id: str
    kind: str
    name: str


class SubscriptionIn(Model):
    kind: str = Field(pattern=r"^(web|apns)$")
    name: str = Field(default="This device", min_length=1, max_length=100)
    endpoint: str | None = Field(default=None, max_length=2000)
    p256dh: str | None = Field(default=None, max_length=100)
    auth: str | None = Field(default=None, max_length=30)
    token: str | None = Field(default=None, min_length=32, max_length=512, pattern=r"^[0-9a-fA-F]+$")
    topic: str | None = Field(default=None, max_length=255)
    sandbox: bool = False

    @model_validator(mode="after")
    def validate_destination(self):
        if self.kind == "web":
            if not web_endpoint_allowed(self.endpoint):
                raise ValueError("Unsupported Web Push endpoint")
            try:
                public = base64.urlsafe_b64decode((self.p256dh or "") + "=" * (-len(self.p256dh or "") % 4))
                auth = base64.urlsafe_b64decode((self.auth or "") + "=" * (-len(self.auth or "") % 4))
                from cryptography.hazmat.primitives.asymmetric import ec

                ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public)
                if len(auth) != 16:
                    raise ValueError("Invalid authentication secret")
            except Exception as error:
                raise ValueError("Invalid Web Push encryption keys") from error
            self.token, self.topic, self.sandbox = None, None, False
        else:
            if not self.token or not self.topic or self.topic not in settings.native_client_ids:
                raise ValueError("Invalid APNs token or app identifier")
            self.token = self.token.lower()
            self.endpoint, self.p256dh, self.auth = None, None, None
        return self


@router.get("/config", response_model=PushConfigOut)
def push_config(user=Depends(authenticate)):
    return {
        "web_enabled": web_ready(),
        "vapid_public_key": settings.vapid_public_key if web_ready() else None,
        "apns_enabled": apns_ready(),
    }


@router.get("/subscriptions", response_model=list[SubscriptionOut])
def subscriptions(user=Depends(authenticate), db: Session = Depends(get_db)):
    return [
        {"id": s.id, "kind": s.kind, "name": s.name}
        for s in db.scalars(select(PushSubscription).where(PushSubscription.user_id == user.id))
    ]


@router.post("/subscriptions", response_model=SubscriptionOut, status_code=201)
def subscribe(data: SubscriptionIn, user=Depends(authenticate), db: Session = Depends(get_db)):
    if not (web_ready() if data.kind == "web" else apns_ready()):
        raise HTTPException(503, "Push delivery has not been configured on this server")
    identity = hashlib.sha256(
        f"{data.kind}:{data.endpoint or data.token}:{data.topic}:{data.sandbox}".encode()
    ).hexdigest()
    existing = db.scalar(select(PushSubscription).where(PushSubscription.identity == identity))
    if existing and existing.user_id != user.id:
        raise HTTPException(409, "This device is registered to another account. Disable notifications there first.")
    if not existing and db.query(PushSubscription).filter(PushSubscription.user_id == user.id).count() >= 20:
        raise HTTPException(422, "Remove an old device before adding another (maximum 20)")
    subscription = existing or PushSubscription(user_id=user.id, identity=identity, kind=data.kind)
    subscription.name = data.name
    armed = (existing.details or {}).get("armed") if existing else None
    subscription.details = data.model_dump(exclude_none=True) | ({"armed": armed} if armed else {})
    db.add(subscription)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(409, "Device registration changed. Try again.") from error
    return {"id": subscription.id, "kind": subscription.kind, "name": subscription.name}


@router.delete("/subscriptions/{subscription_id}", status_code=204)
def unsubscribe(subscription_id: str, user=Depends(authenticate), db: Session = Depends(get_db)):
    subscription = db.scalar(
        select(PushSubscription).where(PushSubscription.id == subscription_id, PushSubscription.user_id == user.id)
    )
    if not subscription:
        raise HTTPException(404, "Device not found")
    db.delete(subscription)
    db.commit()


class ArmedAlarm(Model):
    task_id: str = Field(min_length=1, max_length=36)
    at: datetime


class ArmedAlarmsIn(Model):
    alarms: list[ArmedAlarm] = Field(max_length=64)


def armed_value(instant):
    """The stored form of an alarm time: naive UTC to the second, matching delivery times."""
    if instant.tzinfo:
        instant = instant.astimezone(timezone.utc).replace(tzinfo=None)
    return instant.replace(microsecond=0).isoformat()


@router.put("/subscriptions/{subscription_id}/alarms", status_code=204)
def armed_alarms(subscription_id: str, data: ArmedAlarmsIn, user=Depends(authenticate), db: Session = Depends(get_db)):
    """The alarms an iPhone has scheduled with AlarmKit. Their reminders are not also sent to it as notifications."""
    subscription = db.scalar(
        select(PushSubscription).where(PushSubscription.id == subscription_id, PushSubscription.user_id == user.id)
    )
    if not subscription or subscription.kind != "apns":
        raise HTTPException(404, "Device not found")
    armed = [{"task_id": alarm.task_id, "at": armed_value(alarm.at)} for alarm in data.alarms]
    # Assign a new dictionary so the JSON column records the change.
    subscription.details = {**subscription.details, "armed": armed}
    db.commit()


class DeliveryError(Exception):
    def __init__(self, status, invalid=False):
        self.status, self.invalid = status, invalid


_token_cache = None


def apns_token():
    global _token_cache
    identity = (settings.apns_team_id, settings.apns_key_id, settings.apns_private_key)
    timestamp = int(time.time())
    if _token_cache and _token_cache[0] == identity and 0 <= timestamp - _token_cache[1] < 3000:
        return _token_cache[2]
    token = jwt.encode(
        {"iss": settings.apns_team_id, "iat": timestamp},
        settings.apns_private_key.replace("\\n", "\n"),
        algorithm="ES256",
        headers={"kid": settings.apns_key_id},
    )
    _token_cache = (identity, timestamp, token)
    return token


def apns_payload(message):
    """Headers and body for one APNs request."""
    if message.kind == "sync":
        # A background push: no alert, sound or badge, so the system wakes the app to remove stale notifications.
        return {"apns-push-type": "background", "apns-priority": "5"}, {
            "aps": {"content-available": 1},
            "sync": message.sync,
        }
    aps = {
        "alert": {"title": message.title, "body": message.body},
        "sound": "default",
        "thread-id": message.thread,
        "category": message.category,
        "interruption-level": message.level,
        "relevance-score": message.relevance,
        # The notification service extension adds the task's App Intents entity for Siri.
        "mutable-content": 1,
    }
    if message.subtitle:
        aps["alert"]["subtitle"] = message.subtitle
    if message.task_id:
        aps["target-content-id"] = message.task_id
    if message.badge is not None:
        aps["badge"] = message.badge
    if message.level == "passive":
        aps.pop("sound")
    body = {"aps": aps, "kind": message.kind}
    if message.task_id:
        body["task_id"] = message.task_id
    return {"apns-push-type": "alert", "apns-priority": "10" if message.level != "passive" else "5"}, body


def web_payload(message, delivery_id, tag=None):
    return {
        "title": message.title,
        "subtitle": message.subtitle,
        "body": message.body,
        "task_id": message.task_id,
        "kind": message.kind,
        "tag": tag or message.collapse or delivery_id,
        "badge": message.badge,
        "url": message.url,
        "actions": message.kind in ("reminder", "snooze", "overdue"),
    }


def reminder_tag(task_id, scheduled_for):
    """Notification tag shared with the app's own reminders (web/src/reminders.ts), so a reminder
    delivered both ways shows once."""
    return f"reminder-{task_id}-{int(scheduled_for.replace(tzinfo=UTC).timestamp() * 1000)}"


def send_push(subscription, message, delivery_id, tag=None):
    details = subscription.details
    if subscription.kind == "web":
        import requests
        from pywebpush import WebPushException, webpush

        endpoint = details["endpoint"]
        # A row saved before this check existed can hold an address it rejects: remove it without sending.
        if not web_endpoint_allowed(endpoint):
            raise DeliveryError(400, invalid=True)
        if settings.push_simulation_url:
            endpoint = settings.push_simulation_url.rstrip("/") + "/web/" + details.get("token", "send")
        topic = re.sub(r"[^A-Za-z0-9_-]", "", message.collapse or delivery_id)[-32:]
        try:
            with requests.Session() as session:
                # The address was checked above; a redirect could lead anywhere, so it fails the delivery.
                session.max_redirects = 0
                webpush(
                    subscription_info={
                        "endpoint": endpoint,
                        "keys": {"p256dh": details["p256dh"], "auth": details["auth"]},
                    },
                    data=json.dumps(web_payload(message, delivery_id, tag)),
                    vapid_private_key=settings.vapid_private_key.replace("\\n", "\n"),
                    vapid_claims={"sub": settings.vapid_subject},
                    ttl=3600,
                    timeout=10,
                    headers={"Urgency": "normal" if message.level == "passive" else "high", "Topic": topic},
                    requests_session=session,
                )
        except WebPushException as error:
            status = error.response.status_code if error.response is not None else 503
            raise DeliveryError(status, status in (404, 410)) from error
    else:
        auth = apns_token()
        host = "https://api.sandbox.push.apple.com" if details["sandbox"] else "https://api.push.apple.com"
        if settings.push_simulation_url:
            host = settings.push_simulation_url.rstrip("/")
        headers, body = apns_payload(message)
        if message.collapse:
            # Also the notification's identifier on the device, so a snooze or follow-up replaces the earlier one.
            headers["apns-collapse-id"] = message.collapse
        with httpx.Client(http2=True, timeout=10) as client:
            response = client.post(
                host + "/3/device/" + details["token"],
                headers={
                    "authorization": "bearer " + auth,
                    "apns-topic": details["topic"],
                    "apns-expiration": str(int(time.time()) + 3600),
                    **headers,
                },
                json=body,
            )
        if response.status_code != 200:
            try:
                reason = response.json().get("reason")
            except ValueError:
                reason = None
            raise DeliveryError(
                response.status_code,
                response.status_code == 410 or reason in ("BadDeviceToken", "DeviceTokenNotForTopic"),
            )
