"""Add ordered task checklists without changing existing tasks."""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"


def upgrade():
    op.add_column("tasks", sa.Column("checklist", sa.JSON(), nullable=False, server_default="[]"))


def downgrade():
    op.drop_column("tasks", "checklist")
