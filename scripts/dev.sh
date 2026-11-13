#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -e api/.env ]; then cp api/.env.example api/.env; fi
uv sync --directory api --python 3.12
npm --prefix web ci
tasks_port="${TASKS_API_PORT:-8000}"
export TASKS_API_URL="http://127.0.0.1:${tasks_port}"
(cd api && .venv/bin/uvicorn tasks.main:app --host 127.0.0.1 --port "$tasks_port") &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true' EXIT INT TERM
npm --prefix web run dev
