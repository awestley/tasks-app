from datetime import date, datetime
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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
    completed: bool
    completed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    version: int


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
