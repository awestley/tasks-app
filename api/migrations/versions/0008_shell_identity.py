"""Link users to the Personal Command shell's user id (the JWT sub)."""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"


def upgrade():
    # A database from the shell's branch already has this column; see env.py.
    if "shell_sub" in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("users")}:
        return
    op.add_column("users", sa.Column("shell_sub", sa.String(255)))
    op.create_index("ix_users_shell_sub", "users", ["shell_sub"], unique=True)


def downgrade():
    op.drop_index("ix_users_shell_sub", table_name="users")
    op.drop_column("users", "shell_sub")
