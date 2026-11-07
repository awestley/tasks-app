"""The production command stops soon after SIGTERM with an event stream open, so a deploy need not kill it."""

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx

API = Path(__file__).resolve().parents[1]


def production_command(port):
    line = next(line for line in (API.parent / "Dockerfile").read_text().splitlines() if line.startswith("CMD "))
    command = json.loads(line.removeprefix("CMD "))
    command[command.index("--host") + 1] = "127.0.0.1"
    command[command.index("--port") + 1] = str(port)
    return [sys.executable, "-m", *command]


def test_the_server_stops_with_an_event_stream_open(tmp_path):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    server = subprocess.Popen(
        production_command(port),
        cwd=API,
        env={**os.environ, "DATABASE_URL": f"sqlite:///{tmp_path}/tasks.db", "DEV_LOGIN": "true", "PUBLIC_URL": base},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(100):
            try:
                if httpx.get(base + "/health", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.1)
        client = httpx.Client(base_url=base, headers={"Origin": base})
        assert client.post("/auth/dev").status_code == 200
        opened = threading.Event()

        def listen():
            try:
                with client.stream("GET", "/api/v1/events", timeout=None) as response:
                    for _ in response.iter_lines():
                        opened.set()
            except httpx.HTTPError:
                pass

        threading.Thread(target=listen, daemon=True).start()
        assert opened.wait(5)
        server.send_signal(signal.SIGTERM)
        server.wait(timeout=12)
    finally:
        server.kill()
        server.wait()
