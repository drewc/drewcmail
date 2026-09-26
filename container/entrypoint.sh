#!/bin/sh
# First run: write a notmuch-config if there is none (from MAIL_NAME / MAIL_EMAIL, both
# optional — connecting a Gmail account in the web app fills in the address), then start
# the server, which runs `notmuch new` (creating the database) at startup. Arguments replace
# the command (container/dev.sh runs the server under container/dev-server.ts).
set -eu

if [ ! -f "$NOTMUCH_CONFIG" ]; then
  echo "drewcmail: creating $NOTMUCH_CONFIG ${MAIL_EMAIL:+for $MAIL_EMAIL}"
  cat > "$NOTMUCH_CONFIG" <<CONF
[database]
path=/mail

[user]
name=${MAIL_NAME:-}
primary_email=${MAIL_EMAIL:-}

# fresh mail is tagged "new"; the server then moves non-Gmail mail to inbox+unread
# (lieer puts new.tags on everything it pulls, and Gmail's labels already say that)
[new]
tags=new;
ignore=.mbsyncstate;.mbsyncstate.journal;.mbsyncstate.new;.mbsyncstate.lock;.uidvalidity;.proton-bridge;/.*[.](json|lock|bak)$/

[search]
exclude_tags=deleted;spam;

[maildir]
synchronize_flags=true
CONF
fi

mkdir -p /mail
[ $# -gt 0 ] && exec "$@"
exec bun /app/server/index.ts
