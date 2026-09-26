@AGENTS.md

## Claude Code notes

AGENTS.md (imported above) is the project guide — keep it the single source: update it, not this file, when the
code changes (layout, events, data/tags, rules learned the hard way, testing). This file only adds what is
specific to working here with Claude Code.

- After every change: `pnpm check`. To try server or UI changes, the dev pod (`sh container/dev.sh`, run in the
  background — it follows logs) picks up edits without a rebuild; the SPA is on :5174 and `curl` reaches the server on 127.0.0.1:8026 —
  both clear of a host `pnpm dev` (:5173) and the live container (:8025), which may be running.
  Rebuild the image (`pnpm podman:build`; the Bridge stage is cached) only for Containerfile/package changes, and for
  the full GreenMail runs in AGENTS.md → Testing (with `-p 127.0.0.1:8099:8025`). Remove pods/containers afterwards.
- To read the source of a tool the image uses (afew, lieer, notmuch's defaults), install it in a throwaway copy:
  `podman run --rm --user root --entrypoint sh localhost/drewcmail -c 'apt-get update -qq && apt-get install -y afew; …'`.
- UI checks with headless Chromium over CDP: start it from a script file with its own `--user-data-dir` and kill it
  by PID — `pkill -f <pattern>` from the Bash tool matches the tool's own shell. `Page.navigate` to a URL that
  differs only in the hash does not reload the page.
- Git: branch `main`; commit only when asked. `dist/` and `node_modules/` are ignored, `.spinal/` is committed.
