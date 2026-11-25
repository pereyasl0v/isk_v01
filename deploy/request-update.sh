#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Root required" >&2; exit 1; }
[ "$#" -eq 0 ] || { echo "Arguments not allowed" >&2; exit 2; }
install -d -o root -g root -m 0700 /var/lib/isk-deploy
touch /var/lib/isk-deploy/pending
chmod 0600 /var/lib/isk-deploy/pending
systemctl start --no-block isk-auto-update.service
echo "Update queued; it will apply when the app is idle."
