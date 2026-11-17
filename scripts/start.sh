#!/usr/bin/env bash
# Clean old builds, build the latest web, macOS, and iOS apps, then start the backend.
# The backend serves the built web app, so everything runs from one local address.
#
# Usage: ./scripts/start.sh [--skip-apple] [--no-build] [--no-serve] [--port PORT]
#   --skip-apple  Build only the web app (Apple builds take a few minutes).
#   --no-build    Start the backend with the existing builds. Skips cleaning and building.
#   --no-serve    Clean and build, then exit without starting the backend.
#   --port PORT   Backend port. Defaults to TASKS_API_PORT or 8000.
set -euo pipefail
cd "$(dirname "$0")/.."

build=true
build_apple=true
serve=true
port="${TASKS_API_PORT:-8000}"
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-apple) build_apple=false ;;
    --no-build) build=false; build_apple=false ;;
    --no-serve) serve=false ;;
    --port) port="${2:?--port needs a value}"; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n==> %s\n' "$1"; }

# Run a quiet xcodebuild, showing errors and the result. Keep the full log on failure.
xcode_build() {
  local name="$1"; shift
  local log
  log="$(mktemp -t "tasks-$name")"
  if xcodebuild -project apple/Tasks.xcodeproj -configuration Debug "$@" build >"$log" 2>&1; then
    echo "$name: build succeeded"
    rm -f "$log"
  else
    grep -E 'error:' "$log" | sort -u | head -20 >&2 || true
    echo "$name: build failed. Full log: $log" >&2
    exit 1
  fi
}

# Stop an earlier backend on this port, but never an unrelated program.
if pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null)" && [ -n "$pids" ]; then
  for pid in $pids; do
    if ps -o command= -p "$pid" | grep -q 'tasks.main:app'; then
      step "Stopping the previous backend on port $port (process $pid)"
      if ! kill "$pid" 2>/dev/null; then
        echo "Process $pid belongs to the $(ps -o user= -p "$pid" | tr -d ' ') account and can't be stopped from $(id -un)." >&2
        echo "Stop it from that account, or choose another port with --port." >&2
        exit 1
      fi
      for _ in {1..20}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    elif $serve; then
      echo "Port $port is in use by another program: $(ps -o command= -p "$pid")" >&2
      echo "Stop it, or choose another port with --port." >&2
      exit 1
    fi
  done
fi
# lsof can't see another account's processes, so also check whether anything still answers on the port.
if $serve && nc -z 127.0.0.1 "$port" 2>/dev/null; then
  echo "Port $port is still in use, probably by a backend another Mac account started." >&2
  echo "Stop it from that account, or choose another port with --port." >&2
  exit 1
fi

if $build_apple && pgrep -f 'xcodebuild -project apple/Tasks.xcodeproj' >/dev/null; then
  echo "Another Xcode build of this project is running. Wait for it to finish, or use --skip-apple." >&2
  exit 1
fi

if $build; then
  step "Removing old builds"
  rm -rf web/dist web/test-results web/tsconfig.tsbuildinfo
  if $build_apple; then
    # DerivedData-macOS is an older location that nothing uses now.
    rm -rf apple/DerivedData apple/DerivedData-iOS apple/DerivedData-macOS
  fi
fi

step "Installing dependencies"
if [ ! -e api/.env ]; then cp api/.env.example api/.env; fi
uv sync --directory api --python 3.12 --quiet
if $build && { [ ! -d web/node_modules ] || [ web/package-lock.json -nt web/node_modules/.package-lock.json ]; }; then
  npm --prefix web ci --no-audit --no-fund
fi

if $build; then
  step "Building the web app"
  npm --prefix web run build --silent
elif [ ! -f web/dist/index.html ]; then
  echo "There is no web build yet. Run without --no-build first." >&2
  exit 1
fi

if $build_apple; then
  step "Building the macOS and iOS apps"
  xcodegen generate --spec apple/project.yml --quiet
  # The macOS app's entitlements need a development certificate, so it builds unsigned for now.
  xcode_build macOS -scheme Tasks-macOS -derivedDataPath apple/DerivedData CODE_SIGNING_ALLOWED=NO
  # Ad hoc signing lets the Simulator app use the Keychain.
  xcode_build iOS -scheme Tasks-iOS -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath apple/DerivedData-iOS CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
  echo "macOS app: apple/DerivedData/Build/Products/Debug/Tasks.app"
  echo "iOS Simulator app: apple/DerivedData-iOS/Build/Products/Debug-iphonesimulator/Tasks.app"
fi

if ! $serve; then
  step "Done. Start the backend later with ./scripts/start.sh --no-build"
  exit 0
fi

step "Starting the backend at http://localhost:$port"
echo "Open http://localhost:$port and choose Open local workspace. Press Control-C to stop."
cd api
# The browser's origin must match PUBLIC_URL for local sign-in, so it follows the port.
export PUBLIC_URL="http://localhost:$port"
exec .venv/bin/uvicorn tasks.main:app --host 127.0.0.1 --port "$port"
