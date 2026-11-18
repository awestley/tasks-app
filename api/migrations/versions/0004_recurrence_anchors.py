"""Remember the original day and time of a recurring series."""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"


def upgrade():
    # A database from the shell's branch may already have these columns; see env.py.
    existing = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("tasks")}
    if "recurrence_day" not in existing:
        op.add_column("tasks", sa.Column("recurrence_day", sa.Integer()))
    if "recurrence_time" not in existing:
        op.add_column("tasks", sa.Column("recurrence_time", sa.String(5)))


def downgrade():
    op.drop_column("tasks", "recurrence_time")
    op.drop_column("tasks", "recurrence_day")
