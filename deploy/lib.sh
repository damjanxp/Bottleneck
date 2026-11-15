# Shared helpers for backup.sh and restore.sh (sourced, not executed).
export MSYS_NO_PATHCONV=1   # Git Bash on Windows must not rewrite /data/... paths
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
DC=(docker compose)
[ -f "$ENV_FILE" ] && DC+=(--env-file "$ENV_FILE")
BACKUP_DIR="${BACKUP_DIR:-/var/backups/bottleneck}"
