import sqlite3

from alembic import command
from sqlalchemy import create_engine, inspect, text
from taskwell.migrations import migration_config, upgrade_local_database


def test_upgrade_fresh_database_and_repeated_start(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "fresh.db"))
    upgrade_local_database(engine)
    upgrade_local_database(engine)
    assert "checklist" in {c["name"] for c in inspect(engine).get_columns("tasks")}
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0003"
    engine.dispose()


def test_adopt_original_database_preserves_tasks_and_creates_backup(tmp_path):
    path = tmp_path / "legacy.db"
    engine = create_engine("sqlite:///" + str(path))
    config = migration_config()
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0001")
        connection.execute(text("DROP TABLE alembic_version"))
        connection.execute(
            text(
                "INSERT INTO users (id,apple_sub,email,name,created_at) VALUES ('owner','apple-id','owner@example.test','Owner','2026-10-26')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO tasks (id,user_id,title,description,priority,labels,completed,created_at,updated_at,version) VALUES ('task','owner','Keep my task','Original notes',2,'[\"work\"]',0,'2026-10-26','2026-10-26',7)"
            )
        )
    upgrade_local_database(engine)
    with engine.connect() as connection:
        row = connection.execute(text("SELECT title,description,version,checklist FROM tasks")).one()
        assert tuple(row) == ("Keep my task", "Original notes", 7, "[]")
    backups = list((tmp_path / ".backups").glob("*.sqlite"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as connection:
        assert connection.execute("SELECT title FROM tasks").fetchone()[0] == "Keep my task"
        assert "checklist" not in {r[1] for r in connection.execute("PRAGMA table_info(tasks)")}
    upgrade_local_database(engine)
    assert len(list((tmp_path / ".backups").glob("*.sqlite"))) == 1
    engine.dispose()
