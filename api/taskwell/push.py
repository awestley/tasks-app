"""User-owned endpoints and bounded delivery to Web Push/APNs providers."""

import base64
import hashlib
import json
import time
from datetime import timezone
from urllib.parse import urlsplit

import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import authenticate
from .config import settings
from .db import PushSubscription, get_db
from .schemas import Model

router = APIRouter(prefix="/api/v1/push", tags=["Push"])


def web_ready():
    return bool(settings.vapid_private_key and settings.vapid_public_key and settings.vapid_subject)


def apns_ready():
    return bool(
        settings.apns_private_key
        and settings.apns_key_id
        and settings.apns_team_id
        and settings.apple_native_client_ids
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
            parsed = urlsplit(self.endpoint or "")
            host = parsed.hostname or ""
            allowed = (
                host in {"fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"}
                or host.endswith(".push.apple.com")
                or host.endswith(".notify.windows.com")
            )
            if (
                not allowed
                or parsed.scheme != "https"
                or parsed.username
                or parsed.password
                or parsed.port not in (None, 443)
                or parsed.fragment
            ):
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
            if (
                not self.token
                or not self.topic
                or self.topic not in [v.strip() for v in settings.apple_native_client_ids.split(",")]
            ):
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
    subscription.details = data.model_dump(exclude_none=True)
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


def reminder_tag(task_id, scheduled_for):
    """Notification tag shared with the app's own reminders (web/src/reminders.ts), so a reminder
    delivered both ways shows once."""
    return f"reminder-{task_id}-{int(scheduled_for.replace(tzinfo=timezone.utc).timestamp() * 1000)}"


def send_push(subscription, task, delivery_id, tag=None):
    details = subscription.details
    # Limit payload size. Never include notes, checklist text or credentials.
    title = task.title[:160]
    if subscription.kind == "web":
        from pywebpush import WebPushException, webpush

        endpoint = details["endpoint"]
        if settings.push_simulation_url:
            endpoint = settings.push_simulation_url.rstrip("/") + "/web/" + details.get("token", "send")
        try:
            webpush(
                subscription_info={
                    "endpoint": endpoint,
                    "keys": {"p256dh": details["p256dh"], "auth": details["auth"]},
                },
                data=json.dumps({"title": "Task reminder", "body": title, "task_id": task.id, "tag": tag or delivery_id}),
                vapid_private_key=settings.vapid_private_key.replace("\\n", "\n"),
                vapid_claims={"sub": settings.vapid_subject},
                ttl=3600,
                timeout=10,
                headers={"Urgency": "high", "Topic": delivery_id.replace("-", "")[:32]},
            )
        except WebPushException as error:
            status = error.response.status_code if error.response is not None else 503
            raise DeliveryError(status, status in (404, 410)) from error
    else:
        auth = apns_token()
        host = "https://api.sandbox.push.apple.com" if details["sandbox"] else "https://api.push.apple.com"
        if settings.push_simulation_url:
            host = settings.push_simulation_url.rstrip("/")
        with httpx.Client(http2=True, timeout=10) as client:
            response = client.post(
                host + "/3/device/" + details["token"],
                headers={
                    "authorization": "bearer " + auth,
                    "apns-topic": details["topic"],
                    "apns-push-type": "alert",
                    "apns-priority": "10",
                    "apns-expiration": str(int(time.time()) + 3600),
                    "apns-collapse-id": delivery_id,
                },
                json={
                    "aps": {"alert": {"title": "Task reminder", "body": title}, "sound": "default"},
                    "task_id": task.id,
                },
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
