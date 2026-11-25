#!/bin/sh
# Run on VPS: sudo sh /opt/isk/update.sh
# Pull only pre-built images; never compile React/Python on a 1 GB server.
set -eu
cd /opt/isk
docker compose pull isk
docker compose up -d --wait --remove-orphans
docker image prune -f
docker compose ps
