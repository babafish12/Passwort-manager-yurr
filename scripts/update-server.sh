#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${YURRR_SERVICE_NAME:-yurrr}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${YURRR_REPO_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
SERVER_DIR="${YURRR_SERVER_DIR:-$REPO_DIR/server}"
BACKUP_DIR="${YURRR_BACKUP_DIR:-$SERVER_DIR/backups}"
ALLOW_DIRTY="${YURRR_ALLOW_DIRTY:-0}"
SKIP_BACKUP="${YURRR_SKIP_BACKUP:-0}"

log() {
  printf '\n==> %s\n' "$*"
}

run_sudo() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

backup_database() {
  local db_path="$SERVER_DIR/vault.db"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"

  if [[ "$SKIP_BACKUP" == "1" ]]; then
    log "Skipping database backup because YURRR_SKIP_BACKUP=1"
    return
  fi

  if [[ ! -f "$db_path" ]]; then
    log "No vault.db found at $db_path; skipping backup"
    return
  fi

  log "Backing up vault database"
  mkdir -p "$BACKUP_DIR/$stamp"

  for file in "$SERVER_DIR/vault.db" "$SERVER_DIR/vault.db-wal" "$SERVER_DIR/vault.db-shm"; do
    if [[ -e "$file" ]]; then
      cp -a "$file" "$BACKUP_DIR/$stamp/"
    fi
  done

  printf 'Backup written to %s\n' "$BACKUP_DIR/$stamp"
}

require_cmd git
require_cmd cargo
require_cmd systemctl

cd "$REPO_DIR"

if [[ ! -d .git ]]; then
  printf 'Not a git repository: %s\n' "$REPO_DIR" >&2
  exit 1
fi

if [[ ! -d "$SERVER_DIR" ]]; then
  printf 'Server directory not found: %s\n' "$SERVER_DIR" >&2
  exit 1
fi

if [[ "$ALLOW_DIRTY" != "1" && -n "$(git status --porcelain)" ]]; then
  printf 'Working tree is dirty. Commit/stash first, or run with YURRR_ALLOW_DIRTY=1.\n' >&2
  git status --short >&2
  exit 1
fi

log "Pulling latest code"
git fetch --prune
git pull --ff-only

log "Building server release binary"
cargo build --release --manifest-path "$SERVER_DIR/Cargo.toml"

log "Stopping $SERVICE_NAME"
run_sudo systemctl stop "$SERVICE_NAME"

backup_database

log "Starting $SERVICE_NAME"
run_sudo systemctl daemon-reload
run_sudo systemctl start "$SERVICE_NAME"

log "Service status"
run_sudo systemctl --no-pager --full status "$SERVICE_NAME"

log "Done"
