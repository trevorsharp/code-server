#!/bin/bash
set -e

OPENCODE_CMD="opencode"

if [ "${OPENCODE_FORK:-0}" = "1" ]; then
  cp /home/sharp/projects/opencode/packages/opencode/dist/opencode-linux-arm64/bin/opencode /home/sharp/.opencode/bin/opencode-fork
  OPENCODE_CMD="opencode-fork"
fi

echo "Starting OpenCode web server (using ${OPENCODE_CMD})..."
su -l ${USERNAME} -c "OPENCODE_DISABLE_CHANNEL_DB=1 ${OPENCODE_CMD} web > /dev/null 2>&1 &"

if [ -d /home/${USERNAME}/.ssh ]; then
    chmod 700 /home/${USERNAME}/.ssh 2>/dev/null || true
    chmod 600 /home/${USERNAME}/.ssh/* 2>/dev/null || true
fi

echo "Starting SSH server on port 22..."
exec /usr/sbin/sshd -D -e