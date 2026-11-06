"""Change events for the contract's GET /events stream (server-sent events).

Each open stream gets a queue. Request handlers run in worker threads, so publishing hands the event to
the stream's event loop. This works for one server process, which is how the app is deployed; more
instances would need a shared channel such as PostgreSQL LISTEN/NOTIFY.
"""

import asyncio
import json
import threading
from collections import defaultdict

_lock = threading.Lock()
_streams = defaultdict(set)
QUEUE_LIMIT = 1000


def subscribe(user_id):
    queue = asyncio.Queue(QUEUE_LIMIT)
    entry = (asyncio.get_running_loop(), queue)
    with _lock:
        _streams[user_id].add(entry)
    return entry


def unsubscribe(user_id, entry):
    with _lock:
        _streams[user_id].discard(entry)
        if not _streams[user_id]:
            del _streams[user_id]


def _offer(queue, data):
    if not queue.full():  # A stream that stopped reading misses events rather than growing without limit.
        queue.put_nowait(data)


def publish(user_id, ref, kind, version=None):
    data = json.dumps({"ref": ref, "kind": kind, "version": version})
    with _lock:
        targets = list(_streams.get(user_id, ()))
    for loop, queue in targets:
        try:
            loop.call_soon_threadsafe(_offer, queue, data)
        except RuntimeError:
            pass  # The stream's loop has closed.
