import sqlite3

from alembic import command
from sqlalchemy import create_engine, inspect, text

from tasks.migrations import migration_config, upgrade_local_database


def test_upgrade_fresh_database_and_repeated_start(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "fresh.db"))
    upgrade_local_database(engine)
    upgrade_local_database(engine)
    assert "checklist" in {c["name"] for c in inspect(engine).get_columns("tasks")}
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0005"
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


def test_0005_keys_existing_deliveries_and_downgrades(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "keys.db"))
    config = migration_config()
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0004")
        connection.execute(
            text("INSERT INTO users (id,apple_sub,email,name,created_at) VALUES ('u','a','e','n','2026-10-26')")
        )
        connection.execute(
            text(
                "INSERT INTO tasks (id,user_id,title,description,priority,labels,checklist,completed,created_at,"
                "updated_at,version,time_zone) VALUES ('t','u','T','',4,'[]','[]',0,'2026-10-26','2026-10-26',1,'UTC')"
            )
        )
        connection.execute(text("INSERT INTO push_subscriptions VALUES ('s','u','i','apns','n','{}','2026-10-26')"))
        connection.execute(
            text(
                "INSERT INTO reminder_deliveries (id,task_id,subscription_id,scheduled_for,status,attempts,next_attempt)"
                " VALUES ('d','t','s','2099-10-30 18:45:00.000000','sent',1,'2026-10-26')"
            )
        )
        command.upgrade(config, "0005")
        # The same key the delivery loop computes, so a reminder sent before the upgrade is not sent again.
        assert connection.execute(text("SELECT kind, key FROM reminder_deliveries")).one() == (
            "reminder",
            "reminder:t:2099-10-30T18:45:00",
        )
        assert connection.execute(text("SELECT alert_style FROM tasks")).scalar() == "notification"
        connection.execute(
            text(
                "INSERT INTO reminder_deliveries (id,subscription_id,kind,key,scheduled_for,status,attempts,"
                "next_attempt) VALUES ('sync','s','sync','sync:t:1','2099-10-30 19:00:00','pending',0,'2026-10-26')"
            )
        )
        command.downgrade(config, "0004")
        assert connection.execute(text("SELECT id FROM reminder_deliveries")).scalars().all() == ["d"]
        assert "snoozed_until" not in {c["name"] for c in inspect(connection).get_columns("tasks")}
        command.upgrade(config, "head")
    engine.dispose()
