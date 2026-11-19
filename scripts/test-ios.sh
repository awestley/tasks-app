#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Use a separate simulator and database for UI tests, never the personal workspace.
# Pass a simulator UDID as the first argument; find one with xcrun simctl list devices.
device_id="${1:?Usage: bash scripts/test-ios.sh SIMULATOR_UDID}"
# Another worktree's run may hold the default port; TASKS_TEST_PORT picks another.
port="${TASKS_TEST_PORT:-8002}"
test_directory="$(mktemp -d /tmp/tasks-ios-test.XXXXXX)"
backend_pid=""
cleanup() {
  if [ -n "$backend_pid" ]; then
    kill "$backend_pid" 2>/dev/null || true
    wait "$backend_pid" 2>/dev/null || true
  fi
  # Removing the isolated database also invalidates sessions if XCTest crashes.
  rm -rf "$test_directory"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null; then
  echo "Port $port is already in use. Stop its test backend, or set TASKS_TEST_PORT to another port." >&2
  exit 1
fi
(
  cd api
  exec env DEV_LOGIN=true PUBLIC_URL=http://127.0.0.1:5173 \
    DATABASE_URL="sqlite:///$test_directory/tasks.db" \
    .venv/bin/uvicorn tasks.main:app --host 127.0.0.1 --port "$port"
) >"$test_directory/api.log" 2>&1 &
backend_pid=$!
for attempt in {1..30}; do
  if curl --silent --fail "http://127.0.0.1:$port/health" >/dev/null; then break; fi
  sleep 1
done
curl --silent --fail "http://127.0.0.1:$port/health" >/dev/null
xcodegen generate --spec apple/project.yml
# TEST_RUNNER_ variables reach the UI tests as TASKS_TEST_BASE.
TEST_RUNNER_TASKS_TEST_BASE="http://127.0.0.1:$port" xcodebuild -project apple/Tasks.xcodeproj -scheme Tasks-iOS \
  -configuration Debug -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath apple/DerivedData-iOS \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  -parallel-testing-enabled NO -test-timeouts-enabled YES \
  -maximum-test-execution-time-allowance 180 \
  "${@:2}" test
