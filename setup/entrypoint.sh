#!/bin/bash
set -e

echo "Starting OpenCode web server..."
su -l ${USERNAME} -c 'cp /home/sharp/projects/opencode/packages/opencode/dist/opencode-linux-arm64/bin/opencode /home/sharp/.opencode/bin/opencode && OPENCODE_DISABLE_CHANNEL_DB=1 opencode web > /dev/null 2>&1 &'

if [ -d /home/${USERNAME}/.ssh ]; then
    chmod 700 /home/${USERNAME}/.ssh 2>/dev/null || true
    chmod 600 /home/${USERNAME}/.ssh/* 2>/dev/null || true
fi

echo "Starting SSH server on port 22..."
exec /usr/sbin/sshd -D -e