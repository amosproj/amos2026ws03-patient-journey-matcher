#!/bin/bash
# Dumps the database (pg_dump custom format) into BACKUP_DIR and keeps the newest 7 dumps.
# matcher-backup.timer of deploy/vm-setup.sh runs it every night; restore:
# Documentation/build-deploy/deployment.md#backups-and-cleanup.
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/var/backups/matcher}
KEEP=7

file="$BACKUP_DIR/matcher-$(date -u +%F).dump"
# Written under another name first, so a failed dump never replaces or rotates out a good one.
trap 'rm -f "$file.part"' EXIT
docker exec amos-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$file.part"
mv "$file.part" "$file"
ls -1t "$BACKUP_DIR"/matcher-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm --
echo "backup: $file ($(du -h "$file" | cut -f1))"
