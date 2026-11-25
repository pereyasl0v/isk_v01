#!/bin/sh
# Apply queued published image only while no Ozon job is active.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Root required" >&2; exit 1; }
cd /opt/isk
install -d -o root -g root -m 0700 /var/lib/isk-deploy
exec 9>/run/isk-auto-update.lock
flock -n 9 || exit 0
[ -f /var/lib/isk-deploy/pending ] || exit 0

probe() {
  docker compose exec -T isk python -c '
from pathlib import Path
import sys
sys.exit(10 if Path("/data/.isk_active_job").exists() else 0)
'
}
if probe; then :; else
  rc=$?
  if [ "$rc" -eq 10 ]; then echo "Ozon job active: update queued."
  else echo "Cannot inspect running container (exit $rc); update queued." >&2; fi
  exit 0
fi

# Downloading does not disturb the running application.
docker compose pull isk

gate_set=0
remove_gate() {
  if [ "$gate_set" -eq 1 ]; then
    docker compose exec -T isk python -c '
from pathlib import Path
Path("/data/.isk_deploying").unlink(missing_ok=True)
' >/dev/null 2>&1 || true
  fi
}
trap remove_gate EXIT HUP INT TERM
if docker compose exec -T isk python -c '
from pathlib import Path
import sys
if Path("/data/.isk_active_job").exists():
    sys.exit(10)
Path("/data/.isk_deploying").touch()
'; then
  gate_set=1
else
  echo "ISK became busy during image pull; will retry."
  exit 0
fi
if probe; then :; else
  echo "ISK job started during deployment gating; will retry."
  exit 0
fi
docker compose up -d --wait --remove-orphans
gate_set=0
rm -f /var/lib/isk-deploy/pending
docker image prune -f
docker compose ps
echo "ISK auto update succeeded."
