#!/usr/bin/env bash
# Copy this script and the three runtime unit files to the VPS.
# Run: sudo bash ./install-auto-deploy.sh
set -euo pipefail
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run using sudo" >&2
  exit 1
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for name in auto-update.sh request-update.sh isk-auto-update.service isk-auto-update.timer; do
  [[ -f "$SCRIPT_DIR/$name" ]] || { echo "Missing file: $SCRIPT_DIR/$name" >&2; exit 1; }
done
install -o root -g root -m 0755 "$SCRIPT_DIR/auto-update.sh" /usr/local/sbin/isk-auto-update
install -o root -g root -m 0755 "$SCRIPT_DIR/request-update.sh" /usr/local/sbin/isk-request-update
install -o root -g root -m 0644 "$SCRIPT_DIR/isk-auto-update.service" /etc/systemd/system/
install -o root -g root -m 0644 "$SCRIPT_DIR/isk-auto-update.timer" /etc/systemd/system/

# Dedicated restricted sudo permission; the GitHub key has a forced command
# and cannot run arbitrary root commands through this mechanism.
printf 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/isk-request-update\n' >/etc/sudoers.d/isk-auto-deploy
chmod 0440 /etc/sudoers.d/isk-auto-deploy
visudo -cf /etc/sudoers.d/isk-auto-deploy

systemctl daemon-reload
systemctl enable --now isk-auto-update.timer
systemctl status --no-pager isk-auto-update.timer || true
echo "Auto-deploy queue installed. Register a restricted deploy public key before configuring GitHub secrets."
