"""The shared Personal Command search contract (westley-app docs/search.md), in Python.

This is a direct port of packages/runtime/src/search.js in westley-app, so scores and snippets match
every other app and the shell can merge results. tests/test_contract.py ports the runtime's test cases.
"""

import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone

LIMIT_DEFAULT = 20
LIMIT_MAX = 50
QUERY_MAX = 200
_TERMS = re.compile(r'"([^"]+)"|(\S+)')
_TYPE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_CURSOR = re.compile(r"^o[0-9a-z]+$")


class SearchError(ValueError):
    """An invalid parameter; the code is the contract's 422 error code."""


@dataclass
class Params:
    q: str
    terms: list[str]
    types: list[str] | None
    limit: int
    cursor: str | None
    updated_after: datetime | None


def fold(value):
    """Lowercase and strip accents (NFKD, then drop combining marks U+0300 to U+036F)."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(ch for ch in text if not 0x300 <= ord(ch) <= 0x36F).lower()


def parse_params(q=None, types=None, limit=None, cursor=None, updated_after=None):
    raw = q.strip() if isinstance(q, str) else ""
    if not raw:
        raise SearchError("q_required")
    if len(raw) > QUERY_MAX:
        raise SearchError("q_too_long")
    terms = []
    for match in _TERMS.finditer(raw):
        term = fold(match.group(1) or match.group(2)).strip()
        if term and term not in terms:
            terms.append(term)
    if not terms:
        raise SearchError("q_required")
    kinds = [t.strip() for t in types.split(",") if _TYPE.match(t.strip())] if types else None
    if limit in (None, ""):
        size = LIMIT_DEFAULT
    else:
        try:
            size = int(limit)
        except (TypeError, ValueError):
            raise SearchError("bad_limit") from None
        if size < 1:
            raise SearchError("bad_limit")
    after = None
    if updated_after:
        try:
            after = datetime.fromisoformat(updated_after)
        except ValueError:
            raise SearchError("bad_updated_after") from None
        after = _utc(after)
    return Params(raw, terms, kinds, min(size, LIMIT_MAX), cursor or None, after)


def _word_start(text, term):
    i = text.find(term)
    while i >= 0:
        if i == 0 or not text[i - 1].isalnum():
            return True
        i = text.find(term, i + 1)
    return False


def score_match(terms, title="", body=""):
    """0 (no match) to 1, by the table in docs/search.md, averaged over terms. Every term must match."""
    t, b = fold(title), fold(body)
    if not terms:
        return 0
    total = 0.0
    for term in terms:
        if t == term:
            s = 1.0
        elif t.startswith(term):
            s = 0.9
        elif _word_start(t, term):
            s = 0.8
        elif term in t:
            s = 0.6
        elif _word_start(b, term):
            s = 0.4
        elif term in b:
            s = 0.3
        else:
            return 0
        total += s
    return math.floor(total / len(terms) * 1000 + 0.5) / 1000  # Math.round, not banker's rounding


def _utf16(text, index):
    """JavaScript string offset for a Python index, so the shell's slicing lands on the same characters."""
    return len(text[:index].encode("utf-16-le")) // 2


def make_snippet(terms, body, width=160):
    """A plain-text snippet around the first match, with [start, end) highlight offsets (never HTML)."""
    text = re.sub(r"\s+", " ", str(body or "")).strip()
    if not text:
        return None
    folded = fold(text)
    aligned = len(folded) == len(text)
    found = [folded.find(t) for t in terms if folded.find(t) >= 0]
    start = 0
    if found and min(found) > width / 3:
        start = text.rfind(" ", 0, min(found) - width // 3 + 1) + 1
    end = min(len(text), start + width)
    if end < len(text):
        space = text.rfind(" ", 0, end + 1)
        if space > start:
            end = space
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    out = prefix + text[start:end] + suffix
    ranges = []
    if aligned:
        window = folded[start:end]
        for term in terms:
            i = window.find(term)
            while i >= 0:
                ranges.append([i + len(prefix), i + len(prefix) + len(term)])
                i = window.find(term, i + len(term))
        ranges.sort()
    merged = []
    for r in ranges:
        if merged and r[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], r[1])
        else:
            merged.append(r)
    return {"text": out, "highlights": [[_utf16(out, a), _utf16(out, b)] for a, b in merged]}


def _base36(n):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if not n:
            return out


def search_docs(docs, params):
    """Search a list of documents: dicts with ref, type, title, body, subtitle, icon, url, updated (aware
    datetime) and version. Returns the contract's { items, next_cursor }."""
    offset = int(params.cursor[1:], 36) if params.cursor and _CURSOR.match(params.cursor) else 0
    scored = []
    for doc in docs:
        doc = {**doc, "updated": _utc(doc["updated"])}
        if params.types is not None and doc["type"] not in params.types:
            continue
        if params.updated_after and not doc["updated"] > params.updated_after:
            continue
        score = score_match(params.terms, doc["title"], doc.get("body", ""))
        if score > 0:
            scored.append((score, doc))
    scored.sort(key=lambda pair: (pair[0], pair[1]["updated"]), reverse=True)
    page = scored[offset : offset + params.limit]
    more = offset + params.limit < len(scored)
    return {
        "items": [
            {
                "ref": doc["ref"],
                "type": doc["type"],
                "title": doc["title"],
                "subtitle": doc.get("subtitle"),
                "snippet": make_snippet(params.terms, doc.get("body", "")),
                "icon": doc.get("icon"),
                "url": doc["url"],
                "updated": iso(doc["updated"]),
                "version": doc.get("version"),
                "score": score,
            }
            for score, doc in page
        ],
        "next_cursor": "o" + _base36(offset + params.limit) if more else None,
    }


def _utc(value):
    """Aware UTC; naive values are UTC already (the database stores UTC without a zone)."""
    return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)


def iso(value):
    """ISO 8601 in UTC with milliseconds and Z, like JavaScript's toISOString()."""
    value = _utc(value)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"
