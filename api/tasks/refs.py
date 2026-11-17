"""Canonical references between apps: pc://<app>/<type>/<id>, as in the shared app contract.

Tasks owns pc://tasks/task/<id> and pc://tasks/project/<id>. Notebook notes are pc://notes/note/<id>.
"""

import re
from urllib.parse import quote, unquote, urlsplit

from .config import settings

APP = "tasks"
NAME = r"[a-z][a-z0-9-]{0,31}"
REF = re.compile(rf"^pc://({NAME})/({NAME})/([A-Za-z0-9._~%-]{{1,384}})$")


def format_ref(app: str, kind: str, item_id: str) -> str:
    return f"pc://{app}/{kind}/{quote(item_id, safe='')}"


def parse_ref(ref: str):
    """Return (app, type, id) with the id decoded, or None when the text is not a reference."""
    match = REF.match(ref or "")
    if not match:
        return None
    app, kind, encoded = match.groups()
    return app, kind, unquote(encoded)


def own_url(kind: str, item_id: str) -> str:
    return f"{settings.public_url}/#{kind}/{item_id}"


def url_for(ref: str) -> str | None:
    """A browser address for a reference this server knows how to open, or None."""
    parsed = parse_ref(ref)
    if not parsed:
        return None
    app, kind, item_id = parsed
    if app == APP and kind in {"task", "project"}:
        return own_url(kind, item_id)
    if app == "notes" and kind == "note" and settings.notebook_web_url:
        return f"{settings.notebook_web_url}/#note/{quote(item_id, safe='')}"
    return None


def ref_from_url(url: str) -> str | None:
    """Recognize a pasted Notebook or Tasks address, so it is stored as a reference other apps can find."""
    parts = urlsplit(url or "")
    origin = f"{parts.scheme}://{parts.netloc}"
    fragment = unquote(parts.fragment)
    for prefix, app, kind in (
        (settings.notebook_web_url, "notes", "note"),
        (settings.public_url, APP, "task"),
        (settings.public_url, APP, "project"),
    ):
        if prefix and origin == prefix and fragment.startswith(kind + "/") and len(fragment) > len(kind) + 1:
            return format_ref(app, kind, fragment[len(kind) + 1 :])
    return None


def safe_web_url(url: str) -> bool:
    parts = urlsplit(url or "")
    if parts.scheme == "https" and parts.netloc:
        return True
    return parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1"}
