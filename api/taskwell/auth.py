import base64
import hashlib
import secrets
from datetime import timedelta
from urllib.parse import urlencode

import httpx
import jwt
from cryptography.fernet import Fernet
from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.responses import RedirectResponse
from fastapi.security import APIKeyCookie, HTTPBearer
from pydantic import Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .config import settings
from .db import Challenge, Credential, User, get_db, now
from .schemas import Model

router = APIRouter(prefix="/auth", tags=["Authentication"])
COOKIE = "taskwell_session"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def trusted_origin(request):
    """Accept the public URL, and in development also the API's own origin (the built app served on its port)."""
    origin = request.headers.get("origin")
    if origin == settings.public_url:
        return True
    return not settings.production and origin == str(request.base_url).rstrip("/")


def cipher():
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(settings.secret_key.encode()).digest()))


def authenticate(
    request: Request,
    db: Session = Depends(get_db),
    bearer_scheme=Security(HTTPBearer(auto_error=False)),
    cookie_scheme=Security(APIKeyCookie(name=COOKIE, auto_error=False)),
):
    authorization = request.headers.get("authorization", "")
    bearer = authorization.startswith("Bearer ")
    token = authorization[7:] if bearer else request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Sign in required")
    if not bearer and request.method not in {"GET", "HEAD", "OPTIONS"}:
        if not trusted_origin(request):
            raise HTTPException(403, "Invalid request origin")
    credential = db.scalar(select(Credential).where(Credential.digest == digest(token), Credential.expires_at > now()))
    if not credential:
        raise HTTPException(401, "Session expired or token revoked")
    request.state.credential = credential
    return db.get(User, credential.user_id)


def session_only(request):
    if request.state.credential.kind == "api":
        raise HTTPException(403, "Sign in to manage credentials or your account")


def issue(db, user, kind="web", name="Session"):
    token = "tw_" + secrets.token_urlsafe(40)
    credential = Credential(
        user_id=user.id,
        digest=digest(token),
        name=name,
        kind=kind,
        expires_at=now() + timedelta(days=90 if kind == "api" else 30),
    )
    db.add(credential)
    db.commit()
    return token, credential


def set_cookie(response, token):
    response.set_cookie(COOKIE, token, httponly=True, secure=settings.production, samesite="lax", max_age=30 * 86400)


def apple_secret(client_id):
    return jwt.encode(
        {
            "iss": settings.apple_team_id,
            "iat": now(),
            "exp": now() + timedelta(minutes=5),
            "aud": "https://appleid.apple.com",
            "sub": client_id,
        },
        settings.apple_private_key.replace("\\n", "\n"),
        algorithm="ES256",
        headers={"kid": settings.apple_key_id},
    )


def exchange(code, challenge):
    try:
        with httpx.Client(timeout=10) as client:
            data = {
                "client_id": challenge.client_id,
                "client_secret": apple_secret(challenge.client_id),
                "code": code,
                "grant_type": "authorization_code",
            }
            if challenge.kind == "web":
                data["redirect_uri"] = settings.public_url + "/auth/apple/callback"
            response = client.post(settings.apple_base_url + "/auth/token", data=data)
            response.raise_for_status()
            tokens = response.json()
            keys_response = client.get(settings.apple_base_url + "/auth/keys")
            keys_response.raise_for_status()
            keys = jwt.PyJWKSet.from_dict(keys_response.json())
            header = jwt.get_unverified_header(tokens["id_token"])
            key = next(k.key for k in keys.keys if k.key_id == header.get("kid"))
            claims = jwt.decode(
                tokens["id_token"],
                key,
                algorithms=["RS256"],
                audience=challenge.client_id,
                issuer="https://appleid.apple.com",
                options={"require": ["exp", "iat", "sub", "nonce"]},
            )
            if not secrets.compare_digest(claims["nonce"], challenge.nonce):
                raise ValueError("Invalid nonce")
            return claims, tokens
    except (httpx.HTTPError, jwt.PyJWTError, KeyError, ValueError, StopIteration, TypeError) as error:
        raise HTTPException(401, "Apple sign-in could not be verified. Please start again.") from error


def new_challenge(db, kind, client_id, binding=""):
    db.execute(delete(Challenge).where(Challenge.expires_at < now()))
    challenge = Challenge(
        id=secrets.token_urlsafe(32),
        nonce=secrets.token_urlsafe(32),
        binding=binding,
        kind=kind,
        client_id=client_id,
        expires_at=now() + timedelta(minutes=10),
    )
    db.add(challenge)
    db.commit()
    return challenge


def consume(db, challenge_id, kind, binding=""):
    challenge = db.get(Challenge, challenge_id)
    if (
        not challenge
        or challenge.kind != kind
        or challenge.expires_at < now()
        or not secrets.compare_digest(challenge.binding, binding)
    ):
        raise HTTPException(400, "Sign-in expired. Please start again.")
    # Atomic consumption prevents replay, including concurrent requests.
    result = db.execute(delete(Challenge).where(Challenge.id == challenge_id))
    db.commit()
    if result.rowcount != 1:
        raise HTTPException(400, "Sign-in already used")
    return challenge


def apple_user(db, claims, tokens, client_id):
    user = db.scalar(select(User).where(User.apple_sub == claims["sub"]))
    if not user:
        user = User(apple_sub=claims["sub"], email=claims.get("email", ""), name="My workspace")
        db.add(user)
        db.flush()
    if tokens.get("refresh_token"):
        user.apple_refresh = cipher().encrypt(tokens["refresh_token"].encode()).decode()
        user.apple_client_id = client_id
    db.commit()
    return user


@router.get("/config")
def config():
    return {"apple_enabled": settings.apple_ready, "dev_login": settings.dev_login and not settings.production}


@router.post("/dev")
def dev(response: Response, request: Request, db: Session = Depends(get_db)):
    if settings.production or not settings.dev_login:
        raise HTTPException(404)
    if not trusted_origin(request):
        raise HTTPException(403, "Invalid request origin")
    user = db.scalar(select(User).where(User.apple_sub == "local-demo"))
    if not user:
        user = User(apple_sub="local-demo", name="Local workspace", email="")
        db.add(user)
        db.commit()
    elif user.name == "Alex Morgan" and user.email == "alex@example.test":
        user.name, user.email = "Local workspace", ""
        db.commit()
    token, _ = issue(db, user)
    set_cookie(response, token)
    return {"ok": True}


@router.get("/apple/start")
def apple_start(db: Session = Depends(get_db)):
    if not settings.apple_ready:
        raise HTTPException(503, "Sign in with Apple is not configured")
    binding = secrets.token_urlsafe(32)
    challenge = new_challenge(db, "web", settings.apple_web_client_id, digest(binding))
    query = urlencode(
        {
            "client_id": challenge.client_id,
            "redirect_uri": settings.public_url + "/auth/apple/callback",
            "response_type": "code",
            "response_mode": "form_post",
            "scope": "name email",
            "state": challenge.id,
            "nonce": challenge.nonce,
        }
    )
    response = RedirectResponse(settings.apple_base_url + "/auth/authorize?" + query)
    response.set_cookie("apple_binding", binding, secure=True, httponly=True, samesite="none", max_age=600)
    return response


@router.post("/apple/callback")
async def apple_callback(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    try:
        challenge = consume(db, str(form.get("state", "")), "web", digest(request.cookies.get("apple_binding", "")))
        claims, tokens = await run_in_threadpool(exchange, str(form.get("code", "")), challenge)
        user = apple_user(db, claims, tokens, challenge.client_id)
        token, _ = issue(db, user)
        response = RedirectResponse(settings.public_url, status_code=303)
        set_cookie(response, token)
    except HTTPException:
        response = RedirectResponse(settings.public_url + "/?auth_error=1", status_code=303)
    response.delete_cookie("apple_binding", secure=True, httponly=True, samesite="none")
    return response


class NativeChallenge(Model):
    client_id: str = Field(max_length=255)


class NativeExchange(Model):
    challenge_id: str = Field(max_length=100)
    code: str = Field(min_length=1, max_length=4096)


@router.post("/apple/challenge")
def native_challenge(data: NativeChallenge, db: Session = Depends(get_db)):
    if not settings.apple_ready or data.client_id not in settings.apple_native_client_ids.split(","):
        raise HTTPException(400, "Unknown Apple application")
    challenge = new_challenge(db, "native", data.client_id)
    return {"challenge_id": challenge.id, "nonce": challenge.nonce}


@router.post("/apple/native")
def native_exchange(data: NativeExchange, db: Session = Depends(get_db)):
    challenge = consume(db, data.challenge_id, "native")
    claims, tokens = exchange(data.code, challenge)
    user = apple_user(db, claims, tokens, challenge.client_id)
    token, credential = issue(db, user, "native")
    return {"access_token": token, "token_type": "bearer", "expires_at": credential.expires_at}


@router.post("/logout")
def logout(request: Request, response: Response, user=Depends(authenticate), db: Session = Depends(get_db)):
    db.delete(request.state.credential)
    db.commit()
    response.delete_cookie(COOKIE)
    return {"ok": True}


def revoke_apple(user):
    if not user.apple_refresh:
        return
    try:
        with httpx.Client(timeout=10) as client:
            response = client.post(
                settings.apple_base_url + "/auth/revoke",
                data={
                    "client_id": user.apple_client_id,
                    "client_secret": apple_secret(user.apple_client_id),
                    "token": cipher().decrypt(user.apple_refresh.encode()).decode(),
                    "token_type_hint": "refresh_token",
                },
            )
            response.raise_for_status()
    except Exception as error:
        raise HTTPException(503, "Apple authorization could not be revoked. Please retry account deletion.") from error
