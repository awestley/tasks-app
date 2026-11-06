// The shared search contract (docs/search.md). Apps written in JavaScript use these helpers so
// every app parses queries, scores matches and builds snippets the same way; apps in other
// languages implement docs/search.md directly (the tests in test/search.test.js are the reference).

export const LIMIT_DEFAULT = 20;
export const LIMIT_MAX = 50;
export const QUERY_MAX = 200;

/** Lowercase, strip accents, collapse spaces. */
export function fold(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Read and check search parameters from a query object ({ q, types, limit, cursor, updated_after }).
 * Returns { ok: true, params } or { ok: false, error } (respond 422 with { error }).
 */
export function parseSearchParams(query = {}) {
  const raw = typeof query.q === 'string' ? query.q.trim() : '';
  if (!raw) return { ok: false, error: 'q_required' };
  if (raw.length > QUERY_MAX) return { ok: false, error: 'q_too_long' };
  const terms = [];
  // "quoted phrases" stay together; everything else splits on spaces.
  for (const m of raw.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = fold(m[1] ?? m[2]).trim();
    if (t && !terms.includes(t)) terms.push(t);
  }
  if (!terms.length) return { ok: false, error: 'q_required' };
  const types = typeof query.types === 'string' && query.types
    ? query.types.split(',').map((t) => t.trim()).filter((t) => /^[a-z][a-z0-9-]{0,31}$/.test(t))
    : null;
  let limit = query.limit === undefined || query.limit === '' ? LIMIT_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false, error: 'bad_limit' };
  limit = Math.min(limit, LIMIT_MAX);
  let updatedAfter = null;
  if (query.updated_after) {
    const d = new Date(query.updated_after);
    if (Number.isNaN(d.getTime())) return { ok: false, error: 'bad_updated_after' };
    updatedAfter = d;
  }
  const cursor = typeof query.cursor === 'string' && query.cursor ? query.cursor : null;
  return { ok: true, params: { q: raw, terms, types, limit, cursor, updatedAfter } };
}

/**
 * Score an item against the terms, 0 (no match) to 1. Every term must appear in the title or body.
 * Title matches count more than body matches; a whole-title match, a title prefix and a word start
 * count more than a match inside a word.
 */
export function scoreMatch(terms, { title = '', body = '' } = {}) {
  const t = fold(title);
  const b = fold(body);
  if (!terms.length) return 0;
  let total = 0;
  for (const term of terms) {
    let s = 0;
    if (t === term) s = 1;
    else if (t.startsWith(term)) s = 0.9;
    else if (wordStart(t, term)) s = 0.8;
    else if (t.includes(term)) s = 0.6;
    else if (wordStart(b, term)) s = 0.4;
    else if (b.includes(term)) s = 0.3;
    else return 0;
    total += s;
  }
  return Math.round((total / terms.length) * 1000) / 1000;
}

function wordStart(text, term) {
  let i = text.indexOf(term);
  while (i >= 0) {
    if (i === 0 || /[^\p{L}\p{N}]/u.test(text[i - 1])) return true;
    i = text.indexOf(term, i + 1);
  }
  return false;
}

/**
 * A plain-text snippet of `body` around the first match, with match offsets.
 * Highlights are [start, end) offsets into `text`, never HTML, so a snippet can't inject markup.
 */
export function makeSnippet(terms, body, { width = 160 } = {}) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const folded = fold(text);
  // fold() can change lengths for some characters; fall back to no highlights if it does.
  const aligned = folded.length === text.length;
  const first = Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0), Infinity);
  let start = 0;
  if (Number.isFinite(first) && first > width / 3) start = text.lastIndexOf(' ', first - Math.floor(width / 3)) + 1;
  let end = Math.min(text.length, start + width);
  if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > start) end = sp; }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const out = `${prefix}${text.slice(start, end)}${suffix}`;
  const highlights = [];
  if (aligned) {
    const window = folded.slice(start, end);
    for (const term of terms) {
      let i = window.indexOf(term);
      while (i >= 0) { highlights.push([i + prefix.length, i + prefix.length + term.length]); i = window.indexOf(term, i + term.length); }
    }
    highlights.sort((a, b) => a[0] - b[0]);
  }
  return { text: out, highlights: mergeRanges(highlights) };
}

function mergeRanges(ranges) {
  const out = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/** Sort by score, then most recently updated. */
export function compareResults(a, b) {
  return (b.score - a.score) || String(b.updated || '').localeCompare(String(a.updated || ''));
}

/**
 * Search an in-memory list: the whole contract for a small app, or an app's offline replica.
 * `toDoc(item)` returns { ref, type, title, body, subtitle?, icon?, url, updated, version }.
 * The cursor is an offset (callers must treat cursors as opaque). Works in Node and the browser.
 */
export function searchList(items, params, toDoc) {
  const offset = /^o[0-9a-z]+$/.test(params.cursor || '') ? Number.parseInt(params.cursor.slice(1), 36) : 0;
  const scored = [];
  for (const item of items) {
    const d = toDoc(item);
    if (params.types && !params.types.includes(d.type)) continue;
    if (params.updatedAfter && !(new Date(d.updated) > params.updatedAfter)) continue;
    const score = scoreMatch(params.terms, d);
    if (score > 0) scored.push({ ...d, score });
  }
  scored.sort(compareResults);
  const page = scored.slice(offset, offset + params.limit);
  const next = offset + params.limit < scored.length ? `o${(offset + params.limit).toString(36)}` : null;
  return {
    items: page.map(({ body, ...d }) => ({
      ref: d.ref, type: d.type, title: d.title, subtitle: d.subtitle ?? null, snippet: makeSnippet(params.terms, body),
      icon: d.icon ?? null, url: d.url, updated: d.updated, version: d.version ?? null, score: d.score,
    })),
    next_cursor: next,
  };
}
