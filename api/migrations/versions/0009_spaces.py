"""Work and personal spaces. Every project and task belongs to one; existing ones become personal."""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"


def upgrade():
    for table in ("projects", "tasks"):
        op.add_column(table, sa.Column("space", sa.String(10), nullable=False, server_default="personal"))
        op.create_index(f"ix_{table}_space", table, ["space"])


def downgrade():
    for table in ("projects", "tasks"):
        op.drop_index(f"ix_{table}_space", table_name=table)
        op.drop_column(table, "space")
