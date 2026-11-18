import sqlalchemy as sa
from alembic import context

from tasks.db import Base, engine


def adopt_shell_branch_numbering(connection):
    """Databases created on the shell's branch numbered its migrations differently.

    There, 0004 added users.shell_sub and 0005 the recurrence anchors. Here those are 0008 and 0004,
    and 0005 adds snoozing. Such a database is recognized by shell_sub without the snooze column, and
    restarted after 0003; 0004 and 0008 skip the columns it already has.
    """
    inspector = sa.inspect(connection)
    if "alembic_version" not in inspector.get_table_names():
        return
    version = connection.execute(sa.text("SELECT version_num FROM alembic_version")).scalar()
    users = {c["name"] for c in inspector.get_columns("users")}
    tasks = {c["name"] for c in inspector.get_columns("tasks")}
    if version in {"0004", "0005"} and "shell_sub" in users and "snoozed_until" not in tasks:
        connection.execute(sa.text("UPDATE alembic_version SET version_num = '0003'"))


def run(connection):
    adopt_shell_branch_numbering(connection)
    context.configure(connection=connection, target_metadata=Base.metadata)
    with context.begin_transaction():
        context.run_migrations()


connection = context.config.attributes.get("connection")
if connection is not None:
    run(connection)
else:
    with engine.begin() as connection:
        run(connection)
