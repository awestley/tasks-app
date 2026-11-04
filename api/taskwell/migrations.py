"""Local schema upgrades, including adoption of the original development database."""

import sqlite3
import time
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect

from .db import engine

LEGACY_COLUMNS = {
    "users": "id apple_sub email name apple_refresh apple_client_id created_at",
    "credentials": "id user_id digest name kind created_at expires_at",
    "challenges": "id nonce binding client_id kind expires_at",
    "projects": "id user_id name color created_at",
    "tasks": "id user_id project_id title description due_date priority labels recurrence successor_id completed completed_at created_at updated_at version",
}


def migration_config():
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
    return config


def upgrade_local_database(target=engine):
    inspector = inspect(target)
    tables = set(inspector.get_table_names())
    config = migration_config()
    legacy = bool(tables) and "alembic_version" not in tables
    if legacy:
        if tables != set(LEGACY_COLUMNS) or any(
            {c["name"] for c in inspector.get_columns(table)} != set(columns.split())
            for table, columns in LEGACY_COLUMNS.items()
        ):
            raise RuntimeError(
                "Unversioned database does not match the original Taskwell schema. Back it up and migrate explicitly."
            )
        if target.dialect.name != "sqlite":
            raise RuntimeError("Back up and stamp the unversioned PostgreSQL database explicitly before upgrading.")
        database = target.url.database
        if database and database != ":memory:":
            source = Path(database).resolve()
            backup_folder = source.parent / ".backups"
            backup_folder.mkdir(mode=0o700, exist_ok=True)
            backup = backup_folder / f"{source.stem}-before-0002-{time.time_ns()}.sqlite"
            backup.touch(mode=0o600, exist_ok=False)
            with sqlite3.connect(source) as origin, sqlite3.connect(backup) as destination:
                origin.backup(destination)
    with target.begin() as connection:
        config.attributes["connection"] = connection
        if legacy:
            command.stamp(config, "0001")
        command.upgrade(config, "head")
