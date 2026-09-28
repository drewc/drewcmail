# drewcmail (`@drewc/mail`)

A Gmail-style web mail client over **notmuch**, living in one **podman** container. **Lit 3 + TypeScript + Vite 8 +
Tailwind 4 + Font Awesome 7** in the browser; a small **Bun** server (`node:http`, no framework) that wraps the notmuch
CLI (and **afew** for filters) and talks to the outside world through **lieer** (Gmail API), **mbsync/msmtp** (IMAP/SMTP) and a built-in **Proton
Mail Bridge** (gRPC). Every account is added in the web app — no config file is edited or copied by hand. Also read
`packages/@spinal/shadow-css/AGENTS.md`; the user-facing story is in `README.md`.

## Commands

**pnpm is the package manager, Bun the runtime.** Bun is not installed system-wide: `package.json` pins it with
`devEngines.runtime` (bun 1.4.2, `onFail: download`, checksummed in `pnpm-lock.yaml`), so `pnpm install` puts it in
`node_modules/.bin` and the scripts use it. Keep that version equal to the image's (`oven/bun:1-slim`).

| | |
|---|---|
| `pnpm install` | deps + Bun |
| `pnpm check` | `tsc` for `src/` and `tsc -p server` — **the only gate**; run it after every change |
| `pnpm build` | `tsc && bun --bun vite build` → `dist/` |
| `pnpm dev` | Vite under Bun on http://localhost:5173 (localhost, not 127.0.0.1), `/api` proxied to `MAIL_API` (default `http://127.0.0.1:8025`, i.e. the container) |
| `pnpm server` | `bun server/index.ts` — needs `notmuch` etc. on the host, so normally use the container |
| `pnpm podman:build` / `pnpm podman:run` | image `localhost/drewcmail` (`--format docker` for the HEALTHCHECK) / `container/run.sh` |
| `pnpm podman:dev` | `container/dev.sh`: pod `drewcmail-dev` with the source bind-mounted — Vite on :5174 (not 5173: a host `pnpm dev` can run too; page reload on `src/`), server on :8026 restarted on `server/` changes; `dev.sh logs` / `dev.sh stop`; own data dirs (`*-dev`) |

- **`pnpm add -D bun` is wrong** in pnpm 12: it records Bun as the *package manager* (`devEngines.packageManager`) and
  pnpm then refuses to run. Bun is added as `bun@runtime:<version>`.
- pnpm 12 fails installs on unreviewed build scripts: `pnpm-workspace.yaml` → `allowBuilds` (`protobufjs: false`).
- `.spinal/` (the shadow-css lift cache) is generated but **committed**; a fresh clone without it needs two builds
  for icons. `dist/` is not committed (the image builds it).

## Layout

```
server/                         Bun, TypeScript run directly; imports use .ts extensions (erasableSyntaxOnly)
  index.ts      HTTP: route table (route('GET', '/api/x/:id', h)), JSON helpers, static dist/ with SPA fallback,
                optional Basic auth (MAIL_USER/MAIL_PASSWORD), startup `notmuch new`, SYNC_INTERVAL timer, proton.boot()
  exec.ts       exec(bin, args, input?, {timeout, env, onStdout}) — spawn with an argv, never a shell; ExecError {code, stderr}
  notmuch.ts    the notmuch CLI: search/count/tags/show/reply/tag/insert/new (--format-version=5, queries after `--`),
                idQuery()/threadQuery(), config get/set (file AND --database), identities()/setIdentities()/addIdentity() (/config/identities.json, mirrored into user.*),
                ignore(pattern), prepareForLieer(), tagNew(rules), BadRequest (→ HTTP 400)
  mail.ts       sync(): one run at a time through exclusive() (lieer, mbsync and notmuch must not overlap):
                gmail.syncAll (gmi push for every account, then gmi pull for every one) → imap.syncAll(proton.skipReason) → notmuch new → tagNew(imap.newMailRules())
                → filters.runNew() (afew) → doneNew() (−new);
                schedulePush() (tags → Gmail after 5 s); send(): nodemailer streamTransport composes, then the From
                address picks gmail.send / imap.send; withoutBcc()
  activity.ts   what is running now: begin(what, {waiting}) → {set(detail), end()}, track(what, fn); GET /api/activity.
                exclusive(what, fn) shows queued work as waiting; gmail/imap/notmuch/afew steps and Bridge syncs are tracked
  filters.ts    filters (query → add/remove tags): /config/filters.json → generated /config/afew/config
                ([Filter.N] sections); runNew() = `afew --tag --new` with XDG_CONFIG_HOME=/config; save(apply)
                also `notmuch tag`s the mail matching now
  gmail.ts      lieer accounts in /mail/gmail/<address>/: our own OAuth (PKCE, loopback redirect to the SPA) writes
                .credentials.gmailieer.json; `gmi init --no-auth`, `gmi set --local-trash-tag deleted --ignore-tags-local new`,
                `gmi push|pull|send -t` (push all before pulling any: a first download can take hours); run with
                --no-progress (not --quiet): lieerProgress() turns `phase (N) ...` + a dot per 10 items into activity detail
                ("receiving metadata: 14,320 of 209,444 (7%)") and logs the lines; lieerError() turns tracebacks into one line
  imap.ts       IMAP/SMTP accounts: /config/accounts.json + /config/passwords/<id>.{imap,smtp} (0600) → generated
                /config/mbsyncrc + /config/msmtprc (rewritten every sync); test() = `mbsync --list` in a temp config +
                nodemailer verify(); save() (HTTP) vs saveAccount() (internal, may set proton/ca); discover() =
                autoconfig → ISPDB → ISPDB via MX → guess, HINTS for app passwords; newMailRules() (folder → tags); explain()
  proton.ts     Proton Mail Bridge: keychain (`pass` + a passphrase-less GPG key), spawn `bridge --grpc --no-window
                --parent-pid`, gRPC client (@grpc/grpc-js, proto-loader on proton/bridge.proto), event stream, login
                steps, reconcile() users → IMAP accounts on 127.0.0.1 trusting the exported cert, settings, split mode
  proton/bridge.proto           copied from proton-bridge (GPL-3.0) at the pinned BRIDGE_VERSION — refresh it with the version
src/
  main.ts       imports virtual:spinal-lift.css (document-side fonts/@property) and <mail-app>
  api.ts        typed fetch wrappers for every /api route; types.ts = notmuch JSON + API types
  body.ts       choosing parts (leaves(), attachments(), cidMap()), plainText()/htmlToText(), prepareHtml() (sanitise +
                cid: + remote-image blocking + CSP for the iframe)
  format.ts     dates, displayName(), HIDDEN_TAGS (state tags not shown as labels), humanSize()
  components/
    base.ts         BaseElement: adopts tailwind.css + Font Awesome (?inline) into every shadow root, data-theme from
                    prefers-color-scheme, emit(name, detail) = bubbling + composed CustomEvent; fa(icon, style)
    tailwind.css    `@custom-variant dark (:host([data-theme=dark]) &)` — `dark:` works per host
    app.ts          <mail-app>: hash state (#q=<query>&t=<thread>), search results, keyboard shortcuts, drafts,
                    toasts, sync button, OAuth return (?state&code → /api/gmail/finish), opens <mail-accounts>;
                    spinner: polls /api/activity (5 s, 1.5 s while open), spins while anything runs; click = fetch
                    mail when idle, else a popover of what is running (step, lieer progress, elapsed, waiting) + last sync;
                    new-version modal: its entry chunk (import.meta.url, hashed) ≠ /api/version's → Reload / Not now
                    (checked on focus/visibility and every 5 min; not under Vite dev)
    sidebar.ts      folders (saved queries), tags, unread counts, Accounts
    thread-list.ts  results, quick actions, right-click menu (… → "Filter messages like this" = `filters {thread}`); thread-view.ts: a thread, marks read; message.ts: one message
                    (headers, text with folded quotes, HTML in a sandboxed iframe, attachments, reply/forward, tags; a ⋮ menu by
                    the date: reply, reply all, forward, add tag — tags are comma-separated, spaces allowed)
    compose.ts      docked compose windows (From = notmuch identities), attachments as base64
    accounts.ts     the Accounts dialog: Gmail (OAuth + paste fallback), <mail-proton>, IMAP list + <mail-imap-form>
    filters.ts      the Filters dialog: list, and a form (From/To/Subject/words → query, live count, actions
                    ⇄ add/remove tags, apply to existing); with `thread` it opens on a filter prefilled from it
    imap-form.ts    add/edit an IMAP/SMTP account: name/email/password → discover → review → check and save
    identities.ts   Send as: every From address with its name, the default, add an alias, remove
    proton.ts       Bridge on/off, sign-in steps, users (progress, split mode, remove), ports/security
container/      entrypoint.sh (writes notmuch-config on first run, exec bun — or its arguments), run.sh (podman run, keep-id),
                gmi (lieer with a fresh connection for pushing — see Rules),
                drewcmail.container (Quadlet), dev.sh (the dev pod: source at /app, entrypoint.sh mounted over the image's),
                dev-server.ts (restarts the server on server/ changes: fs.watch on the directory, SIGTERM, start —
                not `bun --watch`, which loses rename-saved files)
Containerfile   stages: bridge (golang, `make build-nogui`) → pnpm (oven/bun + `bun add -g pnpm@12`) → build → prod → runtime (oven/bun:1-slim + notmuch lieer afew isync msmtp tini libsecret libfido2 pass gnupg)
```

## Events (components → `<mail-app>`)

All via `this.emit()` (bubbles, composed — they cross shadow roots): `search {q}`, `open-thread {id|null}`,
`compose {Draft}`, `changed` (tags changed: re-run the search, reload the thread, refresh the sidebar), `toast {text}`,
`sync`, `accounts` (open the dialog), `filters {thread?}` (open the filters dialog, on a new filter from that thread), `sync-started` (an account was added: poll /api/sync until done), `identities-changed` (reload the From addresses). Dialog-local:
`close`, `saved`, `cancel`, `use-gmail {email}`, `use-proton`.

## Data and tags

- `/mail` = notmuch `database.path`: `gmail/<address>/` (lieer repos), `imap/<id>/` (one Maildir folder per IMAP
  folder; Proton accounts too), `.proton-bridge/` (Bridge's cache — in `new.ignore`), `.notmuch/`.
- `/config`: `notmuch-config`, `accounts.json`, `passwords/`, `filters.json`, generated `afew/config`, generated `mbsyncrc`/`msmtprc`, `proton/`
  (`settings.json` {enabled}, `gnupg/`, `password-store/`, `config/` = Bridge's XDG config, `tls/cert.pem`).
- **`new.tags=new`** (lieer puts new.tags on everything it pulls). After each `notmuch new`, `tagNew()`: IMAP rules by
  folder (INBOX → inbox, Sent → sent −unread, Trash → deleted, Junk/Spam → spam, Drafts → draft), anything not under
  `gmail/` or `imap/` → inbox + unread; then the user's filters (afew, on `tag:new`), then `doneNew()` −new everywhere. Read/unread and flagged come from maildir flags
  (`maildir.synchronize_flags`). `notmuch insert` of a sent copy removes `new` itself.
- UI tag vocabulary = Gmail's through lieer: `inbox`, `unread`, `flagged` (starred), `spam`, `deleted` (trash),
  `sent`, `attachment`, `replied`. `search.exclude_tags=deleted;spam`.
- Identities (From choices) = `/config/identities.json`, `[{email, name}]`, the first the default — each address has its own
  name (notmuch has one `user.name`). Until it exists they come from `user.*` (a template's "Your Name" reads as no name).
  `setIdentities()` mirrors them into `user.primary_email`/`other_email`/`name` (for `notmuch reply`, lieer). Every account
  added calls `addIdentity()`. Compose swaps a reply's From (notmuch's `user.name`) for that address's own name.
  Edited in Accounts → Send as (`<mail-identities>`, emits `identities-changed`).

## Rules learned the hard way

- **Never go through a shell**: `exec()` with an argv; user queries always after `--`; tag names validated; thread ids
  `^[0-9a-f]{16}$`; message ids quoted with `idQuery()` (doubled `"`).
- **Bcc**: nodemailer's streamTransport *keeps* Bcc. msmtp gets `withoutBcc(raw)` + an explicit envelope; the Sent copy
  keeps it; `gmi send -t` needs it (Gmail strips it).
- **HTML mail** only in `<iframe sandbox="allow-same-origin allow-popups…">` (no allow-scripts) with a CSP meta and
  `prepareHtml()`; parts are served with notmuch's content type, `Content-Security-Policy: sandbox`, nosniff, and as
  downloads unless images. POSTs must be `application/json` (no cross-site forms).
- mbsync: the Near store directory must exist even for `--list`; `TLSType None` needs `AuthMechs LOGIN`; `Create Both`
  (so an inserted Sent folder reaches the server); `Expunge None`, `Remove None`. msmtp: plaintext needs `auth plain`.
  Test SMTP logins with nodemailer `verify()` — msmtp cannot log in without sending.
- Lit forms: update state from the *current* value (`this[kind] = {...this[kind], ...patch}`), not a render-time
  copy — autofill fires several inputs before a re-render. Don't name methods `remove` on elements.
- **afew** (3.0.1, Debian): config only at `$XDG_CONFIG_HOME/afew/config` (no option); it is Python's ConfigParser, so
  `%` → `%%` and one line per value; `tags` is `;`-separated (tags with `;` are refused). No filter sections = no
  filters (3.x has no default chain). It tags through the Python bindings, which do **not** sync maildir flags —
  `doneNew()` runs after it through the CLI, which does. Not a notmuch `post-new` hook: the folder rules run after
  `notmuch new` returns, and filters must come after them.
- **lieer pushes**: a push looks up every changed message, then resolves the changes locally without a request
  (≈10 min for 200k); Google drops the idle keep-alive connection and the first push batch dies with BrokenPipe —
  every time. `container/gmi` (on PATH before /usr/bin/gmi) empties httplib2's pool before push_changes(); the
  requests carry the client's http, so it is emptied in place. lieer saves its push point (`lastmod`) only when
  every change went through — a change made in Gmail meanwhile means a full re-review next time (`--force` pushes
  over it). A full pull sets `lastmod`; a partial pull does not. A notmuch writer during a long push can break its
  read snapshot (XapianError) — keep the database quiet for big pushes.
- Shell heredocs that write config (`entrypoint.sh`): no backticks in the text — they run.
- **Proton/gRPC**: the `bytes` password fields hold base64 *text* — send `Buffer.from(base64String)`, not the string
  (protobufjs would decode it). The gRPC/IMAP cert is for IP 127.0.0.1: name the channel `localhost` and check the cert
  against 127.0.0.1 in `checkServerIdentity` (IP server names are deprecated). Call `GuiReady` before anything; one
  event stream only. Auto-update off, All Mail hidden (duplicates). Security-key-only accounts cannot log in.
- **Gmail OAuth**: Google only redirects to loopback for desktop clients, so the redirect is the SPA's own origin when
  it is localhost/127.0.0.1, otherwise the user pastes the final URL. lieer's shared client is the default;
  `GMAIL_CLIENT_ID/SECRET` or a pasted client JSON override it.

## Testing

No test suite; `pnpm check` plus end-to-end runs of the image:

- **IMAP/SMTP**: GreenMail on a podman network — `podman network create dmtest`; `podman run -d --name greenmail
  --network dmtest -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0
  -Dgreenmail.users=alice:secret@example.com,bob:hunter2@example.com -Dgreenmail.users.login=email'
  docker.io/greenmail/standalone`; run the image on the same network with `SYNC_INTERVAL=0` and add accounts at host
  `greenmail`, ports 3143/3025, security `none` (3993/3465 are TLS with a self-signed cert — good for the TLS error path).
- **Proton**: `POST /api/proton/enabled {enabled:true}` starts Bridge (keychain, gRPC, cert export); a made-up login
  must come back "Wrong username or password"; `POST /api/proton/settings` with SSL on other ports, then
  `openssl s_client -CAfile /config/proton/tls/cert.pem -verify_ip 127.0.0.1`. A real login (2FA, mailbox password,
  CAPTCHA, reconcile, split mode) needs a real paid account — not yet exercised.
- **Gmail**: `/api/gmail/start` → the consent URL; a fake `.credentials.gmailieer.json` makes `gmi sync` reach Google
  and fail with `invalid_grant` (proves the format). A real sign-in is not yet exercised.
- **Filters**: in the GreenMail setup, `POST /api/filters` with `apply:true` tags what is there; mail sent after it
  and synced is tagged by afew; a `-unread` filter must show up as the `S` maildir flag.
- **UI**: headless Chromium screenshots, or a small CDP script (`--remote-debugging-port`, Runtime.evaluate with a
  deep querySelector through shadow roots, Page.captureScreenshot) to click through dialogs.
