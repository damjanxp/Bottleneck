#!/usr/bin/env bash
# Restore a backup made by deploy/backup.sh into the running compose stack (db must be up).
#   deploy/restore.sh /var/backups/bottleneck/bottleneck-20261113T031700Z.tar.gpg
# Decrypts with gpg (private key in the keyring, or BACKUP_PASSPHRASE_FILE), stops the API,
# drops and recreates the database, pg_restores it, restores the uploads volume, starts the API.
# DESTROYS current data. RPO 24 h / RTO 1 h (see backup.sh). Fresh-VPS recovery: install Docker,
# clone the repo, put .env back (chmod 600), `docker compose up -d --build db`, fetch the backup
# from off-box storage (rclone copy), run this script, `docker compose up -d`.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
FILE="${1:?usage: restore.sh <backup file>}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

case "$FILE" in
  *.gpg)
    if [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
      gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" -o "$WORK/bundle.tar" --decrypt "$FILE"
    else
      gpg --batch --yes -o "$WORK/bundle.tar" --decrypt "$FILE"
    fi ;;
  *) cp "$FILE" "$WORK/bundle.tar" ;;
esac
tar -C "$WORK" -xf "$WORK/bundle.tar"
( cd "$WORK" && sha256sum -c SHA256SUMS )

"${DC[@]}" up -d --wait db
"${DC[@]}" stop caddy api
"${DC[@]}" exec -T db psql -U bottleneck -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS bottleneck WITH (FORCE)" -c "CREATE DATABASE bottleneck OWNER bottleneck"
"${DC[@]}" exec -T db pg_restore -U bottleneck -d bottleneck --no-owner --exit-on-error < "$WORK/db.dump"
# Uploads: clear, then unpack (as the api's unprivileged user).
"${DC[@]}" run --rm --no-deps -T --entrypoint sh api -c 'find /data/uploads -mindepth 1 -delete'
"${DC[@]}" run --rm --no-deps -T --entrypoint tar api -C /data/uploads -xf - < "$WORK/uploads.tar"
"${DC[@]}" up -d --wait
echo "restore complete"
