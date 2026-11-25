#!/usr/bin/env bash
# Usage (Ubuntu 24.04): sudo bash bootstrap-ubuntu.sh
# Safe to re-run. Does not modify SSH authentication, user accounts or DB keys.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash bootstrap-ubuntu.sh" >&2; exit 1
fi
. /etc/os-release
if [ "$ID" != "ubuntu" ]; then
  echo "Expected Ubuntu (selected VPS image); detected: $PRETTY_NAME" >&2; exit 1
fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl ufw
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
  "$(dpkg --print-architecture)" "$VERSION_CODENAME" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
# Do not accidentally block SSH: default provider SSH uses TCP 22.
SSH_PORT="${SSH_PORT:-22}"
ufw allow "${SSH_PORT}/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
install -d -m 0755 /opt/isk
docker compose version
ufw status
echo "Docker installed. SSH authentication settings were NOT changed."
