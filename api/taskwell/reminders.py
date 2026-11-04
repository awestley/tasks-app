"""Durable per-device delivery with atomic leases and bounded retries."""

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError

from .db import PushSubscription, ReminderDelivery, SessionLocal, Task, now
from .push import DeliveryError, apns_ready, send_push, web_ready
from .scheduling import reminder_instant

log = logging.getLogger(__name__)


def tick(session_factory=SessionLocal, instant=None):
    instant = instant or now()
    with session_factory() as db:
        candidates = db.scalars(select(Task).where(Task.completed.is_(False), Task.reminder_minutes.is_not(None))).all()
        for task in candidates:
            due = reminder_instant(task)
            # Late delivery is allowed for one day after outages, never indefinitely.
            if due is None or not instant - timedelta(days=1) <= due <= instant:
                continue
            endpoints = db.scalars(select(PushSubscription).where(PushSubscription.user_id == task.user_id)).all()
            for endpoint in endpoints:
                if not (web_ready() if endpoint.kind == "web" else apns_ready()):
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
                send_push(endpoint, task, delivery_id)
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


async def run(stop):
    while not stop.is_set():
        try:
            await asyncio.to_thread(tick)
        except Exception:
            log.error("Reminder delivery cycle failed; it will retry")
        try:
            await asyncio.wait_for(stop.wait(), timeout=15)
        except TimeoutError:
            pass
