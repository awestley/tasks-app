"""Snooze, alarm-style reminders, notification settings, and keyed deliveries of several kinds."""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"


def upgrade():
    op.add_column("tasks", sa.Column("snoozed_until", sa.DateTime()))
    op.add_column("tasks", sa.Column("alert_style", sa.String(12), nullable=False, server_default="notification"))
    op.create_table(
        "notification_settings",
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("summary_time", sa.String(5)),
        sa.Column("summary_zone", sa.String(100), nullable=False),
        sa.Column("overdue_minutes", sa.Integer()),
        sa.Column("time_sensitive_priority", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.add_column("reminder_deliveries", sa.Column("kind", sa.String(10), nullable=False, server_default="reminder"))
    op.add_column("reminder_deliveries", sa.Column("key", sa.String(120)))
    deliveries = sa.table(
        "reminder_deliveries",
        sa.column("id", sa.String),
        sa.column("task_id", sa.String),
        sa.column("scheduled_for", sa.DateTime),
        sa.column("key", sa.String),
    )
    connection = op.get_bind()
    # Same format as tasks.db.delivery_key, so a reminder sent just before the upgrade is not sent again.
    for row in connection.execute(sa.select(deliveries.c.id, deliveries.c.task_id, deliveries.c.scheduled_for)).all():
        key = f"reminder:{row.task_id}:{row.scheduled_for.isoformat(timespec='seconds')}"
        connection.execute(deliveries.update().where(deliveries.c.id == row.id).values(key=key))
    with op.batch_alter_table("reminder_deliveries") as batch:
        batch.alter_column("key", existing_type=sa.String(120), nullable=False)
        batch.alter_column("task_id", existing_type=sa.String(36), nullable=True)
        batch.drop_constraint("uq_reminder_delivery", type_="unique")
        batch.create_unique_constraint("uq_reminder_delivery_key", ["subscription_id", "key"])


def downgrade():
    op.execute("DELETE FROM reminder_deliveries WHERE task_id IS NULL")
    with op.batch_alter_table("reminder_deliveries") as batch:
        batch.drop_constraint("uq_reminder_delivery_key", type_="unique")
    # Snooze and follow-up rows can share a time with a reminder; keep one row per time for the old constraint.
    op.execute("DELETE FROM reminder_deliveries WHERE kind != 'reminder'")
    with op.batch_alter_table("reminder_deliveries") as batch:
        batch.alter_column("task_id", existing_type=sa.String(36), nullable=False)
        batch.create_unique_constraint("uq_reminder_delivery", ["task_id", "subscription_id", "scheduled_for"])
        batch.drop_column("key")
        batch.drop_column("kind")
    op.drop_table("notification_settings")
    op.drop_column("tasks", "alert_style")
    op.drop_column("tasks", "snoozed_until")
