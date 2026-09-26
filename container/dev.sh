#!/bin/sh
# Develop inside the image without rebuilding it: a podman pod with this source tree bind-mounted at /app.
#   server  the image's own tools (notmuch, lieer, afew, mbsync, msmtp, Bridge) running server/ from the
#           working copy; container/dev-server.ts restarts it when a file under server/ changes
#   vite    the SPA with hot module reload on http://localhost:5174, /api proxied to the server —
#           not Vite's usual 5173, so a host `pnpm dev` (5173) and the live container (8025) can run alongside
#
#   sh container/dev.sh          start (replacing a running dev pod) and follow the logs; Ctrl-C only stops following
#   sh container/dev.sh logs     follow the logs again
#   sh container/dev.sh stop     stop and remove the pod
#
# Needs the image (pnpm podman:build) and node_modules (pnpm install) — both are mounted from here, so the
# image only needs rebuilding when the Containerfile or the system packages change.
# Everything is overridable from the environment:
#   MAIL_DIR     the Maildir on the host         (~/.local/share/drewcmail-dev/mail)
#   CONFIG_DIR   notmuch-config and the accounts set up in the app (~/.config/drewcmail-dev)
#   VITE_BIND    host address:port for the SPA  (127.0.0.1:5174); Vite listens on the same port inside
#   API_BIND     host address:port for the server itself (127.0.0.1:8026)
#   MAIL_NAME, MAIL_EMAIL, MAIL_USER, MAIL_PASSWORD, SYNC_INTERVAL,
#   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET — passed through to the server
# The data directories are separate from run.sh's on purpose: two servers must never share one notmuch
# database (or run two Bridges). Point MAIL_DIR/CONFIG_DIR at the real ones only with the drewcmail container stopped.
set -eu

POD=drewcmail-dev
IMAGE=${IMAGE:-localhost/drewcmail}
SRC=$(cd "$(dirname "$0")/.." && pwd)

case "${1:-start}" in
  stop) exec podman pod rm -f "$POD" ;;
  logs) exec podman pod logs -f --color "$POD" ;;
  start) ;;
  *) echo "usage: $0 [start|logs|stop]" >&2; exit 2 ;;
esac

MAIL_DIR=${MAIL_DIR:-$HOME/.local/share/drewcmail-dev/mail}
CONFIG_DIR=${CONFIG_DIR:-$HOME/.config/drewcmail-dev}
VITE_BIND=${VITE_BIND:-127.0.0.1:5174}
VITE_PORT=${VITE_BIND##*:}
API_BIND=${API_BIND:-127.0.0.1:8026}
[ -d "$SRC/node_modules/vite" ] || { echo "$0: no node_modules — run pnpm install first" >&2; exit 1; }
podman image exists "$IMAGE" || { echo "$0: no image $IMAGE — run pnpm podman:build first" >&2; exit 1; }
mkdir -p "$MAIL_DIR" "$CONFIG_DIR"

env_args=""
for v in MAIL_NAME MAIL_EMAIL MAIL_USER MAIL_PASSWORD SYNC_INTERVAL GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET; do
  eval "set_=\${$v+x}"
  [ -n "$set_" ] && env_args="$env_args -e $v"
done

# keep-id: the containers' `bun` user (1000) is you, so what they write (the Maildir, .spinal/, Vite's cache) stays yours.
# One network namespace for the pod: Vite reaches the server at 127.0.0.1:8025, its default MAIL_API.
podman pod create --replace --name "$POD" \
  --userns=keep-id:uid=1000,gid=1000 \
  -p "$VITE_BIND:$VITE_PORT" \
  -p "$API_BIND:8025" >/dev/null

# the source is mounted with :z (shared) because both containers use it; the entrypoint too, so a change to it
# needs no rebuild either
# shellcheck disable=SC2086
podman run -d --pod "$POD" --name "$POD-server" \
  -v "$SRC:/app:z" \
  -v "$SRC/container/entrypoint.sh:/usr/local/bin/drewcmail-entrypoint:ro,z" \
  -v "$MAIL_DIR:/mail:Z" \
  -v "$CONFIG_DIR:/config:Z" \
  -e NODE_ENV=development \
  $env_args \
  "$IMAGE" bun /app/container/dev-server.ts >/dev/null

podman run -d --pod "$POD" --name "$POD-vite" \
  -v "$SRC:/app:z" \
  -w /app \
  --entrypoint '["tini", "--"]' \
  -e VITE_CACHE_DIR=node_modules/.vite-dev-pod \
  "$IMAGE" bun --bun node_modules/vite/bin/vite.js --host 0.0.0.0 --port "$VITE_PORT" --strictPort >/dev/null

echo "drewcmail dev: http://localhost:$VITE_PORT (server on http://$API_BIND) — edit server/ or src/, no restart needed"
echo "logs follow; Ctrl-C stops following, not the pod ($0 stop does)"
exec podman pod logs -f --color "$POD"
