#!/usr/bin/env bash
# Pull the latest code and redeploy on the VPS. Migrations run automatically
# (the `migrate` service must succeed before `web` starts).
#   cd /opt/ufa && ./scripts/deploy.sh
set -euo pipefail

git pull --ff-only
docker compose build
docker compose up -d
docker compose ps
echo "Waiting for health check..."
for i in $(seq 1 30); do
  if docker compose exec -T web wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "Deployed and healthy."
    exit 0
  fi
  sleep 2
done
echo "Web container did not become healthy; check: docker compose logs web migrate" >&2
exit 1
