"""Links from tasks and projects to items in other apps and to web pages."""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"


def upgrade():
    op.create_table(
        "links",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("owner_type", sa.String(10), nullable=False),
        sa.Column("owner_id", sa.String(36), nullable=False),
        sa.Column("ref", sa.String(500)),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("url", sa.String(2000)),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("owner_type", "owner_id", "ref", name="uq_link_owner_ref"),
    )
    op.create_index("ix_links_user_id", "links", ["user_id"])
    op.create_index("ix_links_owner_id", "links", ["owner_id"])
    op.create_index("ix_links_ref", "links", ["ref"])


def downgrade():
    op.drop_table("links")
