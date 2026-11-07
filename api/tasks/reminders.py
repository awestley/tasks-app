"""Durable per-device delivery with atomic leases and bounded retries, plus periodic cleanup."""

import asyncio
import logging
import time
from datetime import timedelta

from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import IntegrityError

from .db import Challenge, Credential, PushSubscription, ReminderDelivery, SessionLocal, Task, now
from .push import DeliveryError, apns_ready, reminder_tag, send_push, web_ready
from .scheduling import reminder_instant

log = logging.getLogger(__name__)
PURGE_INTERVAL_SECONDS = 3600
DELIVERY_RETENTION = timedelta(days=30)


def tick(session_factory=SessionLocal, instant=None):
    instant = instant or now()
    with session_factory() as db:
        # Reminders are at most 7 days before the due time and at most 1 day late, and a time zone moves a
        # date by at most 1 day. Anything outside this range cannot be due, however long it stays overdue.
        window = (instant - timedelta(days=2)).date(), (instant + timedelta(days=8)).date()
        candidates = db.scalars(
            select(Task).where(
                Task.completed.is_(False), Task.reminder_minutes.is_not(None), Task.due_date.between(*window)
            )
        ).all()
        for task in candidates:
            due = reminder_instant(task)
            # Late delivery is allowed for one day after outages, never indefinitely.
            if due is None or not instant - timedelta(days=1) <= due <= instant:
                continue
            # A task saved after its reminder time was already late when it was scheduled, so it was never due.
            if task.updated_at > due:
                continue
            endpoints = db.scalars(select(PushSubscription).where(PushSubscription.user_id == task.user_id)).all()
            for endpoint in endpoints:
                if not (web_ready() if endpoint.kind == "web" else apns_ready()):
                    continue
                # A device enabled later does not receive what came due before it existed.
                if endpoint.created_at > due:
                    continue
                exists = db.scalar(
                    select(ReminderDelivery.id).where(
                        ReminderDelivery.task_id == task.id,
                        ReminderDelivery.subscription_id == endpoint.id,
                        ReminderDelivery.scheduled_for == due,
                    )
                )
                if exists:
                    continue
                try:
                    with db.begin_nested():
                        db.add(
                            ReminderDelivery(
                                task_id=task.id, subscription_id=endpoint.id, scheduled_for=due, next_attempt=instant
                            )
                        )
                        db.flush()
                except IntegrityError:
                    pass
        db.commit()
        ids = db.scalars(
            select(ReminderDelivery.id)
            .where(
                ReminderDelivery.status == "pending",
                ReminderDelivery.next_attempt <= instant,
                or_(ReminderDelivery.lease_until.is_(None), ReminderDelivery.lease_until < instant),
            )
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
            task = db.get(Task, delivery.task_id)
            endpoint = db.get(PushSubscription, delivery.subscription_id)
            if (
                not task
                or not endpoint
                or reminder_instant(task) != delivery.scheduled_for
                or delivery.scheduled_for < instant - timedelta(days=1)
            ):
                delivery.status = "cancelled"
                db.commit()
                continue
            try:
                send_push(endpoint, task, delivery_id, reminder_tag(task.id, delivery.scheduled_for))
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
