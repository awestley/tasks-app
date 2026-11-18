from datetime import date, datetime, timezone
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

from .refs import APP, format_ref, parse_ref, safe_web_url
from .scheduling import due_instant, zone_name

# Far from the limits of datetime, so time zone and reminder arithmetic cannot overflow.
MIN_DUE_YEAR, MAX_DUE_YEAR = 1900, 2999


class Model(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid", str_strip_whitespace=True)


class ProjectIn(Model):
    name: str = Field(min_length=1, max_length=100)
    color: str = Field(default="#2563eb", pattern=r"^#[0-9a-fA-F]{6}$")


class ProjectCreate(ProjectIn):
    # Clients may choose the id (a UUID), so an item can be referenced before it reaches the server.
    id: UUID | None = None


class ProjectPatch(Model):
    # Omit a field to keep it. Null is invalid, so these defaults only mark the fields as optional.
    name: str = Field(default=None, min_length=1, max_length=100)
    color: str = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class ProjectOut(ProjectIn):
    id: str

    @computed_field
    @property
    def ref(self) -> str:
        return format_ref(APP, "project", self.id)


class LinkIn(Model):
    """Give a pc:// reference, a web address, or both. A pasted Notebook or Tasks address becomes a reference."""

    ref: str | None = Field(default=None, max_length=500)
    url: str | None = Field(default=None, max_length=2000)
    title: str = Field(default="", max_length=200)

    @model_validator(mode="after")
    def target(self):
        if self.ref is not None and not parse_ref(self.ref):
            raise ValueError("ref must look like pc://app/type/id")
        if self.url is not None and not safe_web_url(self.url):
            raise ValueError("url must use HTTPS, except for localhost")
        if not self.ref and not self.url:
            raise ValueError("Give a ref or a url")
        return self


class LinkOut(Model):
    id: str
    ref: str | None
    title: str
    url: str | None
    created_at: datetime


class ReferenceOut(Model):
    """A task or project that links to a given reference, in the shared resolve shape."""

    ref: str
    type: str
    id: str
    title: str
    completed: bool | None = None
    updated: datetime | None = None
    url: str


class ChecklistItem(Model):
    id: str = Field(default_factory=lambda: str(uuid4()), pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    title: str = Field(min_length=1, max_length=500)
    completed: bool = False


class TaskIn(Model):
    title: str = Field(min_length=1, max_length=500)
    description: str = Field(default="", max_length=10000)
    project_id: str | None = None
    due_date: date | None = None
    due_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    time_zone: str = Field(default="UTC", max_length=100)
    reminder_minutes: int | None = Field(default=None, ge=0, le=10080)
    _zone = field_validator("time_zone")(zone_name)
    priority: int = Field(default=4, ge=1, le=4)
    labels: list[str] = Field(default_factory=list, max_length=20)
    checklist: list[ChecklistItem] = Field(default_factory=list, max_length=100)
    recurrence: Literal["daily", "weekly", "monthly"] | None = None
    alert_style: Literal["notification", "alarm"] = "notification"

    @field_validator("due_date")
    @classmethod
    def plausible_due_date(cls, value):
        if value and not MIN_DUE_YEAR <= value.year <= MAX_DUE_YEAR:
            raise ValueError(f"Use a due date between the years {MIN_DUE_YEAR} and {MAX_DUE_YEAR}")
        return value

    @field_validator("checklist")
    @classmethod
    def unique_checklist_ids(cls, items):
        if len({item.id for item in items}) != len(items):
            raise ValueError("Checklist item IDs must be unique within a task")
        return items

    @field_validator("labels")
    @classmethod
    def clean_labels(cls, values):
        values = list(dict.fromkeys(v.strip().lower() for v in values))
        if any(not v or len(v) > 40 for v in values):
            raise ValueError("Labels must contain 1 to 40 characters")
        return values

    @model_validator(mode="after")
    def recurrence_date(self):
        if self.recurrence and not self.due_date:
            raise ValueError("Recurring tasks need a due date")
        if self.due_time and not self.due_date:
            raise ValueError("A due time needs a due date")
        if self.reminder_minutes is not None and not self.due_time:
            raise ValueError("A reminder needs a due date and time")
        due_instant(self.due_date, self.due_time, self.time_zone)
        return self


class TaskCreate(TaskIn):
    id: UUID | None = None
    # Undoing the delete of a completed task restores it as it was.
    completed: bool = False
    completed_at: datetime | None = None

    @field_validator("completed_at")
    @classmethod
    def stored_as_utc(cls, value):
        if value is None or value.tzinfo is None:
            return value
        try:
            return value.astimezone(timezone.utc).replace(tzinfo=None)
        except OverflowError:
            raise ValueError("Invalid completion time") from None


class TaskPatch(Model):
    version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=10000)
    project_id: str | None = None
    due_date: date | None = None
    due_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    time_zone: str | None = Field(default=None, max_length=100)
    reminder_minutes: int | None = Field(default=None, ge=0, le=10080)
    priority: int | None = Field(default=None, ge=1, le=4)
    labels: list[str] | None = Field(default=None, max_length=20)
    recurrence: Literal["daily", "weekly", "monthly"] | None = None
    completed: bool | None = None
    checklist: list[ChecklistItem] | None = Field(default=None, max_length=100)
    alert_style: Literal["notification", "alarm"] | None = None
    # With completed=false right after completing (the app's Undo): also remove the recurring successor
    # that completion created, if it hasn't been touched since.
    undo: bool | None = None


class ChecklistItemOut(Model):
    id: str
    title: str
    completed: bool


class TaskOut(Model):
    """Describes what is stored. Input rules and time zone data can change, and that must not make tasks unreadable."""

    id: str
    title: str
    description: str
    project_id: str | None
    due_date: date | None
    due_time: str | None
    time_zone: str
    reminder_minutes: int | None
    priority: int
    labels: list[str]
    checklist: list[ChecklistItemOut]
    recurrence: str | None
    alert_style: str = "notification"
    snoozed_until: datetime | None = None
    completed: bool
    completed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    version: int

    @computed_field
    @property
    def ref(self) -> str:
        return format_ref(APP, "task", self.id)


class TaskDetailOut(TaskOut):
    links: list[LinkOut] = []


class SnoozeIn(Model):
    """Remind again after a number of minutes, or at a given time. At most 7 days ahead."""

    minutes: int | None = Field(default=None, ge=1, le=10080)
    until: datetime | None = None

    @model_validator(mode="after")
    def one_choice(self):
        if (self.minutes is None) == (self.until is None):
            raise ValueError("Give either minutes or until")
        if self.until and self.until.tzinfo is None:
            raise ValueError("Include a time zone offset in until")
        return self


class NotificationSettingsIn(Model):
    summary_time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    summary_zone: str = Field(default="UTC", max_length=100)
    _zone = field_validator("summary_zone")(zone_name)
    overdue_minutes: Literal[30, 60, 120, 240] | None = None
    time_sensitive_priority: int = Field(default=1, ge=0, le=2)


class NotificationSettingsOut(Model):
    summary_time: str | None
    summary_zone: str
    overdue_minutes: int | None
    time_sensitive_priority: int


class TaskRevision(Model):
    revision: str


class Version(Model):
    version: int = Field(ge=1)


class TokenIn(Model):
    name: str = Field(min_length=1, max_length=100)


class TokenOut(Model):
    id: str
    name: str
    created_at: datetime
    expires_at: datetime


class SessionOut(Model):
    id: str
    kind: str
    created_at: datetime
    expires_at: datetime
    current: bool


class Profile(Model):
    id: str
    name: str
    email: str
