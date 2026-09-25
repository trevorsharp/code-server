#!/bin/bash
set -euo pipefail

user_home="/home/${USERNAME}"
user_gid="$(id -g "${USERNAME}")"
export HOME="${user_home}"
export USER="${USERNAME}"
export LOGNAME="${USERNAME}"
. "${NVM_DIR}/nvm.sh"
export PATH="${user_home}/projects/TrevorSharp/CustomGitCommands/scripts:${PATH}"

printf 'PAYMENTS_TESTING_AUTH_CLIENT_SECRET=%s\n' "${PAYMENTS_TESTING_AUTH_CLIENT_SECRET:-}" > /etc/environment

for directory in workspaces .config/opencode .local/share/opencode .local/state/opencode .cache/opencode .vscode-server .azure .config/gh .git-data; do
  mkdir -p "${user_home}/${directory}"
  chown "${USERNAME}:${user_gid}" "${user_home}/${directory}"
done

mkdir -p /run/sshd /etc/ssh/host_keys
for key_type in rsa ed25519; do
  key_file="/etc/ssh/host_keys/ssh_host_${key_type}_key"
  if [ ! -f "${key_file}" ]; then
    ssh-keygen -q -t "${key_type}" -N '' -f "${key_file}"
  fi
done
/usr/sbin/sshd -t

children=()
cleanup() {
  trap - TERM INT
  kill -TERM "${children[@]}" 2>/dev/null || true
  wait "${children[@]}" 2>/dev/null || true
}
trap 'cleanup; exit 0' TERM INT

echo 'Starting MCP OAuth callback relay on port 19877...'
setpriv --reuid="${USERNAME}" --regid="${user_gid}" --init-groups \
  socat TCP4-LISTEN:19877,bind=0.0.0.0,reuseaddr,fork TCP4:127.0.0.1:19876 &
children+=("$!")

echo 'Starting official OpenCode V2 on port 4096...'
setpriv --reuid="${USERNAME}" --regid="${user_gid}" --init-groups \
  opencode serve --service --hostname 0.0.0.0 --port 4096 &
children+=("$!")

echo 'Starting SSH on port 22...'
/usr/sbin/sshd -D -e &
children+=("$!")

status=0
wait -n "${children[@]}" || status=$?
cleanup
exit "${status}"
