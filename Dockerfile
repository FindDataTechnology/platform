# syntax=docker/dockerfile:1
# ── Full-stack single-container image for Platform ────────────────────────────
#
# Runs the backend (server.js) in ONE container via the supervisor
# (scripts/start.js → local-services.js → supervisor/lifecycle.js), exactly like
# `npm start` does locally. dsh's native plugins cover LLM routing and SaaS
# connectors, so there are no sidecar processes.
#
#   docker build -t your-registry/platform .
#   docker run -p 3000:3000 -v platform-data:/data your-registry/platform
#
# Multi-stage: the builder compiles native addons + builds web/dist; the runtime
# stage copies only what is needed. Node 25 is used in BOTH stages: the same major
# the release.yml CI uses, AND the lockfile was generated under npm 11 (Node 22's
# npm 10 misreads it — "Missing: zod@... from lock file"). The system Node ABI then
# matches the native addons compiled at `npm ci` time (better-sqlite3, tree-sitter).
#
# `npm run predist` is deliberately NOT run here. It builds resources/node — the
# standalone Node the *desktop* bundle needs — while the supervisor runs server.js
# on the system Node (process.execPath: this image's own Node), so nothing in the
# container would use it. It is also a 53 MB download from nodejs.org that stalls
# from the China build host.

# ── Base image ───────────────────────────────────────────────────────────────
# A build arg because the two build hosts have opposite network access: the
# GitHub runner (docker-deploy.yml) reaches Docker Hub, while the China build
# host cannot reach registry-1.docker.io and pulls
# a registry mirror instead — its CI passes that as
# BASE_IMAGE. Declared before the first FROM so both stages can use it.
ARG BASE_IMAGE=node:25-bookworm-slim

# ── Builder ──────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS builder

# python3/make/g++ for native addons (better-sqlite3); curl + tar for
# build-node, which curls the Node standalone release tarball and extracts it.
# deb.debian.org crawls at ~130KB/s from the China build host (mirrors.aliyun.com
# is 100x faster); swap before any apt fetch in both stages.
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates git curl tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bound every build-time Node process. The China build host
# is memory-constrained and shares the node with other workloads: a build that spikes past its
# free memory makes the kernel OOM-kill kubelet and the node's registry/proxy —
# node NotReady, site 502 — which happened twice on 2026-09-21. A build that needs
# more than this cap fails HERE, which is recoverable, instead of taking the
# deployment down with it. (The web build peaks well under 1GB; measured.)
ENV NODE_OPTIONS=--max-old-space-size=1024 \
    npm_config_jobs=1 \
    UV_THREADPOOL_SIZE=2

# Install root + web deps first (cacheable layer). --ignore-scripts skips the
# package.json postinstall hook (node scripts/postinstall-web.js && …postinstall-bundle.js):
# at this layer only package*.json is copied, so scripts/ doesn't exist yet and the hook
# would throw "Cannot find module" before the PLATFORM_SKIP_* env guard can exit 0. We run
# the web build + resource builds explicitly below, so the postinstall is redundant here —
# AND making it best-effort (postinstall-bundle.js never fails `npm install`) would mask a
# broken resource build that should fail the docker build.
COPY package*.json ./
COPY web/package*.json ./web/
# The facet thin SPA (add-facet-platform) has its own dep tree; same pattern —
# install early for cache, build after `COPY . .`.
COPY facet/web/package*.json ./facet/web/
# --omit=dev on the ROOT tree only: the runtime (scripts/start.js → server.js)
# never imports a devDependency, and they were ~330 MB of dead weight — the
# electron binary alone is 299 MB in what is a server-only image. The WEB ci
# below must keep devDeps: vite is one, and the image builds web/dist itself.
# Native addons (better-sqlite3/tree-sitter) ship prebuilt binaries, so
# --ignore-scripts + omit=dev compose safely.
# --legacy-peer-deps: the dsh rc-line mixes two peer generations whose ranges
# are mutually exclusive (see 1ac86e7 — release/ci carry the same flag); the
# lock is the resolved truth, clean installs must not re-litigate peers.
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps \
    && npm --prefix web ci --ignore-scripts --legacy-peer-deps \
    && npm --prefix facet/web ci --ignore-scripts --legacy-peer-deps

# dsh-profile-template/ is consumed by the dsh install layer below (cp →
# /opt/dsh-home), so it must exist in the builder BEFORE that RUN. Copying it
# here keeps the slow dsh install cacheable: these tiny text files change
# far less often than the source that arrives via `COPY . .` further down.
COPY dsh-profile-template/ ./dsh-profile-template/

# dsh-matrix/ — the single version truth for the dsh runtime (ADR-0007,
# add-dsh-matrix-lock): intent pins in package.json, the full peer closure
# frozen in package-lock.json. The historical hand-pinned 28-row install
# (18 peer-only plugin rows, the two-generation sdk family split, the hmr
# 1.0.16 pin) lived here; the "why" now lives in dsh-matrix/README.md.
COPY dsh-matrix/package.json dsh-matrix/package-lock.json dsh-matrix/.npmrc ./dsh-matrix/

# One npm ci from the frozen matrix into /opt/dsh — the ONLY real tree (the
# old second install under /opt/dsh-home/profiles/platform is gone; that
# profile keeps its scaffold files and gets a node_modules SYMLINK here — the
# same seedHome pattern agent-runner/compose.js proves in staging, so the
# hundreds-of-MB dsh-base closure is never duplicated per home).
#
# .npmrc deliberately does NOT set legacy-peer-deps (it disabled transitive
# peer auto-installation and forced the old hand-pinned rows into existence);
# npm's default peer resolution fills the closure, and the lock freezes it.
# NODE_OPTIONS heap bump: npm's resolver exhausts the default 2GB heap on
# this closure. Boot-time hard gate: server.js and agent-runner verify the
# installed tree against the same lock at startup (lib/dsh-matrix-verify.js).
RUN mkdir -p /opt/dsh \
    && cp dsh-matrix/package.json dsh-matrix/package-lock.json dsh-matrix/.npmrc /opt/dsh/ \
    && NODE_OPTIONS=--max-old-space-size=8192 npm ci --prefix /opt/dsh --legacy-peer-deps \
    && mkdir -p /opt/dsh-home/profiles/platform \
    && cp dsh-profile-template/package.json \
          dsh-profile-template/pnpm-workspace.yaml \
          dsh-profile-template/cordis.yml \
          dsh-profile-template/cordis.patch.yml \
          /opt/dsh-home/profiles/platform/ \
    && ln -s /opt/dsh/node_modules /opt/dsh-home/profiles/platform/node_modules

# Copy the rest of the source. resources/ is .dockerignored: it holds only the
# platform-specific standalone Node that predist downloads, which this image does
# not build and does not use.
COPY . .

# Build the React frontend. (No `npm run predist` — see the header note.)
#
# No `npm prune --omit=dev` here, deliberately — it was tried and it produced an
# image that dies at boot with ERR_MODULE_NOT_FOUND. @llamaindex/readers is the
# only @llamaindex package in `dependencies` and it declares @llamaindex/core as
# a peer, so prune drops the whole @llamaindex tree (core/env/openai, 344MB) even
# though readers/docx/dist/index.js imports it at load time. Same failure mode as
# the dsh peer rows above. The saving is illusory anyway: root devDependencies are
# only electron/typescript/playwright/biome (~12MB) — the web build's deps live in
# web/node_modules and are never copied to the runtime stage.
RUN npm run web:build

# The facet thin SPA (add-facet-platform): the same image serves two roles —
# the platform (default CMD) and the standalone facet service
# (`node facet/index.js`, per-deployment command override). One image keeps
# the build/relay/GitOps pipelines single-tracked; the SPA is ~500KB.
RUN npm --prefix facet/web run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS runtime

# ca-certificates for outbound HTTPS (Volces upstreams); curl for the CI image
# smoke probe (docker exec) and ops debugging; python3 + pip for the office
# execution layer (add-doc-studio: workspace-side docx/xlsx/pptx generation and
# ingestion, pinned in requirements-office.txt — see that file for why
# markitdown is NOT in the list). Everything else is bundled in
# node_modules / web/dist and needs no system packages.
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps (native addons already compiled in the builder) and the built
# frontend. Ownership is applied on the way in (`--chown`) instead of with a
# recursive `chown -R` afterwards: chown rewrites every inode, so a later RUN
# would duplicate the whole tree — node_modules included — into an extra layer.
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /opt/dsh /opt/dsh
COPY --chown=node:node --from=builder /opt/dsh-home /opt/dsh-home
ENV PATH="/opt/dsh/node_modules/.bin:${PATH}" \
    DSH_HOME="/opt/dsh-home"
COPY --chown=node:node --from=builder /app/web/dist ./web/dist
# Facet service + its built thin SPA (same-image second role; see builder note).
# mcp-catalog.js is imported by facet/index.js (S2 registry 聚合读面); cli/ is
# deliberately NOT shipped — it is the npm-published @finddata/facet package,
# not part of the runtime.
COPY --chown=node:node --from=builder /app/facet/index.js /app/facet/identity.js /app/facet/mcp-catalog.js /app/facet/marketplace-json.js ./facet/
COPY --chown=node:node --from=builder /app/facet/web/dist ./facet/web/dist

# Application source: all root .js (server.js, paths.js, local-services.js,
# bundle-manifest.js, chat-history.js, documents.js, mcp-bridge.js, …) + the
# root JSON data files extension-store.js reads at runtime (market-catalog*.json)
# + the dirs the supervisor/launcher need at runtime.
COPY --chown=node:node --from=builder /app/package.json /app/platform.bundle.json /app/mcp.example.json ./
COPY --chown=node:node --from=builder /app/market-catalog.json /app/market-catalog-skills.json ./
# The chart replay allowlist (openspec: add-chart-data-binding): read at boot by
# dsh-profile.js, which copies it into $DSH_HOME/profiles/<name> for the
# chart-bind bridge, and by chart-bindings.js as the replay gate. It is JSON, so
# `/app/*.js` below does not carry it — without this line the image boots and the
# feature works, but both allowlist readers silently fall back to their built-in
# default (observed on prod 2026-09-28: the plugin's gate was inert).
COPY --chown=node:node --from=builder /app/chart-replay-allowlist.json ./
# The frozen dsh install matrix (add-dsh-matrix-lock): the boot gate in
# server.js and agent-runner reads package-lock.json from here to verify
# /opt/dsh at startup. Missing lock + present install root would refuse to
# boot — so this COPY is load-bearing for the gate, not documentation.
COPY --chown=node:node --from=builder /app/dsh-matrix ./dsh-matrix
COPY --chown=node:node --from=builder /app/*.js ./
COPY --chown=node:node --from=builder /app/server ./server
# gateway/ is imported by server.js (the mini-program identity modules,
# add-single-process-mp-auth); /app/*.js does not descend into dirs, and a
# missing dir here boots the image just fine until its first import — the
# smoke test catches it as ERR_MODULE_NOT_FOUND.
COPY --chown=node:node --from=builder /app/gateway ./gateway
COPY --chown=node:node --from=builder /app/lib ./lib
COPY --chown=node:node --from=builder /app/scripts ./scripts
COPY --chown=node:node --from=builder /app/supervisor ./supervisor
COPY --chown=node:node --from=builder /app/bootstrap ./bootstrap
COPY --chown=node:node --from=builder /app/skills ./skills
# Read at RUNTIME by dsh-profile.js (it copies the two bridge plugins out of here
# into $DSH_HOME/profiles/<name>), so the builder copy above is not enough — an
# image without this dir boots, binds the port, then dies on ENOENT.
COPY --chown=node:node --from=builder /app/dsh-profile-template ./dsh-profile-template
# Same-image third role (fix-agent-data-workspace-writes): the agent-runner
# (`node agent-runner/index.js`, ADR-0004) rides this image with a different
# entrypoint. Without this COPY the image boots and the platform serves
# normally — only the runner role cannot start, which is how the runner
# deployment drifted into bind-mounted code + SFTP hotfixes. Its deps
# (dsh-sdk-client, express, js-yaml) are already in the root node_modules.
COPY --chown=node:node --from=builder /app/agent-runner ./agent-runner

# Office execution layer (add-doc-studio): pinned pure-python + wheel deps only
# (~60MB site-packages; markitdown deliberately absent — see requirements-office.txt).
# This layer sits AFTER the source COPYs on purpose: a requirements bump
# cache-busts only this layer, not the node_modules / dist layers above, and a
# source change does not re-run pip. aliyun pypi mirror pairs with the aliyun
# apt mirror above (China build host).
COPY --chown=node:node --from=builder /app/requirements-office.txt ./
RUN pip3 install --no-cache-dir --break-system-packages \
        -i https://mirrors.aliyun.com/pypi/simple/ \
        -r requirements-office.txt \
    && rm requirements-office.txt

# Persistent state lives under /data: SQLite, sessions, chat-history, cron,
# dev-settings.json. PLATFORM_DATA_DIR points the supervisor (local-services.js)
# + paths.js here. HOST=0.0.0.0 so k8s probes + docker port-forward reach
# server.js inside the container.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PLATFORM_DATA_DIR=/data

# Run as the image's non-root `node` user (UID/GID 1000 in the official node image).
# Only /data is writable at runtime (PLATFORM_DATA_DIR); the app tree already
# carries node ownership from the COPY --chown above, so there is no recursive
# chown here — see the note on those COPY lines.
# /data/workspace is the AGENT_WORKSPACE default target (fix-agent-workspace):
# produced files must land under the serving root or they can be neither
# previewed, downloaded, nor saved to resources. A deployment mounting /data
# from a hostPath masks this dir — its runbook step creates it on the host
# (operator's responsibility when /data is a host mount).
RUN mkdir -p /data/workspace && chown -R node:node /data
USER node

EXPOSE 3000

# No baked HEALTHCHECK: this image carries three roles (cell/facet on 3000,
# runner on 8790) and a role-specific probe mislabels the others unhealthy
# (one runner lived "unhealthy" for a generation). Each
# role defines its own: k8s roles use k8s probes; the runner's compose and the
# ops runbook carries the 8790 /health probe.

# start.js → local-services.js → Supervisor spawns server.js, then keeps running.
CMD ["node", "scripts/start.js"]
