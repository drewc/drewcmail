# @drewc/mail

I want to make a webapp mail client that uses notmuchmail and lives in podman. It should interact with external services. It should be using Lit and Tailwind CSS and fontawsome. Because lit componets use shadowdom we should copy the package from ~/src/ecm-live/app/spa/packages and use it. Make a package.json with "@drewc/mail" as the name.

---

A Gmail-ish web client for [notmuch](https://notmuchmail.org), in one podman container:

```
browser ──HTTP──▶ bun server (server/)  ──▶ notmuch   search / show / tag / reply / insert
                   serves dist/ (SPA)    ──▶ lieer     Gmail API ⇄ /mail/gmail/<address>/: labels ⇄ tags, send
                                         ──▶ Bridge    Proton Mail Bridge (gRPC): Proton ⇄ IMAP/SMTP on 127.0.0.1
                                         ──▶ mbsync    IMAP ⇄ /mail/imap/<id>/ (Maildir), then `notmuch new`
                                         ──▶ msmtp     SMTP out, copy filed in the account's Sent folder
```

Every account — Gmail, Proton or any IMAP/SMTP provider — is added in the web app. Nothing to edit or copy by hand.

- **Frontend** (`src/`): Lit components styled with Tailwind 4 and Font Awesome 7. Each component's shadow
  root adopts both sheets (`src/components/base.ts`); `@spinal/shadow-css` (copied from ecm-live into
  `packages/@spinal/shadow-css`, see its README) lifts the `@font-face` / `@property` rules that cannot live in
  a shadow root into the document. `.spinal/` is its generated lift cache — **commit it**.
- **Server** (`server/`): plain `node:http` on [Bun](https://bun.sh), which runs the TypeScript directly (no build step).
  Every call is `spawn(bin, [args])` — no shell — and queries go after `--`.

## Run it

```sh
pnpm install
pnpm podman:build                       # image localhost/drewcmail
pnpm podman:run                         # → http://localhost:8025
```

That's all the setup: on a fresh install the **Accounts** dialog opens (it's also at the bottom of the
sidebar, and in the header on phones). Add as many accounts as you like, of either kind; the first download
starts right away (a big mailbox takes a while — the sync icon spins until it's done).

`container/run.sh` mounts `~/.local/share/drewcmail/mail` at `/mail` and `~/.config/drewcmail` at `/config`,
with `--userns=keep-id` so the files stay yours. Override with `MAIL_DIR`, `CONFIG_DIR`, `BIND`.
To run it as a systemd user service, use the Quadlet unit in `container/drewcmail.container`.

## Gmail

Enter your address, **Sign in with Google**, allow access, and Google sends you back to the app, which
finishes connecting the account.

How it works: each account is a [lieer](https://lieer.gaute.vetsj.com) repository in
`/mail/gmail/<address>/`. The server does the OAuth sign-in itself (lieer's `gmi auth` wants to run its own
browser/web server, which doesn't suit a container) and writes lieer's `.credentials.gmailieer.json`;
from then on every sync runs `gmi push` for all accounts, then `gmi pull` for all (so one account's long first
download never holds back another's push), and tag changes are pushed to Gmail a few seconds after you
make them. Gmail labels are tags (`inbox`, `unread`, `flagged` = starred, `spam`, `sent`, your labels);
the UI's delete is Gmail's Trash (`gmi set --local-trash-tag deleted`). Mail from a Gmail From address
is sent through the Gmail API (`gmi send`), which files it in Sent.

- **Open the app as `http://localhost:8025`** (or 127.0.0.1): Google only redirects back to loopback
  addresses. From another machine, the dialog tells you to paste the address Google ends on instead.
- **If Google refuses lieer's shared OAuth client** ("app blocked", quota): create your own — Google Cloud
  console → enable the Gmail API → Credentials → OAuth client ID → *Desktop app* — and paste its JSON under
  *Use my own Google OAuth client* (or set `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` for every account).
- A sign-in Google has revoked shows as *sync failed* with **Sign in again**. *Disconnect* deletes the
  credentials and keeps the mail.
- Fresh mail is tagged `new` (`new.tags=new`, what lieer needs); after each sync the server moves non-Gmail
  mail to `inbox` + `unread` and drops `new`. Connecting Gmail sets this in an existing notmuch-config too.

## Proton Mail

Proton Mail Bridge is built into the image (from source, headless — `BRIDGE_VERSION` build arg) and
run by the server, which drives it through the gRPC API its desktop GUI uses. In **Accounts → Proton Mail**:

- **the switch** turns Bridge on or off (it stays that way across restarts; a crashed Bridge is restarted);
- **Sign in to Proton** — username and password, then whatever Proton asks for: the two-factor code, the
  mailbox password (two-password accounts), or a human-verification CAPTCHA (a link to open; then
  *continue*). Accounts that sign in *only* with a security key can't be used — a key can't reach a
  container — add an authenticator app. Bridge needs a paid Proton plan;
- per account: Bridge's download progress, **split mode** (one account and From address per Proton
  address instead of one for all), and **Remove** (signs out of Bridge; the mail stays);
- **Bridge settings**: the IMAP and SMTP ports and STARTTLS or SSL/TLS for each.

Each Proton address Bridge serves becomes an ordinary IMAP/SMTP account on `127.0.0.1` (listed with the
others, managed from the Proton section), synced by mbsync and sent through by msmtp over TLS that trusts
Bridge's own certificate (exported to `/config/proton/tls/`). Proton files sent mail in Sent itself, so no
copy is uploaded; Bridge's *All Mail* folder is hidden (it would duplicate everything).

Bridge's secrets live in a keychain — `pass`, with a GPG key the server makes on first use — in
`/config/proton/` along with Bridge's settings; its own copy of the mailbox (encrypted, as big as the
mailbox) in `/mail/.proton-bridge/`, which notmuch skips. Self-updates are off: a new image is the update.

## Any other provider (IMAP/SMTP)

**Add account** → your name, address and password → **Continue**. The server looks the settings up the way
Thunderbird does — the provider's autoconfig, then Thunderbird's ISP database (also through the domain's MX,
so a custom domain hosted at e.g. Fastmail is found), and failing that a guess (`imap.<domain>`,
`smtp.<domain>`). You see the settings, with a hint where the provider needs an app password (iCloud,
Yahoo, Fastmail…), and can change them. **Check and add** logs in to IMAP (mbsync) and SMTP before
anything is saved, so a wrong password or port is reported in words right there. A Google address is
pointed to *Sign in with Google* instead, a Proton address to the Proton section.

The app keeps the accounts in `/config/accounts.json`, the passwords in `/config/passwords/` (mode 600) and
**generates** `/config/mbsyncrc` and `/config/msmtprc` from them (rewritten on every sync, so don't edit
them). Each account syncs to `/mail/imap/<id>/`, one Maildir folder per IMAP folder, both ways: read state
and flags go back to the server, nothing is ever expunged. New mail is tagged by folder: INBOX → `inbox`,
Sent → `sent`, Trash → `deleted`, Junk/Spam → `spam`, Drafts → `draft`; read/unread and starred come from
the IMAP flags. Mail sent from an account's address goes out
through its SMTP server, and a copy goes into its Sent folder (found on the server when the account is
added), which mbsync uploads. **Edit** changes settings (leave the password empty to keep it); **Remove**
forgets the account and its password and keeps the mail.

Without a `notmuch-config`, the container writes one on first start (from `MAIL_EMAIL` / `MAIL_NAME` if
set); adding an account makes its address one of yours (`user.primary_email` / `user.other_email`).

### Environment

| var | default | |
|---|---|---|
| `SYNC_INTERVAL` | `300` | seconds between syncs (lieer, mbsync, notmuch new); `0` = only on demand |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | lieer's | your own Google OAuth desktop client, for all Gmail accounts |
| `MAIL_USER`, `MAIL_PASSWORD` | — | set both to require HTTP Basic auth (do this if you publish beyond localhost) |
| `PORT`, `HOST` | `8025`, `0.0.0.0` | |
| `NOTMUCH_CONFIG`, `CONFIG_DIR`, `MAIL_ROOT` | `/config/notmuch-config`, `/config`, `/mail` | |

## Develop

pnpm is the package manager, Bun the runtime. Bun comes with `pnpm install`: `package.json` pins it as the
project's runtime (`devEngines.runtime`, Bun 1.4.2 — the version in the image), pnpm downloads it
(checksummed in the lockfile) into `node_modules/.bin`, and the scripts run Vite and the server with it.
Nothing to install system-wide; `pnpm exec bun …` for anything else.

The easiest loop is the dev pod — the image's tools with this source tree bind-mounted, so nothing is
rebuilt or restarted by hand:

```sh
pnpm podman:dev      # sh container/dev.sh: SPA with Vite on http://localhost:5174, server on 127.0.0.1:8026
sh container/dev.sh logs   # follow the logs again (Ctrl-C only stops following)
sh container/dev.sh stop   # stop and remove the pod
```

Saving under `src/` reloads the page (Vite; Lit elements cannot be redefined, so a full reload rather than
HMR); saving under `server/` restarts the server (`container/dev-server.ts`, which watches the directory —
`bun --watch` loses files that editors save by renaming). It uses its own data, `~/.local/share/drewcmail-dev/mail`
and `~/.config/drewcmail-dev` (`MAIL_DIR`/`CONFIG_DIR` to change — never the live ones while `drewcmail` runs:
one notmuch database, one Bridge). Rebuild the image only for Containerfile or package changes.
The ports are not the defaults (Vite's 5173, the container's 8025), so a host `pnpm dev` and the live
`drewcmail` container can keep running; `VITE_BIND`/`API_BIND` to change them.

Or piece by piece:

```sh
pnpm podman:run      # the API (or: pnpm server — bun server/index.ts — if notmuch is installed on the host)
pnpm dev             # vite (under bun) on :5173, /api proxied to 127.0.0.1:8025 (MAIL_API to change)
pnpm check           # tsc for src/ and server/
pnpm build           # dist/ — see packages/@spinal/shadow-css/README.md for the checks
```

## Using it

Searches are notmuch queries (`from:alice date:1w..`, `tag:work and not tag:replied`); the hash
holds the state (`#q=<query>&t=<thread>`), so back/forward and bookmarks work. Tags are the folders:
archive removes `inbox`, delete adds `deleted`, spam adds `spam` (both excluded from searches by
`search.exclude_tags`), star is `flagged`. Opening a thread removes `unread`.

Keys: `j`/`k` move · `o`/Enter open · `u`/Esc back · `e` archive · `#` delete · `!` spam · `s` star ·
`U`/`I` unread/read · `r` reply · `a` reply all · `c` compose · `/` search · `g` fetch mail ·
Ctrl+Enter send. Right-click a conversation for a menu of the same actions.

### Filters

Right-click a conversation → **Filter messages like this…** (or **Filters** in the sidebar): match on
From/To/Subject/words — the form writes a notmuch query, which you can edit — and choose what happens:
skip the inbox, mark read, star, apply a label, delete (Trash), mark as spam. To *move* mail into a label,
apply the label and skip the inbox. "Also apply to the … already matching" tags the mail you have now.

New mail is filtered by [afew](https://afew.readthedocs.io/): the server keeps the list in
`/config/filters.json` and writes `/config/afew/config` from it (one generic `[Filter.N]` section per filter),
then runs `afew --tag --new` in every sync — after the folder rules and before `new` is dropped, which
is the job afew's usual `post-new` hook does. Gmail sees the result as labels on the next push.

HTML mail is shown in a sandboxed iframe (no scripts, CSP) with remote images blocked until you ask;
`cid:` images come from the message. Attachments are served with the type notmuch reports,
`Content-Security-Policy: sandbox`, and as downloads unless they are images.

## API

| | |
|---|---|
| `GET /api/search?q=&offset=&limit=` | `notmuch search` |
| `GET /api/count?q=…&q=…` | thread counts per query |
| `GET /api/tags` | all tags |
| `GET /api/version` | `{entry}`: the script `dist/index.html` loads now — the app asks to reload when it is not its own |
| `GET /api/identities`, `POST /api/identities {identities: [{email, name}]}` | the From addresses and their names, the first the default (`/config/identities.json`, mirrored into notmuch's `user.*`) |
| `GET /api/thread/:id` | `notmuch show --entire-thread --include-html` |
| `GET /api/message/:id/reply?to=all\|sender` | `notmuch reply` |
| `GET /api/message/:id/part/:n[?download]`, `/raw` | a part's bytes, the whole message |
| `POST /api/tag {query, add, remove}` | `notmuch tag` |
| `POST /api/send {from, to, cc, bcc, subject, text, inReplyTo, references, attachments}` | through the From address's account: `gmi send`, or msmtp + `notmuch insert` into its Sent |
| `GET /api/filters` | the filters |
| `POST /api/filters {filter: {id?, name, query, add, remove, criteria?}, apply?}` | add/replace (writes afew's config); `apply` also tags the mail matching now |
| `DELETE /api/filters/:id` | remove a filter (tags already applied stay) |
| `GET/POST /api/sync` | state / run gmi push (all accounts), gmi pull (all) + mbsync + notmuch new |
| `GET /api/proton` | Bridge: on/off, running, version, ports, users with sync progress |
| `POST /api/proton/enabled {enabled}` | start / stop Bridge (remembered) |
| `POST /api/proton/login {username, password}`, then `{code}` / `{mailboxPassword}` / `{verified: true}` / `{abort: true}` | sign-in one step at a time; each answer names the next (`2fa`, `mailbox`, `hv` + url, `done`) |
| `POST /api/proton/settings {imapPort, smtpPort, useSSLForImap, useSSLForSmtp}` | Bridge's IMAP/SMTP servers |
| `POST /api/proton/users/:id/split {active}`, `DELETE /api/proton/users/:id` | split mode, remove |
| `GET /api/imap` | IMAP/SMTP accounts and their sync state (no passwords) |
| `GET /api/imap/discover?email=` | the servers for an address (autoconfig, ISPDB, MX, guess) |
| `POST /api/imap {id?, name, email, imap, smtp, imapPassword?, smtpPassword?}` | test and save; writes mbsyncrc/msmtprc |
| `DELETE /api/imap/:id` | remove an account (keeps its mail) |
| `GET /api/gmail` | Gmail accounts and their sync state |
| `POST /api/gmail/start {email, redirect, client?}` | the Google consent URL |
| `POST /api/gmail/finish {url}` | the address Google redirected to → credentials, first pull |
| `DELETE /api/gmail/:email` | forget an account's credentials |

POSTs must be `application/json`. That rules out cross-site form posts.
