import atexit
import os
import shutil
import tempfile

# Configure the app before importing it. Starting the app applies migrations to DATABASE_URL and starts the
# reminder worker when push is configured, so tests must not inherit a developer's .env or environment.
ISOLATED_DIRECTORY = tempfile.mkdtemp(prefix="tasks-tests-")
atexit.register(shutil.rmtree, ISOLATED_DIRECTORY, ignore_errors=True)
os.environ.update(
    ENVIRONMENT="development",
    DATABASE_URL=f"sqlite:///{ISOLATED_DIRECTORY}/startup.db",
    PUBLIC_URL="http://localhost:5173",
    DEV_LOGIN="false",
    ALLOWED_APPLE_ACCOUNTS="",
    CLIENT_IP_HEADER="",
    SHELL_URL="",
    SHELL_JWKS_URL="",
    BASE_PATH="",
    APPLE_TEAM_ID="",
    APPLE_KEY_ID="",
    APPLE_PRIVATE_KEY="",
    APPLE_WEB_CLIENT_ID="",
    APPLE_NATIVE_CLIENT_IDS="",
    VAPID_PUBLIC_KEY="",
    VAPID_PRIVATE_KEY="",
    VAPID_SUBJECT="",
    APNS_TEAM_ID="",
    APNS_KEY_ID="",
    APNS_PRIVATE_KEY="",
    PUSH_SIMULATION_URL="",
)

import pytest  # noqa: E402
from fake_providers import running_provider  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, event  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from taskwell.auth import issue  # noqa: E402
from taskwell.db import Base, User, get_db  # noqa: E402
from taskwell.main import app, rate_windows  # noqa: E402


@pytest.fixture(scope="session")
def provider_url():
    with running_provider() as url:
        yield url


@pytest.fixture(scope="session")
def application_client():
    with TestClient(app) as client:
        yield client


@pytest.fixture
def workspace(application_client):
    test_url = os.getenv("TEST_DATABASE_URL")
    engine = (
        create_engine(test_url)
        if test_url
        else create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    )
    if test_url:
        Base.metadata.drop_all(engine)

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        if not test_url:
            connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    session = sessionmaker(engine, expire_on_commit=False)
    with session() as db:
        first = User(apple_sub="owner", name="Owner", email="owner@example.test")
        second = User(apple_sub="other", name="Other", email="other@example.test")
        db.add_all([first, second])
        db.commit()
        owner_token, _ = issue(db, first, "native")
        other_token, _ = issue(db, second, "native")

    def override():
        with session() as db:
            yield db

    app.dependency_overrides[get_db] = override
    rate_windows.clear()
    client = application_client
    client.cookies.clear()
    client.headers["Authorization"] = "Bearer " + owner_token
    yield client, {"Authorization": "Bearer " + other_token}, session
    app.dependency_overrides.clear()
    engine.dispose()


@pytest.fixture
def client(workspace):
    return workspace[0]
