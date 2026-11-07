"""Sign in with Apple over real HTTP. Set APPLE_SIMULATION_URL to use the Postman simulation instead of the fake."""

import base64
import json
import os
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select

from tasks.auth import account_allowed
from tasks.config import settings
from tasks.db import Credential, User


@pytest.fixture(autouse=True)
def apple_config(monkeypatch, provider_url):
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    for name, value in dict(
        apple_private_key=pem,
        apple_team_id="SIMTEAM",
        apple_key_id="SIMKEY",
        apple_web_client_id="com.test.web",
        apple_native_client_ids="com.test.ios",
        apple_base_url=os.getenv("APPLE_SIMULATION_URL") or provider_url,
    ).items():
        monkeypatch.setattr(settings, name, value)


def code(nonce, **overrides):
    return base64.urlsafe_b64encode(json.dumps({"nonce": nonce, **overrides}).encode()).decode()


def challenge(client):
    response = client.post("/auth/apple/challenge", json={"client_id": "com.test.ios"})
    assert response.status_code == 200
    return response.json()


def test_native_valid_signature_login_replay_and_revocation(client):
    c = challenge(client)
    payload = {"challenge_id": c["challenge_id"], "code": code(c["nonce"])}
    response = client.post("/auth/apple/native", json=payload)
    assert response.status_code == 200, response.text
    token = response.json()["access_token"]
    headers = {"Authorization": "Bearer " + token}
    assert client.get("/api/v1/me", headers=headers).json()["email"] == "apple@example.test"
    assert client.post("/auth/apple/native", json=payload).status_code == 400
    # Exercises Apple's revocation endpoint over real HTTP before removing the account.
    assert client.delete("/api/v1/me", headers=headers).status_code == 204
    assert client.get("/api/v1/me", headers=headers).status_code == 401


@pytest.mark.parametrize(
    "overrides",
    [
        {"nonce": "wrong"},
        {"aud": "com.attacker"},
        {"issuer": "https://attacker.test"},
        {"exp_offset": -1},
        {"bad_signature": True},
    ],
)
def test_rejects_invalid_identity_claims(workspace, overrides):
    client, _, session = workspace
    c = challenge(client)
    with session() as db:
        before = len(db.scalars(select(Credential)).all())
    fixture = {"nonce": c["nonce"], **overrides}
    response = client.post("/auth/apple/native", json={"challenge_id": c["challenge_id"], "code": code(**fixture)})
    assert response.status_code == 401, response.text
    with session() as db:
        assert len(db.scalars(select(Credential)).all()) == before


@pytest.mark.parametrize("provider_code", ["invalid-grant", "server-error"])
def test_provider_errors_do_not_create_session(client, provider_code):
    c = challenge(client)
    assert (
        client.post("/auth/apple/native", json={"challenge_id": c["challenge_id"], "code": provider_code}).status_code
        == 401
    )


def test_browser_state_cookie_and_session(client):
    response = client.get("/auth/apple/start", follow_redirects=False)
    assert response.status_code == 307
    query = parse_qs(urlparse(response.headers["location"]).query)
    binding = response.cookies.get("apple_binding")
    client.cookies.set("apple_binding", binding, domain="testserver.local", path="/")
    response = client.post(
        "/auth/apple/callback",
        data={"state": query["state"][0], "code": code(query["nonce"][0])},
        follow_redirects=False,
    )
    assert response.status_code == 303 and "auth_error" not in response.headers["location"]
    assert "HttpOnly" in response.headers["set-cookie"]
    client.headers.pop("Authorization")
    assert client.get("/api/v1/me").json()["email"] == "apple@example.test"


def test_browser_rejects_wrong_binding_and_native_unknown_client(client):
    response = client.get("/auth/apple/start", follow_redirects=False)
    query = parse_qs(urlparse(response.headers["location"]).query)
    client.cookies.clear()
    response = client.post(
        "/auth/apple/callback",
        data={"state": query["state"][0], "code": code(query["nonce"][0])},
        follow_redirects=False,
    )
    assert "auth_error=1" in response.headers["location"]
    assert client.post("/auth/apple/challenge", json={"client_id": "com.attacker"}).status_code == 400


def native_sign_in(client, **claims):
    c = challenge(client)
    return client.post(
        "/auth/apple/native", json={"challenge_id": c["challenge_id"], "code": code(c["nonce"], **claims)}
    )


@pytest.mark.parametrize(
    "listed,claims,status",
    [
        ("001234.owner, friend", {"sub": "001234.owner"}, 200),
        ("Owner@Example.test", {"sub": "any", "email": "owner@example.test"}, 200),
        ("owner@example.test", {"sub": "any", "email": "owner@example.test", "email_verified": True}, 200),
        ("owner@example.test", {"sub": "any", "email": "owner@example.test", "email_verified": "false"}, 403),
        ("001234.owner", {"sub": "stranger", "email": "stranger@example.test"}, 403),
    ],
)
def test_allowlist_decides_who_can_sign_in(workspace, monkeypatch, listed, claims, status):
    client, _, session = workspace
    monkeypatch.setattr(settings, "allowed_apple_accounts", listed)
    with session() as db:
        users = len(db.scalars(select(User)).all())
        credentials = len(db.scalars(select(Credential)).all())
    response = native_sign_in(client, **claims)
    assert response.status_code == status, response.text
    with session() as db:
        created = status == 200
        assert len(db.scalars(select(User)).all()) == users + created
        assert len(db.scalars(select(Credential)).all()) == credentials + created


def test_removing_an_account_from_the_allowlist_stops_new_sign_ins(client, monkeypatch):
    assert native_sign_in(client, sub="former").status_code == 200
    monkeypatch.setattr(settings, "allowed_apple_accounts", "someone-else")
    assert native_sign_in(client, sub="former").status_code == 403


def test_browser_sign_in_reports_a_refused_account(client, monkeypatch):
    monkeypatch.setattr(settings, "allowed_apple_accounts", "someone-else")
    response = client.get("/auth/apple/start", follow_redirects=False)
    query = parse_qs(urlparse(response.headers["location"]).query)
    client.cookies.set("apple_binding", response.cookies.get("apple_binding"), domain="testserver.local", path="/")
    response = client.post(
        "/auth/apple/callback",
        data={"state": query["state"][0], "code": code(query["nonce"][0], sub="stranger")},
        follow_redirects=False,
    )
    assert response.status_code == 303 and "auth_error=denied" in response.headers["location"]
    assert "tasks_session" not in response.headers.get("set-cookie", "")


def test_production_without_an_allowlist_refuses_everyone(monkeypatch):
    monkeypatch.setattr(settings, "allowed_apple_accounts", "")
    assert account_allowed({"sub": "anyone"})
    monkeypatch.setattr(settings, "environment", "production")
    assert not account_allowed({"sub": "anyone"})
