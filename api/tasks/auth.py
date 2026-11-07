import base64
import hashlib
import logging
import secrets
import time
from datetime import timedelta
from functools import cache
from types import SimpleNamespace
from urllib.parse import urlencode

import httpx
import jwt
from cryptography.fernet import Fernet
from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.responses import RedirectResponse
from fastapi.security import APIKeyCookie, HTTPBearer
from pydantic import Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .config import settings
from .db import Challenge, Credential, User, get_db, now
from .schemas import Model

router = APIRouter(prefix="/auth", tags=["Authentication"])
COOKIE = "tasks_session"
SHELL_COOKIE = "pc_session"
SHELL_AUDIENCE = "personal-command"
log = logging.getLogger(__name__)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def trusted_origin(request):
    """Accept the public URL, and in development also the API's own origin (the built app served on its port)."""
    origin = request.headers.get("origin")
    if origin == settings.public_url:
        return True
    if settings.production or origin != f"{request.url.scheme}://{request.url.netloc}":
        return False
    # The API's own origin comes from the Host header, so DNS rebinding could otherwise pose as it.
    return request.url.hostname in {"localhost", "127.0.0.1", "::1"}


@cache
def shell_keys():
    # Keys are cached and refetched when a token names a key id not seen yet (key rotation).
    return jwt.PyJWKClient(settings.jwks_url, cache_keys=True, lifespan=600, timeout=5)


SHELL_LEEWAY = 30


def verify_shell_token(token):
    """Claims of a valid access token from the shell's identity service, or None."""
    try:
        key = shell_keys().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            key,
            algorithms=["ES256"],
            audience=SHELL_AUDIENCE,
            issuer=settings.shell_url,
            leeway=SHELL_LEEWAY,
            options={"require": ["exp", "iat", "sub", "iss", "aud"]},
        )
    except jwt.PyJWKClientConnectionError as error:
        # The shell's keys can't be fetched, which says nothing about this token, so it isn't "signed out".
        raise HTTPException(503, "Can't check your session right now. Try again shortly.") from error
    except (jwt.PyJWTError, ValueError, TypeError):
        return None
    return claims if isinstance(claims.get("sub"), str) and 0 < len(claims["sub"]) <= 200 else None


def shell_user(db, claims):
    """The user for a shell identity, created on first use. Data stays keyed by this row, so it survives a
    change of sign in provider in the shell (the sub is stable)."""
    user = db.scalar(select(User).where(User.shell_sub == claims["sub"]))
    if user:
        return user
    user = User(
        apple_sub="shell:" + claims["sub"],
        shell_sub=claims["sub"],
        email=str(claims.get("email") or "")[:320],
        name="My workspace",
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # A new user's panes load together, so several requests can be the first. One of them won.
        db.rollback()
        user = db.scalar(select(User).where(User.shell_sub == claims["sub"]))
        if not user:
            raise
    return user


def looks_like_jwt(token):
    return token.count(".") == 2 and not token.startswith("tw_")


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
    shell_cookie = settings.shell_mode and not bearer and request.cookies.get(SHELL_COOKIE)
    token = authorization[7:] if bearer else (shell_cookie or request.cookies.get(COOKIE))
    if not token:
        raise HTTPException(401, "Sign in required")
    if not bearer and request.method not in {"GET", "HEAD", "OPTIONS"}:
        if not trusted_origin(request):
            raise HTTPException(403, "Invalid request origin")
    if settings.shell_mode and looks_like_jwt(token):
        claims = verify_shell_token(token)
        if not claims:
            raise HTTPException(401, "Session expired")
        request.state.credential = SimpleNamespace(kind="shell", id=None, expires=claims["exp"])
        return shell_user(db, claims)
    credential = db.scalar(select(Credential).where(Credential.digest == digest(token), Credential.expires_at > now()))
    if not credential:
        raise HTTPException(401, "Session expired or token revoked")
    request.state.credential = credential
    return db.get(User, credential.user_id)


def still_signed_in(db, credential):
    """Whether what opened a long-lived connection still counts: a shell token until it expires, and a stored
    credential until it expires or is revoked."""
    if credential.kind == "shell":
        return time.time() < credential.expires + SHELL_LEEWAY
    query = select(Credential.id).where(Credential.id == credential.id, Credential.expires_at > now())
    return db.scalar(query) is not None


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


def account_allowed(claims):
    allowlist = settings.apple_account_allowlist
    if not allowlist:
        return not settings.production
    if claims["sub"].lower() in allowlist:
        return True
    # Apple sends email_verified as either a boolean or the string "true".
    email = str(claims.get("email", "")).lower()
    return email in allowlist and str(claims.get("email_verified", "")).lower() == "true"


def apple_user(db, claims, tokens, client_id):
    if not account_allowed(claims):
        # The subject is opaque, and logging it lets the owner add their own account after a first attempt.
        log.warning("Refused Apple sign-in for subject %s", claims["sub"])
        raise HTTPException(403, "This Apple account is not allowed on this server.")
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
    if settings.shell_mode:
        # Sign in happens in the shell; the web app sends people there.
        return {"apple_enabled": False, "dev_login": False, "shell": True}
    return {"apple_enabled": settings.apple_ready, "dev_login": settings.dev_login and not settings.production}


def own_sign_in():
    if settings.shell_mode:
        raise HTTPException(404, "Sign in through the shell")


@router.post("/dev")
def dev(response: Response, request: Request, db: Session = Depends(get_db)):
    own_sign_in()
    if settings.production or not settings.dev_login:
        raise HTTPException(404)
    if not trusted_origin(request):
        raise HTTPException(403, "Invalid request origin")
    user = db.scalar(select(User).where(User.apple_sub == "local-demo"))
    if not user:
        user = User(apple_sub="local-demo", name="Local workspace", email="")
        db.add(user)
        db.commit()
    token, _ = issue(db, user)
    set_cookie(response, token)
    return {"ok": True}


@router.get("/apple/start")
def apple_start(db: Session = Depends(get_db)):
    own_sign_in()
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
    own_sign_in()
    form = await request.form()
    try:
        challenge = consume(db, str(form.get("state", "")), "web", digest(request.cookies.get("apple_binding", "")))
        claims, tokens = await run_in_threadpool(exchange, str(form.get("code", "")), challenge)
        user = apple_user(db, claims, tokens, challenge.client_id)
        token, _ = issue(db, user)
        response = RedirectResponse(settings.public_url, status_code=303)
        set_cookie(response, token)
    except HTTPException as error:
        reason = "denied" if error.status_code == 403 else "1"
        response = RedirectResponse(settings.public_url + "/?auth_error=" + reason, status_code=303)
    response.delete_cookie("apple_binding", secure=True, httponly=True, samesite="none")
    return response


class NativeChallenge(Model):
    client_id: str = Field(max_length=255)


class NativeExchange(Model):
    challenge_id: str = Field(max_length=100)
    code: str = Field(min_length=1, max_length=4096)


@router.post("/apple/challenge")
def native_challenge(data: NativeChallenge, db: Session = Depends(get_db)):
    own_sign_in()
    if not settings.apple_ready or data.client_id not in settings.native_client_ids:
        raise HTTPException(400, "Unknown Apple application")
    challenge = new_challenge(db, "native", data.client_id)
    return {"challenge_id": challenge.id, "nonce": challenge.nonce}


@router.post("/apple/native")
def native_exchange(data: NativeExchange, db: Session = Depends(get_db)):
    own_sign_in()
    challenge = consume(db, data.challenge_id, "native")
    claims, tokens = exchange(data.code, challenge)
    user = apple_user(db, claims, tokens, challenge.client_id)
    token, credential = issue(db, user, "native")
    return {"access_token": token, "token_type": "bearer", "expires_at": credential.expires_at}


@router.post("/logout")
def logout(request: Request, response: Response, user=Depends(authenticate), db: Session = Depends(get_db)):
    if request.state.credential.kind == "shell":
        raise HTTPException(400, "Sign out from the shell")
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
