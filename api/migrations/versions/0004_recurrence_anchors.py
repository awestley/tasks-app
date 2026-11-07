"""Remember the original day and time of a recurring series."""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"


def upgrade():
    op.add_column("tasks", sa.Column("recurrence_day", sa.Integer()))
    op.add_column("tasks", sa.Column("recurrence_time", sa.String(5)))


def downgrade():
    op.drop_column("tasks", "recurrence_time")
    op.drop_column("tasks", "recurrence_day")
