#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(realpath "${1:?Usage: run-local.sh <repository-root>}")"
HOST_PORT="${HOST_PORT:-5000}"
PROJECT_DIR="WebApp"
CSPROJ="$PROJECT_DIR/WebApp.csproj"

cd "$REPO_ROOT"

if [ ! -f "$CSPROJ" ]; then
  echo "ERROR: Project file not found: $CSPROJ"
  echo "Repository root: $REPO_ROOT"
  exit 1
fi

if [ ! -f "$PROJECT_DIR/Properties/launchSettings.json" ]; then
  echo "ERROR: $PROJECT_DIR/Properties/launchSettings.json not found."
  echo "Repository root: $REPO_ROOT"
  exit 1
fi

if lsof -ti :"$HOST_PORT" > /dev/null 2>&1; then
  echo "ERROR: Port $HOST_PORT is already in use."
  echo "PID(s) using port $HOST_PORT: $(lsof -ti :"$HOST_PORT")"
  echo "Kill it with: kill \$(lsof -ti :$HOST_PORT)"
  exit 1
fi

echo "Building the service (Debug)..."
if ! dotnet build "$CSPROJ" --configuration Debug; then
  echo "ERROR: Build failed. Fix the errors above before running locally."
  exit 1
fi

LOG_FILE="/tmp/dotnet-local-service-$HOST_PORT.log"

echo "Starting the service in the background on port $HOST_PORT..."
ASPNETCORE_ENVIRONMENT=LOCAL nohup dotnet run \
  --project "$CSPROJ" \
  --no-build \
  --configuration Debug \
  -- \
  --urls "http://localhost:$HOST_PORT" \
  > "$LOG_FILE" 2>&1 &
SERVICE_PID=$!
echo "PID: $SERVICE_PID"

echo "Waiting for service to be ready..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:$HOST_PORT/api/v1/liveness" > /dev/null 2>&1; then
    echo ""
    echo "Service is ready on http://localhost:$HOST_PORT"
    echo "PID: $SERVICE_PID"
    echo "Logs: tail -f $LOG_FILE"
    exit 0
  fi
  if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
    echo ""
    echo "ERROR: Service process exited unexpectedly."
    echo "Last 30 lines of log:"
    tail -30 "$LOG_FILE"
    exit 1
  fi
  printf "."
  sleep 2
done

echo ""
echo "ERROR: Timed out waiting for service to be ready (60s)."
echo "Last 30 lines of log:"
tail -30 "$LOG_FILE"
kill "$SERVICE_PID" 2>/dev/null
exit 1
