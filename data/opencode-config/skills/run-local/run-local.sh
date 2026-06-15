#!/usr/bin/env bash
set -euo pipefail

PROJECT_ARG="${1:-WebApp}"
HOST_PORT="${HOST_PORT:-5000}"

if [[ "$PROJECT_ARG" == *.csproj ]]; then
  CSPROJ="$PROJECT_ARG"
  PROJECT_DIR="$(dirname "$CSPROJ")"
else
  PROJECT_DIR="$PROJECT_ARG"
  shopt -s nullglob
  PROJECT_FILES=("$PROJECT_DIR"/*.csproj)
  shopt -u nullglob

  if [ "${#PROJECT_FILES[@]}" -eq 0 ]; then
    echo "ERROR: No .csproj file found in $PROJECT_DIR."
    echo "Usage: HOST_PORT=5001 $0 [project-directory-or-csproj]"
    exit 1
  fi

  if [ "${#PROJECT_FILES[@]}" -gt 1 ]; then
    echo "ERROR: Multiple .csproj files found in $PROJECT_DIR. Pass the .csproj path explicitly."
    echo "Usage: HOST_PORT=5001 $0 [project-directory-or-csproj]"
    exit 1
  fi

  CSPROJ="${PROJECT_FILES[0]}"
fi

if [ ! -f "$CSPROJ" ]; then
  echo "ERROR: Project file not found: $CSPROJ"
  echo "Usage: HOST_PORT=5001 $0 [project-directory-or-csproj]"
  exit 1
fi

if [ ! -f "$PROJECT_DIR/Properties/launchSettings.json" ]; then
  echo "ERROR: $PROJECT_DIR/Properties/launchSettings.json not found."
  echo "This script must be run from the root of a .NET service repository."
  exit 1
fi

if lsof -ti :"$HOST_PORT" > /dev/null 2>&1; then
  echo "ERROR: Port $HOST_PORT is already in use."
  echo "PID(s) using port $HOST_PORT: $(lsof -ti :"$HOST_PORT")"
  echo "Kill it with: kill \$(lsof -ti :$HOST_PORT)"
  exit 1
fi

# Detect available build configurations from the project file.
# Services often define custom configs (LOCAL, DEV, TEST, PROD) without Debug/Release.
# Prefer LOCAL, then DEV, then fall back to the dotnet default (no -c flag).
CONFIG=""
if [ -f "$CSPROJ" ]; then
  CONFIGS_LINE=$(grep -oP '<Configurations>\K[^<]+' "$CSPROJ" 2>/dev/null || true)
  if [ -n "$CONFIGS_LINE" ]; then
    if echo "$CONFIGS_LINE" | grep -qw "LOCAL"; then
      CONFIG="LOCAL"
    elif echo "$CONFIGS_LINE" | grep -qw "DEV"; then
      CONFIG="DEV"
    fi
  fi
fi

CONFIG_FLAG=""
if [ -n "$CONFIG" ]; then
  CONFIG_FLAG="-c $CONFIG"
  echo "Using build configuration: $CONFIG"
fi

echo "Building the service..."
if ! dotnet build "$CSPROJ" $CONFIG_FLAG; then
  echo "ERROR: Build failed. Fix the errors above before running locally."
  exit 1
fi

LOG_FILE="/tmp/dotnet-local-service-$HOST_PORT.log"

echo "Starting the service in the background on port $HOST_PORT..."
nohup dotnet run --project "$CSPROJ" --no-build $CONFIG_FLAG > "$LOG_FILE" 2>&1 &
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
