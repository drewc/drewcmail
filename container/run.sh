#!/bin/sh
# Run drewcmail with rootless podman. Everything is overridable from the environment:
#   MAIL_DIR     the Maildir on the host         (~/.local/share/drewcmail/mail)
#   CONFIG_DIR   notmuch-config and the accounts set up in the app (~/.config/drewcmail)
#   BIND         host address:port to publish    (127.0.0.1:8025)
#   MAIL_NAME, MAIL_EMAIL, MAIL_USER, MAIL_PASSWORD, SYNC_INTERVAL,
#   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET — passed through
set -eu

IMAGE=${IMAGE:-localhost/drewcmail}
MAIL_DIR=${MAIL_DIR:-$HOME/.local/share/drewcmail/mail}
CONFIG_DIR=${CONFIG_DIR:-$HOME/.config/drewcmail}
BIND=${BIND:-127.0.0.1:8025}
mkdir -p "$MAIL_DIR" "$CONFIG_DIR"

env_args=""
for v in MAIL_NAME MAIL_EMAIL MAIL_USER MAIL_PASSWORD SYNC_INTERVAL GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET; do
  eval "set_=\${$v+x}"
  [ -n "$set_" ] && env_args="$env_args -e $v"
done

# keep-id: the container's `bun` user (1000) is you, so the files on the host stay yours
# shellcheck disable=SC2086
exec podman run -d --replace --name drewcmail \
  --userns=keep-id:uid=1000,gid=1000 \
  -p "$BIND:8025" \
  -v "$MAIL_DIR:/mail:Z" \
  -v "$CONFIG_DIR:/config:Z" \
  $env_args \
  "$IMAGE"
