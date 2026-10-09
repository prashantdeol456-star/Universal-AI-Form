#!/usr/bin/env bash
# Daily PostgreSQL + uploads backup for the docker-compose stack.
# Install on the VPS (runs at 02:30 every night, keeps 14 days):
#   chmod +x scripts/backup-db.sh
#   (crontab -l 2>/dev/null; echo "30 2 * * * cd /opt/ufa && ./scripts/backup-db.sh >> /var/log/ufa-backup.log 2>&1") | crontab -
# Copy /opt/ufa-backups off the server regularly (e.g. rclone to cloud storage).
# NOTE: encrypted profile fields need DATA_ENCRYPTION_KEYS to be readable — store that key separately.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/ufa-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

docker compose exec -T postgres pg_dump -U ufa_owner -d ufa --format=custom --no-owner > "$BACKUP_DIR/db-$STAMP.dump"
docker compose run --rm --no-deps -v "$BACKUP_DIR:/backup" --entrypoint sh web \
  -c "tar czf /backup/uploads-$STAMP.tar.gz -C /app storage" >/dev/null

find "$BACKUP_DIR" -type f -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: db-$STAMP.dump uploads-$STAMP.tar.gz"
