# @drewc/mail — notmuch + lieer (Gmail) + Proton Mail Bridge + mbsync + msmtp + the web client, in one container.
#   podman build --format docker -t localhost/drewcmail -f Containerfile .      (pnpm podman:build)
#   sh container/run.sh                                          (pnpm podman:run)

# Proton Mail Bridge, headless (no Qt GUI; the web app drives it over its gRPC API).
# Newer Bridge: podman build --build-arg BRIDGE_VERSION=v3.x.y …
FROM docker.io/library/golang:1.26-trixie AS bridge
ARG BRIDGE_VERSION=v3.27.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsecret-1-dev libfido2-dev libcbor-dev libssl-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${BRIDGE_VERSION} https://github.com/ProtonMail/proton-bridge.git /src
WORKDIR /src
RUN make build-nogui

# pnpm installs, Bun runs (the SPA build runs Vite under Bun, the server is Bun)
FROM docker.io/oven/bun:1-slim AS pnpm
RUN bun add -g pnpm@12 && rm -rf /root/.bun/install/cache
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages

# the SPA (dist/)
FROM pnpm AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# the server's runtime dependencies only
FROM pnpm AS prod
RUN pnpm install --prod --frozen-lockfile

FROM docker.io/oven/bun:1-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends notmuch lieer afew isync msmtp ca-certificates tini \
      libsecret-1-0 libfido2-1 pass gnupg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=bridge /src/bridge /usr/local/bin/bridge
COPY --from=prod /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json ./
COPY server server
COPY container/entrypoint.sh /usr/local/bin/drewcmail-entrypoint

# /mail: the Maildir (the notmuch database lives in /mail/.notmuch)
# /config: notmuch-config, plus what the web app writes — accounts.json, passwords/,
#          and the mbsyncrc / msmtprc generated from them
#          and proton/ (Bridge's settings and keychain)
#          and filters.json, from which the afew config (afew/config) is generated
# accounts are added in the web app: Gmail → /mail/gmail/<address>/, IMAP and Proton → /mail/imap/<id>/
# (Bridge's own message cache: /mail/.proton-bridge/)
ENV NODE_ENV=production \
    PORT=8025 \
    STATIC_DIR=/app/dist \
    NOTMUCH_CONFIG=/config/notmuch-config \
    SYNC_INTERVAL=300
RUN mkdir -p /mail /config && chown bun:bun /mail /config
VOLUME ["/mail", "/config"]
USER bun
EXPOSE 8025
HEALTHCHECK --interval=60s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/sync',{headers:process.env.MAIL_USER?{authorization:'Basic '+btoa(process.env.MAIL_USER+':'+process.env.MAIL_PASSWORD)}:{}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "drewcmail-entrypoint"]
