"""Durable per-device delivery with atomic leases and bounded retries, plus periodic cleanup."""

import asyncio
import logging
import time
from datetime import date, timedelta

from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.exc import IntegrityError

from .db import (
    Challenge,
    Credential,
    NotificationSettings,
    PushSubscription,
    ReminderDelivery,
    SessionLocal,
    Task,
    delivery_key,
    now,
    uid,
)
from .notify import TASK_KINDS, summary_message, sync_message, task_message
from .push import DeliveryError, apns_ready, armed_value, reminder_tag, send_push, web_ready
from .scheduling import local_today, notification_instants, summary_instant

log = logging.getLogger(__name__)
PURGE_INTERVAL_SECONDS = 3600
DELIVERY_RETENTION = timedelta(days=30)
# Task notifications can arrive up to a day late after an outage. A summary is only useful close to its time.
LATENESS = {"summary": timedelta(hours=2)}
DEFAULT_LATENESS = timedelta(days=1)


def ready(endpoint):
    return web_ready() if endpoint.kind == "web" else apns_ready()


def armed(endpoint, task, kind, due):
    """Whether this iPhone rings this reminder as an alarm, so it must not also show a notification."""
    if kind not in ("reminder", "snooze") or task.alert_style != "alarm" or endpoint.kind != "apns":
        return False
    wanted = {"task_id": task.id, "at": armed_value(due)}
    return wanted in (endpoint.details or {}).get("armed", [])


def enqueue(db, endpoint, kind, task_id, due, instant, key=None):
    key = key or delivery_key(kind, task_id, due)
    exists = db.scalar(
        select(ReminderDelivery.id).where(ReminderDelivery.subscription_id == endpoint.id, ReminderDelivery.key == key)
    )
    if exists:
        return
    try:
        with db.begin_nested():
            db.add(
                ReminderDelivery(
                    task_id=task_id,
                    subscription_id=endpoint.id,
                    kind=kind,
                    key=key,
                    scheduled_for=due,
                    next_attempt=instant,
                )
            )
            db.flush()
    except IntegrityError:
        pass


def queue_sync(db, user_id, task_id, alarm=False, instant=None):
    """Ask the user's Apple devices to remove a task's delivered notification and refresh alarms.

    Called before the change is committed. Only needed when the task was notified in the last day, or is an alarm.
    """
    if not apns_ready():
        return
    instant = instant or now()
    if not alarm:
        notified = db.scalar(
            select(ReminderDelivery.id)
            .where(
                ReminderDelivery.task_id == task_id,
                ReminderDelivery.kind.in_(TASK_KINDS),
                ReminderDelivery.status == "sent",
                ReminderDelivery.scheduled_for >= instant - DEFAULT_LATENESS,
            )
            .limit(1)
        )
        if not notified:
            return
    endpoints = db.scalars(
        select(PushSubscription).where(PushSubscription.user_id == user_id, PushSubscription.kind == "apns")
    ).all()
    for endpoint in endpoints:
        waiting = db.scalar(
            select(ReminderDelivery.id).where(
                ReminderDelivery.subscription_id == endpoint.id,
                ReminderDelivery.kind == "sync",
                ReminderDelivery.status == "pending",
                ReminderDelivery.key.startswith(f"sync:{task_id}:", autoescape=True),
            )
        )
        if not waiting:
            db.add(
                ReminderDelivery(
                    subscription_id=endpoint.id,
                    kind="sync",
                    key=f"sync:{task_id}:{uid()}",
                    scheduled_for=instant,
                    next_attempt=instant,
                )
            )


def current_message(db, delivery, endpoint, instant):
    """What to send now, or None when the notification no longer applies."""
    if delivery.scheduled_for < instant - LATENESS.get(delivery.kind, DEFAULT_LATENESS):
        return None
    if delivery.kind == "sync":
        return sync_message(delivery.key.split(":")[1])
    preferences = db.get(NotificationSettings, endpoint.user_id)
    if delivery.kind == "summary":
        day = date.fromisoformat(delivery.key.split(":")[1])
        if summary_instant(preferences, day) != delivery.scheduled_for:
            return None
        return summary_message(db, endpoint.user_id, preferences, instant)
    task = db.get(Task, delivery.task_id) if delivery.task_id else None
    if not task or (delivery.kind, delivery.scheduled_for) not in notification_instants(task, preferences):
        return None
    if armed(endpoint, task, delivery.kind, delivery.scheduled_for):
        return None
    return task_message(db, task, delivery.kind, preferences, instant)


def tick(session_factory=SessionLocal, instant=None):
    instant = instant or now()
    with session_factory() as db:
        preferences = {row.user_id: row for row in db.scalars(select(NotificationSettings))}
        devices = {}

        def endpoints(user_id):
            if user_id not in devices:
                devices[user_id] = [
                    e
                    for e in db.scalars(select(PushSubscription).where(PushSubscription.user_id == user_id))
                    if ready(e)
                ]
            return devices[user_id]

        # Reminders are at most 7 days before the due time, follow-ups at most 4 hours after it, delivery at most
        # 1 day late, and a time zone moves a date by at most 1 day. Nothing outside this range can be due.
        window = (instant - timedelta(days=2)).date(), (instant + timedelta(days=8)).date()
        candidates = db.scalars(
            select(Task).where(
                Task.completed.is_(False),
                or_(
                    and_(Task.reminder_minutes.is_not(None), Task.due_date.between(*window)),
                    Task.snoozed_until.between(instant - DEFAULT_LATENESS, instant),
                ),
            )
        ).all()
        for task in candidates:
            for kind, due in notification_instants(task, preferences.get(task.user_id)):
                # Late delivery is allowed for one day after outages, never indefinitely.
                if not instant - DEFAULT_LATENESS <= due <= instant:
                    continue
                # A task saved after this time was already late when it was scheduled, so it was never due.
                if task.updated_at > due:
                    continue
                for endpoint in endpoints(task.user_id):
                    # A device enabled later does not receive what came due before it existed.
                    if endpoint.created_at > due or armed(endpoint, task, kind, due):
                        continue
                    enqueue(db, endpoint, kind, task.id, due, instant)
        for user_id, settings in preferences.items():
            if not settings.summary_time:
                continue
            today = local_today(instant, settings.summary_zone)
            for day in (today - timedelta(days=1), today):
                due = summary_instant(settings, day)
                if due is None or not instant - LATENESS["summary"] <= due <= instant or settings.updated_at > due:
                    continue
                for endpoint in endpoints(user_id):
                    if endpoint.created_at <= due:
                        enqueue(db, endpoint, "summary", None, due, instant, key=f"summary:{day.isoformat()}")
        db.commit()
        ids = db.scalars(
            select(ReminderDelivery.id)
            .where(
                ReminderDelivery.status == "pending",
                ReminderDelivery.next_attempt <= instant,
                or_(ReminderDelivery.lease_until.is_(None), ReminderDelivery.lease_until < instant),
            )
            .order_by(ReminderDelivery.next_attempt)
            .limit(100)
        ).all()
    for delivery_id in ids:
        with session_factory() as db:
            claimed = db.execute(
                update(ReminderDelivery)
                .where(
                    ReminderDelivery.id == delivery_id,
                    ReminderDelivery.status == "pending",
                    ReminderDelivery.next_attempt <= instant,
                    or_(ReminderDelivery.lease_until.is_(None), ReminderDelivery.lease_until < instant),
                )
                .values(lease_until=instant + timedelta(minutes=2), attempts=ReminderDelivery.attempts + 1)
            )
            db.commit()
            if claimed.rowcount != 1:
                continue
            delivery = db.get(ReminderDelivery, delivery_id)
            if delivery is None:
                continue  # The task or device may have been deleted after claiming.
            endpoint = db.get(PushSubscription, delivery.subscription_id)
            message = current_message(db, delivery, endpoint, instant) if endpoint else None
            if message is None:
                delivery.status = "cancelled"
                db.commit()
                continue
            try:
                # A reminder shares its tag with the web app's own reminder (web/src/reminders.ts), so it shows once.
                tag = reminder_tag(delivery.task_id, delivery.scheduled_for) if delivery.kind == "reminder" else None
                send_push(endpoint, message, delivery_id, tag)
                delivery.status = "sent"
                delivery.error = None
            except DeliveryError as error:
                delivery.error = f"Provider HTTP {error.status}"
                if error.invalid:
                    db.delete(endpoint)
                    db.commit()
                    continue
                if error.status in (400, 401, 403, 413) or delivery.attempts >= 8:
                    delivery.status = "failed"
            except Exception:
                # Provider exception strings can contain endpoint credentials.
                delivery.error = "Push transport failed"
                if delivery.attempts >= 8:
                    delivery.status = "failed"
            delivery.lease_until = None
            delivery.next_attempt = instant + timedelta(seconds=min(3600, 30 * 2**delivery.attempts))
            db.commit()


def purge(session_factory=SessionLocal, instant=None):
    instant = instant or now()
    with session_factory() as db:
        db.execute(delete(Credential).where(Credential.expires_at < instant))
        db.execute(delete(Challenge).where(Challenge.expires_at < instant))
        # Deliveries only prevent repeats, and a reminder can no longer fire a day after its time.
        db.execute(delete(ReminderDelivery).where(ReminderDelivery.scheduled_for < instant - DELIVERY_RETENTION))
        db.commit()


async def run(stop):
    last_purge = None
    while not stop.is_set():
        try:
            if web_ready() or apns_ready():
                await asyncio.to_thread(tick)
            if last_purge is None or time.monotonic() - last_purge >= PURGE_INTERVAL_SECONDS:
                await asyncio.to_thread(purge)
                last_purge = time.monotonic()
        except Exception as error:
            # The type only, because provider exception strings can contain endpoint credentials.
            log.error("Background work failed (%s); it will retry", type(error).__name__)
        try:
            await asyncio.wait_for(stop.wait(), timeout=15)
        except TimeoutError:
            pass
