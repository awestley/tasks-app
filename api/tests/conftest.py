import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from taskwell.auth import issue
from taskwell.db import Base, User, get_db
from taskwell.main import app, rate_windows


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
