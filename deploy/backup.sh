#!/usr/bin/env bash
# Bottleneck backup: pg_dump (custom format) + the uploads volume, bundled, encrypted, optionally
# copied off-box with rclone, with local and remote retention.
#
# Targets: RPO 24 h (nightly run; at most one day of venues/uploads lost), RTO 1 h (fresh VPS:
# install Docker, clone repo, restore .env, `docker compose up -d`, deploy/restore.sh).
#
# Setup (on the VPS, as the user that runs docker):
#   cp deploy/.env.example .env && chmod 600 .env        # secrets stay untracked, owner-only
#   set BACKUP_GPG_RECIPIENT (public key imported with `gpg --import`) or BACKUP_PASSPHRASE_FILE
#   optional off-box: rclone config; BACKUP_RCLONE_REMOTE=remote:bucket/path
# Nightly via cron (crontab -e):
#   17 3 * * *  cd /opt/bottleneck && deploy/backup.sh >> /var/log/bottleneck-backup.log 2>&1
# or a systemd timer: a oneshot bottleneck-backup.service running deploy/backup.sh and
#   [Timer] OnCalendar=*-*-* 03:17:00  Persistent=true   (bottleneck-backup.timer)
# Test a restore regularly (deploy/restore.sh against a scratch stack); an untested backup is a hope.
# BACKUP_ALLOW_UNENCRYPTED=1 exists only for local testing.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
WORK="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if [ -z "${BACKUP_GPG_RECIPIENT:-}" ] && [ -z "${BACKUP_PASSPHRASE_FILE:-}" ] && [ "${BACKUP_ALLOW_UNENCRYPTED:-}" != 1 ]; then
  echo "refusing to write an unencrypted backup: set BACKUP_GPG_RECIPIENT or BACKUP_PASSPHRASE_FILE" >&2; exit 1
fi

echo "[$STAMP] dumping database"
"${DC[@]}" exec -T db pg_dump -U bottleneck -d bottleneck --format=custom --no-owner > "$WORK/db.dump"
echo "[$STAMP] archiving uploads"
"${DC[@]}" run --rm --no-deps -T --entrypoint tar api -C /data/uploads -cf - . > "$WORK/uploads.tar"
( cd "$WORK" && sha256sum db.dump uploads.tar > SHA256SUMS )
tar -C "$WORK" -cf "$WORK/bundle.tar" db.dump uploads.tar SHA256SUMS

OUT="$BACKUP_DIR/bottleneck-$STAMP.tar"
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always --encrypt -r "$BACKUP_GPG_RECIPIENT" -o "$OUT.gpg" "$WORK/bundle.tar"; OUT="$OUT.gpg"
elif [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --symmetric --cipher-algo AES256 -o "$OUT.gpg" "$WORK/bundle.tar"; OUT="$OUT.gpg"
else
  cp "$WORK/bundle.tar" "$OUT"
fi
chmod 600 "$OUT"
echo "[$STAMP] wrote $OUT ($(wc -c < "$OUT") bytes)"

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  rclone copy "$OUT" "$BACKUP_RCLONE_REMOTE"
  rclone delete --min-age "${RETAIN_DAYS}d" "$BACKUP_RCLONE_REMOTE" --include 'bottleneck-*.tar*'
  echo "[$STAMP] copied to $BACKUP_RCLONE_REMOTE"
else
  echo "[$STAMP] BACKUP_RCLONE_REMOTE not set: local copy only, NOT off-box" >&2
fi
find "$BACKUP_DIR" -maxdepth 1 -name 'bottleneck-*.tar*' -mtime "+$RETAIN_DAYS" -delete
echo "[$STAMP] done"
