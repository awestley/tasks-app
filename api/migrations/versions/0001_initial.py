"""Initial Taskwell schema."""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None


def upgrade():
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("apple_sub", sa.String(255), nullable=False, unique=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("apple_refresh", sa.Text),
        sa.Column("apple_client_id", sa.String(255)),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_table(
        "credentials",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("expires_at", sa.DateTime, nullable=False),
    )
    op.create_index("ix_credentials_user_id", "credentials", ["user_id"])
    op.create_table(
        "challenges",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("nonce", sa.String(100), nullable=False),
        sa.Column("binding", sa.String(64), nullable=False),
        sa.Column("client_id", sa.String(255), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("expires_at", sa.DateTime, nullable=False),
    )
    op.create_table(
        "projects",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("color", sa.String(7), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_index("ix_projects_user_id", "projects", ["user_id"])
    op.create_table(
        "tasks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", sa.String(36), sa.ForeignKey("projects.id", ondelete="SET NULL")),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("due_date", sa.Date),
        sa.Column("priority", sa.Integer, nullable=False),
        sa.Column("labels", sa.JSON, nullable=False),
        sa.Column("recurrence", sa.String(20)),
        sa.Column("successor_id", sa.String(36)),
        sa.Column("completed", sa.Boolean, nullable=False),
        sa.Column("completed_at", sa.DateTime),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
    )
    for column in ("user_id", "project_id", "due_date", "completed"):
        op.create_index("ix_tasks_" + column, "tasks", [column])


def downgrade():
    for table in ("tasks", "projects", "challenges", "credentials", "users"):
        op.drop_table(table)
