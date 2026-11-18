#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Use a separate simulator and database for UI tests, never the personal workspace.
# Pass a simulator UDID as the first argument; find one with xcrun simctl list devices.
device_id="${1:?Usage: bash scripts/test-ios.sh SIMULATOR_UDID}"
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
if lsof -tiTCP:8002 -sTCP:LISTEN >/dev/null; then
  echo 'Port 8002 is already in use. Stop its test backend before retrying.' >&2
  exit 1
fi
(
  cd api
  exec env DEV_LOGIN=true PUBLIC_URL=http://127.0.0.1:5173 \
    DATABASE_URL="sqlite:///$test_directory/tasks.db" \
    .venv/bin/uvicorn tasks.main:app --host 127.0.0.1 --port 8002
) >"$test_directory/api.log" 2>&1 &
backend_pid=$!
for attempt in {1..30}; do
  if curl --silent --fail http://127.0.0.1:8002/health >/dev/null; then break; fi
  sleep 1
done
curl --silent --fail http://127.0.0.1:8002/health >/dev/null
xcodegen generate --spec apple/project.yml
xcodebuild -project apple/Tasks.xcodeproj -scheme Tasks-iOS \
  -configuration Debug -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath apple/DerivedData-iOS \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  -parallel-testing-enabled NO -test-timeouts-enabled YES \
  -maximum-test-execution-time-allowance 180 test
