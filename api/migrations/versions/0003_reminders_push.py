"""Task wall times, reminder offsets, and durable push delivery."""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"


def upgrade():
    op.add_column("tasks", sa.Column("due_time", sa.String(5)))
    op.add_column("tasks", sa.Column("time_zone", sa.String(100), nullable=False, server_default="UTC"))
    op.add_column("tasks", sa.Column("reminder_minutes", sa.Integer()))
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("identity", sa.String(64), unique=True, nullable=False),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_push_subscriptions_user_id", "push_subscriptions", ["user_id"])
    op.create_table(
        "reminder_deliveries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("task_id", sa.String(36), sa.ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "subscription_id", sa.String(36), sa.ForeignKey("push_subscriptions.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("scheduled_for", sa.DateTime(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt", sa.DateTime(), nullable=False),
        sa.Column("lease_until", sa.DateTime()),
        sa.Column("error", sa.String(100)),
        sa.UniqueConstraint("task_id", "subscription_id", "scheduled_for", name="uq_reminder_delivery"),
    )
    op.create_index("ix_reminder_deliveries_task_id", "reminder_deliveries", ["task_id"])
    op.create_index("ix_reminder_deliveries_subscription_id", "reminder_deliveries", ["subscription_id"])


def downgrade():
    op.drop_table("reminder_deliveries")
    op.drop_table("push_subscriptions")
    op.drop_column("tasks", "reminder_minutes")
    op.drop_column("tasks", "time_zone")
    op.drop_column("tasks", "due_time")
