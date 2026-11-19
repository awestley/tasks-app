import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    event,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .config import settings


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def uid():
    return str(uuid.uuid4())


def delivery_key(kind, task_id, instant):
    """Identifies one notification for one device, so repeated checks cannot send it twice."""
    return f"{kind}:{task_id}:{instant.isoformat(timespec='seconds')}"


def default_delivery_key(context):
    values = context.get_current_parameters()
    return delivery_key(values.get("kind") or "reminder", values["task_id"], values["scheduled_for"])


url = settings.database_url
if url.startswith("postgres://"):
    url = url.replace("postgres://", "postgresql+psycopg://", 1)
elif url.startswith("postgresql://"):
    url = url.replace("postgresql://", "postgresql+psycopg://", 1)
engine = create_engine(
    url, pool_pre_ping=True, connect_args={"check_same_thread": False} if url.startswith("sqlite") else {}
)
if url.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def sqlite_foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")


SessionLocal = sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    apple_sub: Mapped[str] = mapped_column(String(255), unique=True)
    # The shell's stable user id (the JWT `sub`) when the app runs inside Personal Command. Users created
    # by the shell get a placeholder apple_sub ("shell:<sub>"), which can never match an Apple id.
    shell_sub: Mapped[str | None] = mapped_column(String(255), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(320), default="")
    name: Mapped[str] = mapped_column(String(200), default="My workspace")
    apple_refresh: Mapped[str | None] = mapped_column(Text)
    apple_client_id: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Credential(Base):
    __tablename__ = "credentials"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    digest: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class Challenge(Base):
    __tablename__ = "challenges"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    nonce: Mapped[str] = mapped_column(String(100))
    binding: Mapped[str] = mapped_column(String(64), default="")
    client_id: Mapped[str] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(20))
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str] = mapped_column(String(7), default="#2563eb")
    # "personal" or "work". The apps show one space at a time, and a project's tasks are in its space.
    space: Mapped[str] = mapped_column(String(10), default="personal", server_default="personal", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Task(Base):
    __tablename__ = "tasks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), index=True)
    # "personal" or "work". Always the project's space when the task is in a project.
    space: Mapped[str] = mapped_column(String(10), default="personal", server_default="personal", index=True)
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str] = mapped_column(Text, default="")
    due_date: Mapped[datetime | None] = mapped_column(Date, index=True)
    due_time: Mapped[str | None] = mapped_column(String(5))
    time_zone: Mapped[str] = mapped_column(String(100), default="UTC", server_default="UTC")
    reminder_minutes: Mapped[int | None] = mapped_column(Integer)
    priority: Mapped[int] = mapped_column(Integer, default=4)
    labels: Mapped[list] = mapped_column(JSON, default=list)
    checklist: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    recurrence: Mapped[str | None] = mapped_column(String(20))
    recurrence_day: Mapped[int | None] = mapped_column(Integer)
    recurrence_time: Mapped[str | None] = mapped_column(String(5))
    successor_id: Mapped[str | None] = mapped_column(String(36))
    completed: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    version: Mapped[int] = mapped_column(Integer, default=1)
    # A one-off repeat of the reminder, chosen with Snooze. Cleared when the schedule changes or the task closes.
    snoozed_until: Mapped[datetime | None] = mapped_column(DateTime)
    # "notification" or "alarm". Alarm-style reminders ring as AlarmKit alarms on iPhone.
    alert_style: Mapped[str] = mapped_column(String(12), default="notification", server_default="notification")


class Link(Base):
    """A task or project points at something else: an item in another app (by pc:// reference) or a web page."""

    __tablename__ = "links"
    __table_args__ = (UniqueConstraint("owner_type", "owner_id", "ref", name="uq_link_owner_ref"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # "task" or "project". Polymorphic, so the delete routes remove an owner's links.
    owner_type: Mapped[str] = mapped_column(String(10))
    owner_id: Mapped[str] = mapped_column(String(36), index=True)
    # Canonical reference such as pc://notes/note/<id>, or null for a plain web link.
    ref: Mapped[str | None] = mapped_column(String(500), index=True)
    title: Mapped[str] = mapped_column(String(200))
    url: Mapped[str | None] = mapped_column(String(2000))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class AgentRun(Base):
    """One request to the in-app agent to work on a task, with what it did."""

    __tablename__ = "agent_runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # Kept when the task is deleted, so the record of what happened survives.
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    instruction: Mapped[str] = mapped_column(Text, default="")
    # queued, running, done or failed.
    status: Mapped[str] = mapped_column(String(10), default="queued")
    summary: Mapped[str] = mapped_column(Text, default="")
    actions: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)


def get_db():
    with SessionLocal() as db:
        yield db


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    identity: Mapped[str] = mapped_column(String(64), unique=True)
    kind: Mapped[str] = mapped_column(String(10))
    name: Mapped[str] = mapped_column(String(100))
    details: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class NotificationSettings(Base):
    __tablename__ = "notification_settings"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    summary_time: Mapped[str | None] = mapped_column(String(5))
    summary_zone: Mapped[str] = mapped_column(String(100), default="UTC")
    overdue_minutes: Mapped[int | None] = mapped_column(Integer)
    # Tasks with this priority or more urgent are Time Sensitive. 0 turns it off.
    time_sensitive_priority: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class ReminderDelivery(Base):
    """One notification for one device: a task reminder, snooze or overdue follow-up, a summary, or a sync."""

    __tablename__ = "reminder_deliveries"
    __table_args__ = (UniqueConstraint("subscription_id", "key", name="uq_reminder_delivery_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    # Null for summaries and syncs. A sync names its task in the key, because the task may have been deleted.
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10), default="reminder", server_default="reminder")
    key: Mapped[str] = mapped_column(String(120), default=default_delivery_key)
    subscription_id: Mapped[str] = mapped_column(ForeignKey("push_subscriptions.id", ondelete="CASCADE"), index=True)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt: Mapped[datetime] = mapped_column(DateTime, default=now)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime)
    error: Mapped[str | None] = mapped_column(String(100))
