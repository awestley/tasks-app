"""In-process stand-ins for Apple sign-in, APNs and Web Push, served over real HTTP. No real keys or tokens."""

import base64
import json
import threading
import time
from collections import Counter
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KEY_ID = "simulation-key"
attempts = Counter()


def identity_token(fixture, client_id):
    timestamp = int(time.time())
    claims = {
        "iss": fixture.get("issuer", "https://appleid.apple.com"),
        "aud": fixture.get("aud", client_id),
        "iat": timestamp,
        "exp": timestamp + fixture.get("exp_offset", 300),
        "sub": fixture.get("sub", "test-apple-user"),
        "nonce": fixture.get("nonce"),
        "email": fixture.get("email", "apple@example.test"),
        "email_verified": fixture.get("email_verified", "true"),
    }
    token = jwt.encode(claims, KEY, algorithm="RS256", headers={"kid": KEY_ID})
    if fixture.get("bad_signature"):
        return token.rsplit(".", 1)[0] + ".invalid"
    return token


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        return self.rfile.read(int(self.headers.get("content-length") or 0))

    def do_GET(self):
        if self.path != "/auth/keys":
            return self.reply(501, {"error": "Endpoint not modeled"})
        key = {**json.loads(RSAAlgorithm.to_jwk(KEY.public_key())), "kid": KEY_ID, "alg": "RS256", "use": "sig"}
        self.reply(200, {"keys": [key]})

    def do_POST(self):
        body = self.read_body()
        if self.path == "/auth/token":
            return self.apple_token(body)
        if self.path == "/auth/revoke":
            return self.reply(200, {})
        if self.path.startswith("/3/device/"):
            return self.apns(body)
        if self.path.startswith("/web/"):
            return self.web_push()
        self.reply(501, {"error": "Endpoint not modeled"})

    def apple_token(self, body):
        form = {name: values[0] for name, values in parse_qs(body.decode()).items()}
        if not form.get("client_secret") or not form.get("client_id") or form.get("grant_type") != "authorization_code":
            return self.reply(400, {"error": "invalid_request"})
        if form.get("code") == "invalid-grant":
            return self.reply(400, {"error": "invalid_grant"})
        if form.get("code") == "server-error":
            return self.reply(503, {"error": "temporarily_unavailable"})
        try:
            fixture = json.loads(base64.urlsafe_b64decode(form["code"]))
        except (KeyError, ValueError):
            return self.reply(400, {"error": "invalid_grant"})
        self.reply(
            200,
            {
                "access_token": "simulation-access",
                "refresh_token": "simulation-refresh",
                "token_type": "Bearer",
                "expires_in": 3600,
                "id_token": identity_token(fixture, form["client_id"]),
            },
        )

    def apns(self, body):
        headers = self.headers
        if (
            not (headers.get("authorization") or "").startswith("bearer ")
            or not headers.get("apns-topic")
            or headers.get("apns-push-type") != "alert"
            or headers.get("apns-priority") != "10"
        ):
            return self.reply(400, {"reason": "MissingTopic"})
        payload = json.loads(body or b"{}")
        if not payload.get("aps", {}).get("alert", {}).get("body") or not payload.get("task_id"):
            return self.reply(400, {"reason": "PayloadEmpty"})
        token = self.path.rsplit("/", 1)[-1]
        if token.startswith("ee"):
            return self.reply(410, {"reason": "Unregistered"})
        if token.startswith("bb"):
            return self.reply(403, {"reason": "InvalidProviderToken"})
        if token.startswith("ff"):
            attempts[token] += 1
            if attempts[token] == 1:
                return self.reply(503, {"reason": "ServiceUnavailable"})
        self.reply(200)

    def web_push(self):
        headers = self.headers
        if (
            headers.get("content-encoding") != "aes128gcm"
            or not (headers.get("authorization") or "").startswith("vapid ")
            or not headers.get("ttl")
        ):
            return self.reply(400, {"error": "Missing Web Push headers"})
        self.reply(201)


@contextmanager
def running_provider():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
