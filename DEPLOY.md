# Deployment — Docker, TCR, ArgoCD

Platform ships as a **single-process container**: the supervisor (`scripts/start.js` → `local-services.js`) spawns `server.js`, which in turn runs the dsh agent as its child — exactly like `npm start`. One image, one process tree, one data volume.

```
GitHub push ──► image.yml ──► build + smoke ──► push hkccr (HK, ~11.6MB/s)
                                       │
                                       └─► cheap-3 tcr-relay (≤5min, skopeo) ──► ccr (Guangzhou)
                                                  │
                                                  └─► hand-commit the sha-<7> tag into fd-infra-deploy
                                                         → ArgoCD all-services-prod ──► k3s rollout
                                                           (nodes pull from ccr with node-level auth)
```

Fallback pipeline (kept alive): Jenkins (`deploy/prod-snapshot` on Gitee) builds + pushes the
same `sha-<7>` tag to the internal Harbor (`100.64.0.8:30880/paas_private/platform`) — a GitOps
commit can point at either registry's image interchangeably.

---

## Architecture

> **两个壹座域名指向不同部署（2026-10-08 实测，别搞混）**：
> `platform.finddatatech.cloud` → **fd-prod/platform**（TCR 镜像、网关拓扑、`/healthz` 返回
> `{"cells":1,…}`、挂 `platform-config`，**功能集市场在这里**）；
> `paas.finddatatech.cloud` → **law-craw-web/lawcraw**（Harbor 内网镜像、单机拓扑、`/healthz`
> 返回 `{"uptime":…}`、**没有市场，也架构上不支持**——facet 代理只在 gateway/index.js 拓扑挂载，
> 给 lawcraw 加 `PACK_MARKETPLACE`/`FACET_BASE_URL` 无效）。要验市场/装包一律用 platform 域。

| Piece | Where | What |
|---|---|---|
| `Dockerfile` | repo root | Multi-stage build: compiles native addons + installs the pinned dsh CLI/profile into `/opt/dsh` + builds `web/dist` + runs `npm run predist` (`build-node` → the standalone Node in `resources/node`, then `verify-bundle`), then copies into a slim runtime. Entrypoint `node scripts/start.js`. |
| `.dockerignore` | repo root | Excludes the built `resources/node` payload and any leftover `resources/**/*.tar.*` archives so a host's mac/win binaries never leak into the Linux image — the image builds its own Linux payload. Also excludes secrets (`.env*`, `mcp.json`) and dev-only trees (`electron`, `openspec`, `e2e`, the local store dirs). |
| `k8s/` | `service.yaml`, `deployment.yaml` | Plain manifests (no Helm). Deployment = 1 replica, Recreate strategy (single stateful agent). |
| `argocd/application.yaml` | ArgoCD Application CR | Watches `k8s/` in this repo, auto-sync prune+selfHeal, `CreateNamespace=true`, in-cluster destination (`https://kubernetes.default.svc`). |
| `.github/workflows/image.yml` | CI (primary pipeline, org-standard tcr-image-pipeline) | Builds on a GitHub runner, smoke-tests `/api/config`, pushes `sha-<7>` + `main` to **hkccr** (Hong Kong TCR); cheap-3's tcr-relay cron re-syncs it to **ccr** (Guangzhou) ≤5 min, digest-stable. Nodes pull from ccr with node-level registries.yaml auth — no imagePullSecret. |
| `Jenkinsfile` | CI (fallback pipeline) | Same build + smoke against the internal Harbor from the `deploy/prod-snapshot` branch on Gitee. |
| public mirror `platform-image-verify` (`image-publish` workflow) | CI (quota-free alternative, 2026-10-08) | When the private repo has no GitHub Actions quota, the **open-source snapshot is force-pushed to a public clone repo** (one commit, no history) whose `image-publish` workflow builds on free public runners and pushes to hkccr with the same `TCR_USERNAME`/`TCR_PASSWORD` secrets — identical result to `image.yml`, no quota spent. Recipe: `node scripts/make-public-snapshot.mjs --init` → `git remote add <mirror> …` → `git push --force <mirror> main` (the snapshot's `--init` wipes remotes, so re-add them every time). The mirror's `image-build-check` workflow is the build-only variant (no registry) for verifying Dockerfile changes without publishing — its office-layer smoke runs before the boot probe so a boot regression cannot mask it. **`image-publish.yml` is NOT in the snapshot** (the scrubber only deletes `image.yml`; the publish workflow is hand-maintained on the mirror): after every `--init`, copy it back into the snapshot before committing or the force-push silently deletes it and no build runs. As of 2026-10-09 it carries the same FIVE gates as `image-build-check` (office → /api/config → /api/ready → dsh contracts → module identity); image tag = the MIRROR commit's short sha (e.g. snapshot @ 926f44d → `sha-2e0bbac`), relayed hkccr→ccr by cheap-3's 5-min cron. |
| `Makefile` | repo root | `make build/run/logs/k8s-apply/k8s-deploy/argocd-sync` shortcuts. |

**Why a `harbor-pull` imagePullSecret?** The k3s containerd mirror (`/etc/rancher/k3s/registries.yaml` on the node) resolves `harbor.local` → `http://localhost:30880` (`insecure_skip_verify: true`) and *does* carry an `auth` block. **However, containerd does not honor the `auth` block for mirrored endpoints** — it keys credentials by endpoint host (`localhost:30880`), not the mirror name (`harbor.local`), so the auth is never sent and pulls return `401 Unauthorized`. Every other `harbor.local` deployment in this cluster (lawcraw, law-bench, review-agent) works around this with a per-namespace `kubernetes.io/dockerconfigjson` secret named `harbor-pull`. We follow the same pattern. CI pushes to the external `23.144.68.246:30880` address — same registry, two names.

---

## Prerequisites (one-time)

### 1. Harbor project + robot account (for the FALLBACK image push via Jenkins)

The canonical pipeline (GitHub Actions → TCR) needs no Harbor setup — its two
GitHub Secrets are documented in step 1 of "Cluster deployment" below. Everything
in this prerequisites section exists to keep the Jenkins/Harbor fallback alive.

The registry actually used in production is the **internal** Harbor
`100.64.0.8:30880` (the America Harbor `23.144.68.246:30880` this section originally
described is unreachable from GitHub runners *and* from the China-side build hosts, so it
is no longer part of any working path). The `paas_private` project exists there, and push
comes from Jenkins with the project-scoped robot `robot$paas_private+ci-push-platform`
(credential id `harbor-platform` in Jenkins — push + pull, no expiry). Nothing needs to be
created per build; to re-create the robot: Harbor UI → `paas_private` → Robot Accounts → New
(scoped to `paas_private`, push).

> The `harbor-pull` secrets already in the cluster use the Harbor `admin` account — fine for
> pulls. A project-scoped push robot (what Jenkins uses) is the least-privilege way to push.
>
> Historical note: a `robot$paas_private+github-actions` robot was created for the
> GitHub Actions leg. That workflow no longer runs (see the header of
> `.github/workflows/docker-deploy.yml`); the robot is unused.

### 2. `harbor-pull` imagePullSecret (in-cluster pulls)

The k3s containerd mirror does **not** honor the `registries.yaml` `auth` block for mirrored endpoints (see the architecture note above), so pods need a per-namespace `kubernetes.io/dockerconfigjson` secret to pull `harbor.local/*` images. Every other namespace in this cluster (lawcraw, law-bench, review-agent) uses one named `harbor-pull`. Create it in `platform-private` (or copy law-bench's):

```bash
kubectl -n platform-private create secret docker-registry harbor-pull \
  --docker-server=harbor.local \
  --docker-username=<robot-or-admin> \
  --docker-password=<secret>
# or copy an existing one: kubectl -n law-bench get secret harbor-pull -o yaml \
#   | sed 's/namespace: law-bench/namespace: platform-private/' | kubectl apply -f -
```

The Deployment already references it via `imagePullSecrets` (commit `149f449`).

### 3. GitHub Secrets — **no longer used**

This table described the GitHub Actions push leg
(`robot$paas_private+github-actions` → America Harbor). That workflow cannot work from a
GitHub runner any more and has been reduced to manual dispatch; the image is built by
Jenkins instead (see "Cluster deployment"). Nothing needs to be configured here for a
deploy — the secrets, if still present, are leftovers:

| Secret | Value (historical) |
|---|---|
| `HARBOR_HOST` | `23.144.68.246:30880` — unreachable from runners |
| `HARBOR_PROJECT` | `paas_private` |
| `HARBOR_USER` | `robot$paas_private+github-actions` |
| `HARBOR_PASS` | `<robot account secret>` |

### 4. ArgoCD app (already registered)

`fd-prod` is reconciled by the app `all-services-prod` against the **external GitOps repo**
`fd-infra-deploy` (`all-services/prod/*.yaml`) — not against this repo's `k8s/`, which is
the older pre-k3s layout. The application object already exists; to inspect or refresh it:

```bash
kubectl --context cheap -n argocd get application all-services-prod
kubectl --context cheap -n argocd annotate application all-services-prod \
  argocd.argoproj.io/refresh=normal --overwrite
```

Thereafter **never edit the live resources directly** — change the manifest in
`fd-infra-deploy` and let ArgoCD reconcile.

---

## Local testing (Docker)

> Requires Docker. The build compiles native addons, installs the pinned dsh packages from npm, and downloads the Node standalone tarball — expect **5-10 min** for a cold build, ~2 min with the GHA cache.

```bash
make build                              # docker build -t platform:dev .
make run                                # -p 3000:3000 -v platform-data-dev:/data
# cold start: server.js boot + dsh initialize handshake → ~60s
make logs                               # tail until "Platform ready"
curl http://localhost:3000/api/config   # health check
open http://localhost:3000              # the app

make stop                               # stop + rm container (keeps the volume)
make shell                              # exec a shell in the running container
make clean                              # stop + delete the data volume
```

Override the Volces key (optional — `server.js` has a fallback baked in):

```bash
make run VOLCES_API_KEY=your-key
```

**What to look for in `make logs`:**

```
[local-services] Platform ready: http://localhost:3000
```

If the container exits instead, the supervisor dumps `server.js`'s log tail right before it — read that for the failing step.

---

## Cluster deployment (k3s via ArgoCD)

The live cluster follows a **separate GitOps repo** —
`git@gitee.com:FindDataTechnology/fd-infra-deploy.git`, `all-services/prod/platform.yaml` —
through the ArgoCD app `all-services-prod` (auto-sync + selfHeal). That file's `image:`
line is the only thing that decides which build runs, so a deploy is always two steps:
build + push the image, then commit its tag there. The `k8s/` and `argocd/` directories in
*this* repo are the pre-k3s Bootstrap layout and are no longer what `fd-prod` reconciles
(section 3/4 below is kept for that older host only).

### 1. Build + push the image — GitHub Actions → TCR (canonical, org-standard)

`.github/workflows/image.yml` follows the org-standard tcr-image-pipeline
(see the org ops manual / openspec tcr-image-pipeline): GitHub runners push to
the **Hong Kong** personal registry, and cheap-3's tcr-relay cron (*/5 min,
skopeo, digest-stable) re-syncs to **Guangzhou**, where the nodes pull:

```
GH(US) ──11.6MB/s──► hkccr.ccs.tencentyun.com/yizuo/platform
                          │ cheap-3 /etc/tcr-relay/repos.conf (yizuo/platform listed)
                          └──≤5min──► ccr.ccs.tencentyun.com/yizuo/platform
                                          │ node registries.yaml auth (all 12 nodes)
                                          └─► k3s pulls, NO imagePullSecret
```

- **Trigger**: push to `main` (auto), or Actions → image → Run workflow.
  Concurrency cancels superseded runs. A cache-warm run is ~2 minutes end to
  end; a cold one can exceed an hour (the gha cache deadlock rule: the first
  success must be allowed to finish — timeout 240m).
- **Smoke gate** (kept from this repo's own pipeline; the org template lacks
  it): the image is booted and probed (`/api/config`) BEFORE any push — it
  caught the js-yaml phantom dependency on 2026-09-30.
- **Tags**: `sha-<7>` + rolling `main` on hkccr; the relay mirrors both to
  ccr with identical digests (`provenance: false`). The `sha-<7>` rule matches
  the Jenkins pipeline's, so Harbor and TCR tags are interchangeable.
- **Secrets**: `TCR_USERNAME` / `TCR_PASSWORD` (org convention; the older
  `TCR_USER`/`TCR_PASS` on this repo are unused). Personal TCR regions are
  independent stores — the `yizuo` namespace and `platform` repo exist on BOTH
  hkccr and ccr.
- **Timing rule**: a fresh hkccr tag reaches ccr within ≤5 min (relay cycle).
  Do not point the GitOps manifest at a ccr tag that has not relayed yet
  (check `https://ccr.ccs.tencentyun.com/v2/yizuo/platform/tags/list` with
  registry credentials) or the roll hits ImagePullBackOff.

**Cluster pull auth**: node-level. All k3s nodes carry TCR credentials in
`/etc/rancher/k3s/registries.yaml` (org rollout 2026-09-30) — no per-namespace
imagePullSecret is needed or used (the interim `tcr-pull` secret was removed
2026-10-01 after a no-secret probe pod pulled successfully). The manifests
keep only `harbor-finddata-pull` for the Harbor fallback channel below.

**Every deploy** is the same two moves as always: after the relay lands the
tag on ccr, commit it into `fd-infra-deploy/all-services/prod/platform.yaml`
(and platform-demo.yaml — bump BOTH), then:

```bash
kubectl --context cheap -n argocd annotate application all-services-prod \
  argocd.argoproj.io/refresh=normal --overwrite
kubectl --context cheap -n fd-prod rollout status deploy/platform
```

**Rollback**: revert the GitOps tag commit. Older tags stay in TCR forever
(immutable), or point the manifest back at the internal Harbor image of the
same sha (the fallback pipeline below).

### 1b. Fallback: build + push via Jenkins (internal Harbor)

The Jenkins path stays fully functional as the backup pipeline — use it when GitHub
Actions or the Tencent registry is unavailable, or to ship a fix from a branch that is
not on GitHub. Same smoke gate, same tag rule.

The `platform` job on the in-cluster Jenkins (`http://103.236.89.212:31000`, NodePort
`31000` in namespace `jenkins`) runs this repo's `Jenkinsfile`:

- **Source**: Gitee `fd-craw-private`, branch **`deploy/prod-snapshot`** — that branch is
  what gets built, so fast-forward it to the revision you want before triggering.
- **Build**: cheap-3's docker daemon (the pod mounts the host socket), with
  `BASE_IMAGE=100.64.0.8:30880/library/node:25-bookworm-slim` (cheap-3 cannot reach
  Docker Hub), tagged `100.64.0.8:30880/paas_private/platform:sha-<7>` **and** `:latest`.
- **Smoke test before push**: the image is booted with `AUTH_MODE=none` and probed on
  `/api/config`; a container that dies after binding its port fails the build (that is how
  two past images were caught).
- **Push**: internal Harbor, as the project-scoped robot
  `robot$paas_private+ci-push-platform` (credential id `harbor-platform`).
- **It does not touch the GitOps manifest**, deliberately: the tag bump stays a reviewable
  commit (same rule as law-bench).

Credentials and the job's SCM live in Jenkins; nothing to set up per build. A cold build is
~40 min (no BuildKit cache export), and `disableConcurrentBuilds()` makes a second trigger
queue behind the first.

Trigger it — a push to `deploy/prod-snapshot` normally fires the Gitee webhook, and the
job's own webhook endpoint works directly (token is the literal string `platform`).
⚠️ The old entry IP `103.236.89.212` no longer routes (the cluster moved to
Tailscale-mesh node names — reach Jenkins via any node's mesh IP, e.g. cheap-6
`100.64.0.13`):

```bash
curl -X POST "http://100.64.0.13:31000/generic-webhook-trigger/invoke?token=platform"
curl -sg "http://100.64.0.13:31000/job/platform/api/json?tree=lastBuild[number,building,result]"
curl -sg "http://100.64.0.13:31000/job/platform/lastBuild/consoleText" | tail -40
```

The build log's `Pushed 100.64.0.8:30880/paas_private/platform:sha-<7>` line names the tag
to deploy next.

Two things about this host. **It is the production node** — cheap-3 also runs the single
`fd-prod` platform pod, the image registry and the proxy, so a build that exhausts its
memory takes the site down with it: builds #14 and #16 on 2026-09-21 died that way
(`SystemOOM` killed kubelet, registry and proxy; the site 502s until the node recovers).
The Dockerfile therefore caps build-time memory in its builder stage
(`NODE_OPTIONS=--max-old-space-size=1024`, `UV_THREADPOOL_SIZE=2`) — keep that cap. And the
built-in node has **one executor**, so a trigger can wait at "Waiting for next available
executor" behind other services' jobs; the build checks out the branch **tip at build
start**, so the log's `Checking out Revision …` line — not the push that triggered it —
names the commit being tagged.

### 2. Deploy it — hand commit in the GitOps repo

```bash
cd fd-infra-deploy
# all-services/prod/platform.yaml: image: 100.64.0.8:30880/paas_private/platform:sha-<7>
git commit -am "deploy(platform): roll to sha-<7>" && git push
# skip ArgoCD's ~3 min poll, then wait for the rollout
kubectl --context cheap -n argocd annotate application all-services-prod \
  argocd.argoproj.io/refresh=normal --overwrite
kubectl --context cheap -n fd-prod rollout status deploy/platform
```

Prove afterwards that the *code* — not just the tag — is what is serving: the pod's bundle
carries the new UI and its server the new routes.

```bash
kubectl --context cheap -n fd-prod get deploy platform \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl --context cheap -n fd-prod exec deploy/platform -- \
  sh -c 'grep -rl <new-testid> /app/web/dist/assets | head -3; ls /app/server/routes/'
curl -s -o /dev/null -w '%{http_code}\n' https://craw.finddatatech.cloud/api/ready
```

### Fallback: build without Jenkins

Only when Jenkins is unavailable. cheap-1 already has a buildx builder for lawcraw
(`--builder lawcraw-builder`, with `100.64.0.8:30880` declared insecure), so the same
image can be produced there — note `DOCKER_CONFIG` must be a **copy** of `/root/.docker`
(buildx keeps its builder definitions there, and the copy leaves the lawcraw robot's own
credentials untouched), and the Harbor password comes from a file, never argv:

```bash
PW_FILE=/tmp/paas-harbor-pw bash /tmp/paas-build.sh sha-<7>   # on china-cheap-1
```

It pushes the same `sha-<7>` + `latest` tags, so step 2 above is unchanged.

### Superseded: the GitHub-Actions packaging path (retired 2026-09-29)

> **2026-09-30 update**: GitHub Actions is back as the CANONICAL image pipeline —
> but over the Tencent TCR personal registry (`image.yml`, see step 1 above),
> not the unreachable America-Harbor topology described below. The notes stay
> because they are hard-won and nowhere else.

Web/image packaging belonged to Jenkins (and the fallback above). The old
`.github/workflows/docker-deploy.yml` — GitHub runner → America Harbor → chengsi
bridge → blue/green on cheap-2 — is deleted; its working notes are kept here
because they are hard-won and nowhere else:

- cheap-2 (`103.236.89.174:20400`) is reachable ONLY from Chinese IPs; GitHub
  runners cannot SSH in, and cheap-2 has no usable cross-border egress (every
  foreign registry times out), so images had to travel `docker save` over SSH
  from China.
- The chengsi box (`124.220.7.175`) was the delivery bridge: it reaches America
  at ~5.7 MB/s and can SSH into cheap-2; GitHub↔chengsi is GFW-throttled to
  ~27 KB/s, which is why the image went via America's Harbor and never across
  the GFW leg.
- That path's blue/green swap lived in cheap-2's `deploy-platform.sh` with a
  health gate (failure kept the current container); `fetch-deploy.sh` pulled
  from Harbor and piped `docker save` into `docker load`.

If that topology ever returns, resurrect the workflow from git history
(`.github/workflows/docker-deploy.yml` before this date) and re-create its
secrets — all of them were deleted with it.

### Inspect the deployment

```bash
make k8s-status        # pods, svc, rollout
make k8s-logs          # tail the platform pod
kubectl -n platform-private describe pod -l app.kubernetes.io/name=platform
```

Reach it: **https://craw.finddatatech.cloud** (canonical entry — Caddy on cheap1 →
`127.0.0.1:3000`, and the app's own `PAAS_BASE_URL`). The k3s `fd-prod` platform
also answers on its NodePort (**http://103.236.89.212:31870** when this was
written — NodePorts get reallocated: `kubectl --context cheap -n fd-prod get svc platform`).
Both entries now sit behind Logto (`/api/auth/me` → `mode: "logto"`), so anything
that drives the UI needs a session; the older `http://23.144.68.246:30950` in
notes below is dead — **no service in the cluster uses NodePort 30950 any more**.

The `fd-prod` deployment runs `100.64.0.8:30880/paas_private/platform:sha-cc148eb`
(per-user MCP market credentials, deployed 2026-09-21). The image tag lives in the
GitOps repo (`fd-infra-deploy`, `all-services/prod/platform.yaml`); ArgoCD
`all-services-prod` syncs it. `kubectl --context cheap -n fd-prod get deploy
platform -o jsonpath='{.spec.template.spec.containers[0].image}'` is the source of
truth — and if a rollout seems to ignore a new tag, force a refresh with
`kubectl --context cheap -n argocd annotate application all-services-prod
argocd.argoproj.io/refresh=normal --overwrite`.

### Override the Volces key in-cluster (optional)

```bash
kubectl -n platform-private create secret generic platform-secrets \
  --from-literal=volces-api-key=your-key
# ArgoCD self-heal keeps the secret; the Deployment reads it via optional secretKeyRef.
```

### Name the assistant (optional, per deployment)

One value renames every user-facing occurrence of the assistant — sidebar title,
turn header, composer placeholder, the built-in agent's row in the agent
picker, browser tab title — through `GET /api/config` (no rebuild; the web
resolves it before its first paint and falls back to the localized defaults
when unset):

```bash
# Local / docker: .env
ASSISTANT_NAME=Your Name Here
# In-cluster: the platform-config ConfigMap (fd-infra-deploy, e.g. ASSISTANT_NAME),
# then roll the pod.
kubectl -n fd-prod rollout restart deploy/platform
```

### Session ownership (SESSION_LEGACY_OWNER) — add-session-ownership

Chat sessions are private to the account that created them: each session
records an owner (stamped from the first message's authenticated user), lists
are scoped per user, open-by-id/rename/delete are owner-or-admin, and
conversation events reach only that session's viewers. Auth stays off in
dev/desktop (one user, everything visible, e2e unchanged).

One decision before a shared deployment goes multi-user: **who owns the
sessions that already exist?** Rows without an owner are admin-visible only
under auth-on. Assign them once (idempotent — setting it later and restarting
claims whatever is still ownerless):

```bash
kubectl --context cheap -n fd-prod patch configmap platform-config \
  --type merge -p '{"data":{"SESSION_LEGACY_OWNER":"3106241601@qq.com"}}'
kubectl --context cheap -n fd-prod rollout restart deploy/platform
# boot log: [db] assigned N ownerless session(s) to the legacy owner
```

Known shared-runtime ceilings that remain (by design, until per-user cells):
one turn at a time for the whole deployment (a second user prompting during
another's turn gets the standard busy error), and the agent's filesystem view
is still the shared workspace.

### Task worker slots (TASK_WORKER_MAX) — worker-pool

Persona-pinned on-demand runtimes that execute task-engine dispatches in
parallel with the interactive chat (指挥层 phase ③). `0` (the default) is
serial mode — exactly the pre-pool behavior, tasks queue on the interactive
runtime behind live turns. `N>0` allows up to N worker runtimes; while a
worker is available, tasks never touch the interactive runtime. Workers share
the cell's composed profile (same home/patches/credentials), idle-reap after
5 minutes, and pool-state changes broadcast as `worker_pool` events.

fd-prod runs **`TASK_WORKER_MAX=3`** (GitOps source of truth:
`fd-infra-deploy/all-services/prod/platform.yaml` — `0` → `1` → `3`, the last
step because one slot cannot serve more than one persona). The 4GB-OOM history
that once held this at 0 is no longer the binding constraint: the cell limit was
raised 4Gi → 7Gi for exactly this (`harden-fleet-execution-economics` 2.3), and
the wake-admission gate compares `used + footprint` against `limit × (1 − 0.15)`
— at 4Gi that arithmetic refused every wake, which is what made the 2026-11-08
`worker=2` trial idle for 608s. Rollback is `"1"`, or `"0"` for pure serial.

**The pool being active changes which executor owns ordering.** With `N>0` the
pool dispatcher claims queued tasks straight into `beginExecution` and never
enters the serial chain — so the serial chain's human-priority ordering
(`fix-main-chain-human-priority`, shipped while the pool was at 0) does not
apply under the pool. The pool-side equivalent is `QUEUE_HUMAN_PRIORITY` below,
and **it is not set in production today**: dispatch is FIFO.

### Incident escape hatches — the knobs you need *while* the incident is live

These five have a default that is already in force, so the only way to find the
off switch is this table. Four of them shipped on 2026-11-09 documented only in
source comments; `169 of 233` env reads still have no entry in `.env.example`.
Turn them on/off in the platform `.env` (local/docker) or the `platform-config`
ConfigMap (in-cluster, `fd-infra-deploy`) **and roll the pod** — they are read at
process start, not per request.

| Symptom | Knob | Action |
|---|---|---|
| Fleet turns cancelled "too early" (context pressure收口) | `FLEET_EARLY_STOP` | `=0` disables the whole early-stop policy, restoring the full turn budget. Default ON — the live threshold is **4** compactions past >= 60s (`EARLY_STOP_COMPACTIONS`, lowered from 6 after a 5-compaction round still burned the full 600s). It exists because one doomed turn held the cell's serial slot for 600s and pushed `oldestQueuedMs` to 17-25 min |
| An operator's run-now sits in the queue for minutes | `QUEUE_HUMAN_PRIORITY` | `=1` makes human-fired tasks outrank cadence fires in the pool. **Not set in production today, so dispatch is FIFO.** Note the reserved extra slot remains human-*wake*-only, so a run-now'd cadence task still needs a normal slot to free — ordering is not a capacity grant (`fix-operator-ignition-priority`) |
| "Why did that task never enter the pool?" | `WORKER_POOL_DEBUG` | `=1` logs every dispatcher claim/fallback decision. Default OFF. Set it *before* forming a theory — without it the decisions are entirely untraced |
| `/api/gateway/status` reports a cell `near`/`over` on disk | `CELL_DISK_SOFT_MB` / `CELL_DISK_HARD_MB` | Defaults 512 / 2048 MiB, sized from a 1051 MiB real cell on a 30 GiB node. This only *reports* — refusing writes at the hard line is still open (`budget-cell-disk-usage` 2.2), so the node-side fix is the kubelet reservation in that change's §3 |
| A daily/weekly round silently never ran | `QUEUE_STALE_EXEMPT_MIN_PERIOD_MS` | Rounds whose period reaches this floor (default 6h) are **never** age-dropped — losing one costs a whole period. Set it lower to let more rounds be dropped, higher to protect more. Independent of `QUEUE_MAX_AGE_MS` on purpose (see `.env.example`) |

`/readyz` reads `oldestQueuedMs: null` in two different situations — no cell
answered, **or** every queued round is exempt from dropping. Use `queuedExempt`
(from the same payload) to tell them apart before concluding a cell is dead.

If a cell is `over` and the node is already oscillating, do not wait for the
write-refusal layer: add the node's `ephemeral-storage` reservation and raise
`evictionHard` first (`budget-cell-disk-usage` task 3.1), then have the tenant
export and clear. **The platform never deletes workspace content** — it is the
user's real output.

### Mission Control console (MC bridge) — mission-control-bridge

The 指挥层 operator console: a self-hosted [Mission Control](https://github.com/builderz-labs/mission-control)
instance (alpha) that the operator's own and demo cells enroll into — **user
cells never enroll** (needs user-consent semantics first). The cell-side
bridge is outbound-only (register → poll queue → post results; no inbound
port) and off unless `MC_BRIDGE=1` + `MC_URL` + `MC_API_KEY`.

Instance placement (decision: tailnet-only, no public ingress):

```bash
# On a tailnet host (cheap-N), docker compose up Mission Control with a
# persistent data dir and MC_ALLOWED_HOSTS set to the tailnet hostname.
# Verify reachability from a cell: curl http://<tailnet-ip>:<port>/api/health
```

Console-task convention: `title` = target persona preset id, `description` =
prompt. Unknown personas are reported failed with a structured error.

**Deployed 2026-09-30** (cheap1 tailnet, `http://100.64.0.11:3333`, compose
at `/opt/mission-control/`, data under `./data`, admin `fdadmin` — credentials
with the operator). Live-verified facts the bridge is coded against:

1. Register takes the role ENUM (`"agent"` — there is no "cell") and answers
   `{ agent: { id } }`; a per-agent key cannot re-register — the bridge treats
   registration failure as non-fatal and polls as the key's agent.
2. `GET /api/tasks/queue?agent=<name>` CLAIMS one task per call and answers
   `{ task: {...} }` (docs say `{ tasks: [...] }` — the bridge accepts all
   three shapes).
3. There is no result endpoint and `"done"` is Aegis-gated: terminal outcomes
   go to `PUT /api/tasks/<id>` with `status: "quality_review"` and the
   bridge's facts in `metadata.paasBridge` (`state/output/error/usage`); an
   operator reviews and closes in the UI.
4. Queue polling needs an **operator-scoped agent key**: mint with
   `POST /api/agents/<id>/keys {"scopes":["operator","agent:self"]}` (admin
   session) — plain `viewer/agent:self` keys get "Requires operator role".
5. Console-task convention: `title` = persona preset id, `description` =
   prompt. Round trip verified live (task 1: claim → cell execution →
   quality_review with the failure gist in metadata).
6. MC rate-limits agent polling — 2s cadence trips "Agent task polling rate
   limit exceeded" (the bridge's backoff absorbs it; keep `MC_POLL_MS` at the
   5s default). Live batch 2026-10-01: five tasks round-tripped end to end on
   the worker pool (essays up to 7.2k chars returned in metadata); a
   mid-stream model drop was faithfully reported as a failed outcome.

### Agent workspace (AGENT_WORKSPACE pin) — fix-agent-workspace

The dsh runtime's `cwd` defaults to the process working directory (`/app`,
root-owned in the image). An agent booted there writes to `/tmp`, and produced
files become unservable — `/api/files` and the resource-library save both key
off the runtime cwd. The `AGENT_WORKSPACE` env pins a writable workspace at
boot; user switches persist as a preference and survive restarts, but the pin
outranks them (a stale switch can never strand the deployment). An invalid pin
logs `[workspace] AGENT_WORKSPACE '<v>' rejected: …` and falls back down the
chain — boot never fails.

fd-prod applies it once (the `/data` mount is a hostPath, so the dir is
created on the node, not by the image):

```bash
# 1. On the fd-prod node: create the workspace under the persistent volume,
#    owned by the image's node user (UID 1000).
mkdir -p /opt/platform/workspace && chown 1000:1000 /opt/platform/workspace
# 2. Pin it (plain value → ConfigMap):
kubectl --context cheap -n fd-prod patch configmap platform-config \
  --type merge -p '{"data":{"AGENT_WORKSPACE":"/data/workspace"}}'
# 3. Roll and verify:
kubectl --context cheap -n fd-prod rollout restart deploy/platform
kubectl --context cheap -n fd-prod rollout status deploy/platform
kubectl --context cheap -n fd-prod logs deploy/platform | grep '\[workspace\]'
# expect: [workspace] boot workspace: /data/workspace (source=env)
```

Post-deploy probe: ask the agent to write a small file into the workspace
root, then fetch it through an authenticated browser session —
`GET /api/files?root=workspace&path=<rel>` returns 200 and the resource-library
保存到资源库 succeeds. Sessions whose files were written to `/tmp` under the
old layout stay dead (accepted; nothing worth rescuing).

### dsh plugin supply (whitelisted bundles) — add-dsh-plugin-supply

The deployment can ship **dsh plugin bundles** (npm packages that declare a
`dsh.bundle` patch) and let each user enable or disable them from
**Settings → Plugins** (`/settings/plugins`). Supply is whitelist-only and
build-time-only: there is no runtime installer, no pnpm in the cell, and no
agent-facing install tool.

Operator steps to supply one bundle (all three, same review):

1. `dsh-matrix/package.json`: add the package as a dependency (registry spec for
   a public bundle, `file:` for an in-repo sample) and regenerate the lock
   (`npm install --package-lock-only` in `dsh-matrix/`). The image install and
   the desktop predist both `npm ci` from this manifest — that install is the
   supply-chain review point (a bundle's build scripts run during the bake).
2. `prune.json`: confirm the new bundle's closure is not pruned (matches no
   `match` pattern, or add an exemption with evidence — the boot gate
   `lib/dsh-matrix-verify.js` treats an unlisted absence as drift).
3. `dsh-profile-template/package.json`: declare it in **both** places —
   `dependencies` (keeps the row in the roster so a disabled bundle can be
   re-enabled) and `dsh.profile.bundles` (the ordered composition layer).

`@platform/supply-probe-bundle` (`dsh-matrix/samples/`) is the shipped inert
sample that proves the chain; remove it from the template once real bundles
arrive, or keep it as a deploy-time self-test row.

Runtime behavior: a toggle persists to that profile's own
`package.json` bundle list (per-user in a hosted cell, per-installation on
desktop). Under the profile's live HMR the composition recomposes in place
(`application: "applied"`); without HMR the bridge restarts and sessions resume
by id. Toggles are refused while a turn is in flight. The client surface is WS
(`list_plugins` / `set_plugin_enabled` client→server; `plugins` /
`plugins_changed` server→client) — same family as the model/permission
switches, no new REST routes.

### Browser lane (Playwright MCP) — add-browser-use-lane

The bundled `playwright` MCP server (bundled+locked via `platform.bundle.json`)
gives the agent browser operations: `server/browser-mcp.js`, a first-party
thin launcher, execs the pinned `@playwright/mcp@0.0.80` CLI headlessly.
The lane is **supply-gated** at patch-write time (`laneGate: "browser"` in
`writeMcpPatch`): it composes only where the deployment supplies a browser
runtime (`BROWSER_RUNTIME_PATH` exists) or a remote endpoint
(`BROWSER_CDP_ENDPOINT`); `BROWSER_LANE=off` vetoes both. Everywhere else the
entry is omitted as a silent normal state (info log) and the tools simply do
not appear.

The hosted-cell image bakes the runtime in its own prefix
(`/opt/browser-mcp`, module discipline like `/opt/harness-acp`) and presets the
three env vars (`BROWSER_MCP_CLI` / `BROWSER_RUNTIME_PATH` /
`PLAYWRIGHT_BROWSERS_PATH`), so cells get the lane with zero action. Desktop
installers deliberately do not carry chromium — desktop is documented opt-in
(global `@playwright/mcp` + `BROWSER_MCP_CLI`, see `mcp.example.json`'s block).

Truth of the shared state: one dsh runtime = one MCP sidecar per server
(contract ⑭), so within a cell the browser (tabs, cookies, login state) is
shared by that user's sessions — intended, not a bug. Cross-cell isolation is
structural (separate processes). No fallback from a configured-but-dead remote
endpoint to local launch; a dead endpoint fails visibly.

Follow-ups (out of scope here): A2 — the official `dsh-browser-use` family as a
dsh layer bundle (pair with `port-dsh-0.2.1`, replacing this A1 MCP lane with
the same tool semantics); the browser viewer panel (needs the app's own shell
UI — dsh-web-app ships one but is out of scope); computer use.

#### Shared browser lane (pod-level service) — slim-browser-lane-footprint

On a pod that hosts several cells, the per-cell shape above is the wrong billing
unit: every cell carried a stdio shim (~50MB) plus a `@playwright/mcp` child
(~120MB) while **zero chromium ran** — measured 3102Mi/4Gi on fd-prod with four
idle cells, ~640MB of it this lane. The shared shape spends that once per pod.

**Two shapes, one gate.** `writeMcpPatch` picks the shape at patch-write time:

| env | shape | patch entry |
|---|---|---|
| `BROWSER_SHARED_MCP_URL` set | shared (pod service) | `{transport: "streamable-http", url}` — no stdio command, no `BROWSER_OUTPUT_DIR` |
| otherwise | per-cell (shim) | `command: node server/browser-mcp.js` + `BROWSER_OUTPUT_DIR` (unchanged) |
| `BROWSER_LANE=off` | absent | entry omitted, in **either** shape |

> Measured fact (2026-11-08, local run against the pinned 0.0.80 tree): its
> `--port` mode answers on **both** `/mcp` (streamable-http) and `/sse` (legacy
> SSE) — design D2's "SSE only" premise does not hold for this pin. The
> frontend is still required (cell identity, artifact routing, supervision are
> ours, not the CLI's), and it speaks SSE as designed; switching its upstream
> leg to `/mcp` later would be a simplification, not a behaviour change.
>
> Two CLI flags are load-bearing and must not be dropped:
> `--host 127.0.0.1` **plus** `--allowed-hosts 127.0.0.1:<port>` (the CLI's
> Host-header guard 403s without the port-bearing entry even when bound to
> loopback) and `--allow-unrestricted-file-access` (the CLI sandboxes writes to
> its cwd, and this service writes into per-cell workspaces). Both were found
> by the local smoke, not by the unit lane.

**The service** (`server/browser-lane-service.js`, one per pod, loopback only):
spawns and supervises ONE `@playwright/mcp --port` (SSE), accepts
streamable-http sessions from cells, and bridges each cell session onto its own
upstream SSE session. Env: `BROWSER_SHARED_PORT` (9310), `BROWSER_SHARED_HOST`
(127.0.0.1), `BROWSER_SHARED_UPSTREAM_PORT` (9311), `BROWSER_SHARED_OUTPUT_ROOT`
(shared `--output-dir`), `BROWSER_SHARED_CALL_TIMEOUT_MS` (600000), plus the
same `BROWSER_MCP_CLI` / `PLAYWRIGHT_BROWSERS_PATH` / `BROWSER_CDP_ENDPOINT` /
`BROWSER_HEADLESS` / `BROWSER_SANDBOX` the shim honors and `CELL_DATA_ROOT` for
attribution. `BROWSER_SHARED_UPSTREAM_URL` attaches to an existing SSE endpoint
instead of spawning (tests, or an operator-run CLI).

**Isolation is per SESSION, not per process.** Playwright MCP's `--port` mode
gives every HTTP session its own browser context, and the service never passes
`--shared-browser-context`; `--isolated` keeps the profile in memory so a
pod-level browser leaves no cookie jar on disk. One chromium, many contexts:
cookies, login state, tabs and downloads never cross cells.
> Decided (2026-11-08): isolation is per SESSION. Login state persists for the
> duration of one agent session and a later session of the same cell starts
> clean — the deliberate cost of never writing a shared profile to disk, which
> would otherwise be cross-cell readable state. The `browser-use` delta's
> "login persists across sessions in one cell" scenario was rewritten to match.

**Artifacts follow the calling cell.** The service resolves the caller from the
CONNECTION (its peer process: socket inode → pid → cwd/cmdline → the 16-hex cell
dir under `CELL_DATA_ROOT`), never from a header or query the client writes.
> Prerequisite in a two-container pod: `shareProcessNamespace: true`. Cells are
> children of the platform process, so a sidecar with its own PID namespace sees
> no cell process at all and every artifact would land in an `unowned-*` dir
> (checked by the deployment unit test). It
then rewrites `filename`/`saveAs` to an absolute path under
`<CELL_DATA_ROOT>/<cellId>/workspace/browser/` and sweeps auto-named files a call
produced into the same dir — inside the workspace `/api/files` serves, so the
owning cell sees them and no other cell can.

**Sessions are retired server-side.** dsh's MCP client defines
`terminateSession()` (the DELETE that would end a session) but never calls it —
its teardown only closes the transport locally. On a shared pod that would leak
one session (and one browser context) per cell restart, so the service reaps
sessions idle longer than `BROWSER_SHARED_SESSION_IDLE_MS` (default 30 min,
`0` disables; sweep every `BROWSER_SHARED_SESSION_SWEEP_MS`, default 60s) and
logs the retired cell. An actively used session touches the service constantly
and is never reaped; `/healthz` reports per-session `idleMs`.

**Degrade, never fall back.** If the service or its upstream is down, cells get
the ordinary MCP failure path (tools grey out, reason logged, other tools
unaffected) and NO per-cell playwright is spawned — falling back would silently
restore the footprint this change removes. The service supervises its CLI with
exponential backoff, so recovery needs no cell restart.

**Gray rollout.** `BROWSER_SHARED_CELLS` narrows the shared shape to a comma list
of owner emails (`*`/unset = all). An unlisted cell keeps its per-cell browser
process, so a rollout can start with one real cell and no cell ever loses the
lane; deleting an address moves that cell back. Remove the env (or set `*`) when
the rollout completes.

**Deployment.** `k8s/deployment.yaml` (this repo, design of record) carries a
`browser-lane` container and the two platform envs. The LIVE `fd-prod` manifest
lives in the `fd-infra-deploy` GitOps repo — add the same container there and
`BROWSER_SHARED_MCP_URL=http://127.0.0.1:9310/mcp` +
`BROWSER_SHARED_OUTPUT_ROOT=/data/browser-lane` to `platform-config`, then bike
one test cell first (tool surface / artifacts / degrade walkthrough), then all.

**Rollback = delete the env.** Removing `BROWSER_SHARED_MCP_URL` from
`platform-config` makes the next patch write go back to the per-cell stdio shape;
no image rollback needed. Stop (or scale to 0) the `browser-lane` container too
so the pod stops paying for an unused service.

**Observability.** `/healthz` on the gateway reports
`browserLane: {reachable, url}` when the env is set; the memory face
(`/api/monitoring/memory`) carries a `browserLane` footprint row (the service
plus its CLI) whose `reachable` flag greys the row in the ops cockpit when the
lane is down. Tests: `scripts/test-browser-lane-{service,supervisor,manifest}.mjs`
(unit lane) and `scripts/smoke-browser-lane-shared.mjs` (image lane: real
navigation + artifact routing + two-session isolation).

### Web search relay (operator-side service)

The agent's web search ships **inside the app** — `platform.bundle.json` mounts
`server/websearch-mcp.js` (tools `mcp__websearch__web_search` / `__web_read`)
in every deployment form with zero customer configuration. Search itself is
served by an **operator-run relay** you deploy and key: the platform holds only
`SEARCH_RELAY_URL` + `SEARCH_RELAY_TOKEN`, never a provider key.

A reference implementation ships at **`services/search-relay/`** (zero-dependency
single file; `node services/search-relay/index.js`, loopback :4597 by default,
front it with a TLS proxy in prod). The lane credential and caller tokens live in
`services/search-relay/keys.json` (gitignored; `keys.example.json` is the
template) — one entry per customer in `tokens[]`.

**Supply topology.** The shared pool is served by the platform gateway's
websearch lane (词元): the relay calls `POST /v1/search` on the gateway with a
dedicated internal key (its own group, websearch price 0, usage still booked).
**Provider keys live only in the gateway's account pool** — the relay holds
none. `keys.json` carries a `ciyuan:{url,key}` block (env `CIYUAN_URL`/
`CIYUAN_KEY`; file wins) and that is the relay's **only supply**: the direct
SerpAPI path and its `serpapi[]` cold standby were retired after a clean
one-week observation window (retire-search-relay-direct; leftover `serpapi`/
`glm` keys in a file are ignored, and a relay without `ciyuan` refuses to
start). A lane outage is reported to the caller as a clear 503
(`search upstream unavailable (websearch lane): …`), never as a silent direct
fallback; the caller's `x-search-source` three states (`user` /
`pool` / `pool-after-user-failure`) are decided lane-side and pass through
unchanged. Rollback of the retirement = revert the code commit and re-embed a
`serpapi[]` key (kept out of the repo).

The relay must implement exactly one endpoint:

```
POST {SEARCH_RELAY_URL}/v1/search
Authorization: Bearer <the deployment's SEARCH_RELAY_TOKEN>
{"query": "...", "num": 8}          # num pre-clamped by the client to 1..10

200 {"results": [{"title": "...", "url": "https://...", "snippet": "..."}]}
4xx/5xx {"error": "..."}            # surfaced verbatim to the agent as a tool error
```

Relay-side expectations (they are the cost controls — demo/sandbox users have
full search access by product decision, and per-prompt budgets do not meter
tool calls): cache identical queries with a TTL and cap each token's daily call
count. Issue **per-customer tokens** so a leaked desktop settings file costs one
token's quota, not the pool. Provider-key pooling and rotation are the
gateway lane's job — see above — and the relay keeps admission, caching, caps
and stats.

`GET /v1/stats` carries an `upstream` block for the ops board:
`{mode:"ciyuan", laneConfigured, reachable, breakerOpen, laneCalls,
laneFailures}` — `reachable`/`breakerOpen` is a pure reachability signal (3
consecutive lane failures raise it for 60s; any success clears it; it never
reroutes anything). Logs tag every served request with `route=lane`.

Wiring per form factor — no code changes in any of them:

| Form | Where the pair lives |
|---|---|
| dev `npm start` | `.env` (forwarded by the launcher's key list) |
| packaged desktop | `settings.json` in userData (injected via `SETTING_KEYS`) |
| cloud cells | env of the **gateway process** — `baseEnv` flows into every cell |

Verify from a deployment: ask the agent to search (tool block shows results),
or run `npx playwright test e2e/websearch.spec.js --project=fast` (hermetic —
stub relay, no provider spend).

#### Chat fixes: pack agents on the local runtime, folded reasoning, one name — APPLIED 2026-09-22

Live on `sha-a90c2b1` (`fd-prod`, `ASSISTANT_NAME=FD`). Four reported defects, one
cause: a chat-mode catalog agent was forked to its entry's bare OpenAI endpoint, so
the turn had no persona, no tools and no history ("the agent has no memory", "the
conversation cannot see the marketplace MCPs"). A chat agent is now served by the
**local runtime with a generated persona preset** (see `docs/vertical-packs.md` §6.1),
an entry that really is a remote service opts out with `"local": false`, and the fork
path replays the mirrored conversation. Reasoning folds when a turn completes (a
reader who expanded it keeps it open), and `ASSISTANT_NAME` reaches the sidebar,
turn header, composer placeholder, tab title and the built-in agent's picker row.

Verify a deployment after any chat change:

```bash
node scripts/verify-live-chat-fixes.mjs          # Playwright probe; creds from .env
# and pod-side: the newest sessions' preset, persona line and MCP tool count
# (an image built after this doc ships the script at /app/scripts/, so the copy
#  below is only needed for an older pod)
POD=$(kubectl -n fd-prod get pods -o name | grep platform | head -1)
kubectl -n fd-prod cp scripts/inspect-live-session.mjs "${POD#pod/}:/tmp/check.mjs"
kubectl -n fd-prod exec deploy/platform -- node /tmp/check.mjs
```

Selecting a pack agent is a **preset switch** (the dsh child restarts, ~10 s; the
composer blocks until `agent_changed`). `user_preferences.agent.preset` is what a
restart composes — the pick made before the pack is parked under
`agent.preset.own`, which a switch back to the built-in agent restores.

### Registry market token (live layout: `fd-prod` namespace)

The Store merges registry entries from `https://mcp.finddatatech.cloud`
(registry-bridge). The bridge needs `REGISTRY_URL` + `MARKET_REGISTRY_TOKEN`;
without them it logs `registry source disabled` at boot and the market serves
only the bundled catalog. The registry API requires a Bearer token (401
otherwise), so the token is mandatory for registry entries to appear.

> **Where the platform actually runs** (verified 2026-09-18): namespace
> **`fd-prod`**, image from Harbor (`…/platform:sha-<short>`), env injected via
> `envFrom` → ConfigMap `platform-config` + Secret `platform-secrets`. The
> `default`-namespace `platform` deployment in this repo's manifest is a
> scaled-to-zero leftover of the pre-Harbor layout — patching it changes
> nothing user-visible.

1. **Issue a token** — sign in to `https://mcp.finddatatech.cloud` with an
   admin account (寻数科技账号登录), then "Get JWT Token" in the sidebar.
   Token lifetime (updated 2026-09-18): the registry host now runs
   `MCP_TOKEN_DEFAULT_TTL_HOURS=168` / `MCP_TOKEN_MAX_TTL_HOURS=168`
   (`/opt/mcp-gateway-registry/.env` on china-cheap-1; backup
   `.env.bak-ttl-*` alongside), so both the UI button and the mint API
   (`POST /api/tokens/generate` with `X-CSRF-Token` from
   `GET /api/auth/csrf-token`, `expires_in_hours: 168`) yield **7-day**
   tokens. Renew weekly (current one expires 2026-09-25 13:09 CST).
   Minting from a script: an authenticated browser session is required
   (admin login); the API route is otherwise identical.
   ⚠️ The registry's IAM > M2M Accounts (long-lived clients) remains broken:
   the IAM manager factory does not support `AUTH_PROVIDER=logto` (falls
   back to a Keycloak client that cannot connect → group list 502, and the
   M2M create form requires picking from that list), and the M2M client
   list 500s on its DocumentDB config. Fixing that is registry-repo work
   (local fork: FindDataTechnology + law-ai-official mirrors on Gitee/GitHub).
2. **Store it** (secret keys become env vars verbatim via `envFrom`):

   ```bash
   kubectl --context cheap -n fd-prod patch secret platform-secrets \
     -p '{"stringData":{"MARKET_REGISTRY_TOKEN":"<token>"}}'
   ```

3. **Set the URL** in the ConfigMap (plain value, not a secret):

   ```bash
   kubectl --context cheap -n fd-prod patch configmap platform-config \
     --type merge -p '{"data":{"REGISTRY_URL":"https://mcp.finddatatech.cloud"}}'
   ```

4. **Restart and verify** (bridge is silent on success; it only logs when
   disabled or on fetch failure):

   ```bash
   kubectl --context cheap -n fd-prod rollout restart deploy/platform
   kubectl --context cheap -n fd-prod rollout status deploy/platform
   kubectl --context cheap -n fd-prod exec deploy/platform -- \
     sh -c 'echo $REGISTRY_URL; echo ${MARKET_REGISTRY_TOKEN:+token-set}'
   ```

   Then check the market over an authenticated session
   (`GET /api/extensions/market`): bundled entries stay, and registry entries
   appear — MCP `fd-cn-report`, `fd-daas-mcp`, `fd-open-data-mcp`, `law-bench`,
   `airegistry-tools`; skills `contract-review`, `financial-statement-analysis`,
   `legal-research-cn` and the rest of the registry skill catalog; agents
   `registry-chatlaw`, `registry-fingpt` in `/api/catalog`.

#### Per-user market connect (registry-sso-credentials) — APPLIED 2026-09-21

The Store's 连接 MCP 市场 button mints a **personal** registry token. The registry
window it opens is the registry's own login page — the platform's sign-in has
already established a Logto session in the same browser, so the registry's single
`Continue with Logto` button completes the sign-in with **nothing typed**; the
platform then mints **cross-origin with credentials** (the registry session
cookie is `SameSite=None; Secure`) and hands the token to the backend, which
stores it per user (`user_registry_credentials`). It never touches browser
storage, and the popup itself is closed by the platform the moment the mint
lands.

Two registry-side pieces make that cross-origin leg work. Both are now in place
on china-cheap-1, and both are ops config rather than platform code:

1. **Credentialed CORS allowlist** — `CORS_ALLOWED_ORIGINS` in
   `/opt/mcp-gateway-registry/extra_env/registry.env` (the compose `env_file`
   for the `registry` service; note the project `.env` is only used for compose
   *interpolation* and does NOT reach the container):

   ```
   CORS_ALLOWED_ORIGINS=https://craw.finddatatech.cloud,http://103.236.89.212:31870
   ```

   The registry is fail-closed — its own origin is always included, nothing else
   is. List the origins the **browser** loads the platform from; a preflight from
   an unlisted origin is refused and the Store can only fall back to paste. The
   k3s NodePort is reallocatable (the older `30950` no longer exists in the
   cluster — see the note below), so re-check this line whenever the entry URL
   changes.

2. **Preflight exemption in nginx** — `/opt/mcp-gateway-registry/nginx_rev_proxy_http_only.conf`
   (mounted read-only into the container as the registry-API template; a second
   copy at `docker/nginx_rev_proxy_http_and_https.conf`). The `location /api/`
   block authenticates every request with `auth_request /validate`, and a CORS
   preflight never carries credentials by spec — so it could only ever 401, and
   the browser then blocks the real credentialed call. The hotfix routes OPTIONS
   to a named location that skips the auth subrequest and lets FastAPI's
   CORSMiddleware apply the strict origin allowlist (OPTIONS has no body, no
   cookies and no side effects; real requests are unchanged):

   ```nginx
   if ($request_method = OPTIONS) { return 418; }
   error_page 418 = @registry_api_preflight;
   # ...server scope:
   location @registry_api_preflight { proxy_pass http://127.0.0.1:7860; ... }
   ```

   The session cookie was already `SameSite=None; Secure`, so nothing was needed
   there.

Apply a change to either file with (only the `registry` service is recreated;
dependencies and the image are left alone, and a failed nginx reload keeps the
old config running):

```bash
cd /opt/mcp-gateway-registry
cp -a extra_env/registry.env extra_env/registry.env.bak-$(date +%Y%m%d-%H%M%S)   # or the .conf
docker compose -f docker-compose.prebuilt.yml up -d --no-deps --no-build --pull never --force-recreate registry
docker inspect -f '{{.State.Health.Status}}' mcp-gateway-registry-registry-1     # → healthy in ~1-2 min
```

Verify (all three from a machine that can reach the registry):

```bash
U=https://mcp.finddatatech.cloud; O=https://craw.finddatatech.cloud
curl -D- -o /dev/null -H "Origin: $O" $U/api/auth/csrf-token | grep -i access-control        # ACAO = $O
curl -D- -o /dev/null -X OPTIONS -H "Origin: $O" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-csrf-token' $U/api/tokens/generate      # 200 + ACAO
curl -D- -o /dev/null -X OPTIONS -H "Origin: https://evil.example" $U/api/tokens/generate    # 400, no ACAO
```

A browser check from the real origin (the anonymous case resolves the GET and
sends the POST; the anonymous POST still 401s at nginx, which is expected — the
mint needs a registry session):

```js
// devtools on https://craw.finddatatech.cloud
await fetch("https://mcp.finddatatech.cloud/api/auth/csrf-token", { credentials: "include" })
// → Response{status: 401, type: "cors"}  (a TypeError here means the allowlist is missing this origin)
```

**Verified end-to-end on fd-prod (2026-09-21, `sha-cc148eb`, account
平台管理员账号)** — `scripts/verify-live-connect-flow.mjs` (credentials
from `LOGTO_EMAIL`/`LOGTO_PASSWORD`; it resets the connection, picks a registry
entry the deployment does not already serve, and uninstalls it again, so running
it leaves the environment as it found it):

| Step | Result |
| --- | --- |
| Platform sign-in | `/login` → `Sign in with SSO` → Logto → `/chat` |
| Connect | Connect + the registry's own `Continue with Logto` — **no credential typed anywhere**; connected, `expiresAt` +168 h, `source: sso` |
| Install a registry entry | form has **no** `Authorization` field, Add enabled immediately; the stored record carries `credentialRef: "registry"` and **no** header |
| Effective profile on the pod | the entry in `mcp.patch.yml` carries `Authorization: Bearer …` whose JWT `exp` equals the connection's expiry — i.e. the user's own credential, resolved at write time |
| The credential works | `initialize` → serverInfo `AI Registry`; `tools/list` → 7 tools |
| Chat turn | answered through the deployed instance (LLM + agent path healthy) |
| Cleanup | entry uninstalled; the deployment's five managed servers untouched; the credential row left connected |

Two things that runbook should know about the registry side:

- The registry's login page is **not** an automatic redirect: the first connect
  takes one extra click (`Continue with Logto`) on the registry's own origin,
  which the platform cannot click for the user. Afterwards the registry cookie
  lives for 24 h, so repeat connects are a single click on Connect.
- That card renders **"No login methods are currently configured"** when its own
  `/api/auth/providers` call loses the race against a busy page load (observed
  while the SPA was still fetching its bundle; the endpoint itself stays 200).
  A reload fixes it, so the verification script retries the window; if a demo
  operator ever sees it, reload the window (or just click Connect again). The
  paste fallback stays available at all times.

Rollback: restore `extra_env/registry.env` / the `.conf` from its `.bak-*`
backup and recreate the container. Registry routes moved in a version bump?
Override the paths instead of patching code: `MARKET_REGISTRY_LOGIN_PATH`,
`MARKET_REGISTRY_CSRF_PATH`, `MARKET_REGISTRY_TOKENS_PATH`.

If the allowlist is missing an origin — or the registry is unreachable, or the
account cannot sign in there — the paste fallback is the supported path: the same
dialog takes a token minted via the registry UI's "Get JWT Token", stores it in
the same per-user row with `source: "paste"`, and drives exactly the same
injection (`Authorization` resolved at profile-write time, servers omitted with a
warning when the credential is missing/stale/expired — see the
`registry-credentials` and `dsh-runtime-bridge` specs for the profile side).

### Registry 是谦面的组件（add-facet-platform S2；ADR-0015）

**归属**：自部署的 mcp-gateway-registry（`mcp.finddatatech.cloud`）是谦面（facet）的组件——
谦面负责其用户面聚合与运营归属；**软件不重写、域名不迁、GitOps 位置不动**（轻归屋，v2 再议域名
迁移与重组）。运行时分发关系不变（ADR-0004）：runner 从注册处取活，萬星门面经其 A2A 反代。
facet 面的 MCP 卡片是**只读聚合**：`/api/mcp-catalog` 经 registry-bridge 读目录（同
`REGISTRY_URL`/`MARKET_REGISTRY_TOKEN` env + 300s TTL），可见性按 `registry-groups.json`
同一映射过滤（匿名只见无组项），**不经 facet 写任何注册处状态**。

**facet 服务本体**（S1 抽身结果）：独立 Deployment（`all-services/prod/facet.yaml`），同镜像
第二入口 `node facet/index.js`，hostNetwork:3200 于 cheap-3，域
`facet.finddatatech.cloud`（cheap-1 Caddy → autossh 隧道 3001→3200 → 雷池站 22 三 SAN 证书）。
store 独立：`FACET_DATA_ROOT=/data/facet` ← hostPath `/opt/platform/facet`。壹座的
`/api/packs` 全前缀由网关代理到 facet（`FACET_BASE_URL` 设时），回滚 = 摘除该 env（平台自有
冻结库接回，cutover 后写入会"消失"——D9 已接受）。

**k8s 陷阱：envFrom 静默跳过带 `-`/`.` 的 secret 键**（实锤 2026-10-03）：
`platform-secrets` 的 `sub2api-admin-key` 经 envFrom 到不了 pod（事件里才有 warning），
平台一直靠 inline `valueFrom.secretKeyRef` 拿它；facet 首版只写了 envFrom → 部署路由
"billing not linked"：粘贴键被忽略、**重复部署静默抹掉 serving agent 的 `billingKeyRef`**
（GitOps `aa60f6f` 修）。**纪律**：凡 secret 键名含 `-`/`.`（必然如此，k8s 键名规范允许而 env 名
不允许），消费方一律 inline `valueFrom`；新增 secret 键时自查全部消费 deployment。

**数据迁移纪律：停写 + 全表 diff，别信路径**（实锤 2026-10-03）：cutover 曾拷错文件
（`/opt/platform/data/packs.db` 是单进程时代孪生，5 包；网关活库是 **`/opt/platform/cells/packs.db`**，
7 包+deployment_keys）——后果是私有包/计费簿记缺失，靠按表回填修复。**规程**：拷前先验内容
（7 表计数：packs / pack_versions / subscriptions / pack_deployments / deployment_keys /
deployment_secrets / sub2api_accounts），停写窗口内拷，迁移后跑**包含性检查**（cells 每行按主键
必在 facet；`sub2api_accounts` 允许少——部署路由会懒重建）。命令骨架（pod 内）：

```bash
node -e '…better-sqlite3 逐表 SELECT COUNT(*)/按 id 交集比对…'
```

### Bot relay (machine callers → chat-platform bots)

Lets a cloud service on a trusted network push text through a configured bot
without a browser session (`add-bot-relay-endpoint`). The route
(`POST /api/bots/relay/send`) is identity-exempt like the bot webhooks and
carries its own bearer token. Deploy inert first, then enable:

1. **Confirm it is inert** on the running service (no token yet):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     <PLATFORM_URL>/api/bots/relay/send -d '{}'   # → 404, e.g. https://craw.finddatatech.cloud
   ```

2. **Add the token** (same rotation rhythm as `MARKET_REGISTRY_TOKEN`):

   ```bash
   TOKEN=$(openssl rand -base64 32)
   kubectl --context cheap -n fd-prod patch secret platform-secrets \
     -p "{\"stringData\":{\"BOTS_RELAY_TOKEN\":\"$TOKEN\"}}"
   kubectl --context cheap -n fd-prod rollout restart deploy/platform
   kubectl --context cheap -n fd-prod rollout status deploy/platform
   ```

3. **Verify both answers**, then keep `$TOKEN` only in the caller's server-side
   config (never in a browser, never in a repo):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     <PLATFORM_URL>/api/bots/relay/send \
     -H 'authorization: Bearer wrong' -d '{}'                    # → 401
   curl -s -X POST <PLATFORM_URL>/api/bots/relay/send \
     -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' \
     -d '{"channel":"ops-alerts","text":"hello"}'                # → {"ok":true}
   ```

4. **Bind a channel** (admin session required; the pair must be a chat the bot
   has already been messaged from, which requires inbound to work — see
   `PUBLIC_BASE_URL` below):

   ```bash
   curl -s <platform>/api/bots/chats                      # find botId + chatKey
   curl -s -X POST <platform>/api/bots/channels \
     -H 'content-type: application/json' \
     -d '{"name":"ops-alerts","botId":"<botId>","chatKey":"<chatKey>"}'
   ```

**Transport**: the token must only cross a network the operator trusts. Calling
from the same host (the registry stack) uses the loopback/node address and is
fine as-is; an off-host caller needs a TLS-terminated ingress in front of the
platform — do not send it over the plain-HTTP NodePort from the open internet.

**Inbound reminder**: webhook platforms (WeCom/Feishu/WeChat OA) can only
receive with `PUBLIC_BASE_URL` set on the deployment; without it only Telegram
works (long-poll), and no `bot_chats` row is recorded for webhook platforms, so
nothing is bindable there.

**Rollback**: unset the Secret key (`kubectl patch secret … -p
'{"stringData":{"BOTS_RELAY_TOKEN":""}}'`) and restart — the route answers 404
again. The `bot_chats` / `bot_channels` / `bot_relay_log` tables stay as inert
leftovers; dropping them is optional.

### Role-gated market entries (Logto groups)

Registry entries can be restricted to users holding a specific Logto role
(mapped into the platform's `groups` from Logto organizations/organization
roles at login). The registry API carries no group metadata, so visibility
groups come from an optional local file next to the data dir (CWD in the
container), `registry-groups.json`:

```json
{
  "servers": { "fd-cn-report": ["analysts"] },
  "skills":  { "contract-review": ["legal"] },
  "agents":  { "agents-weather": ["team-a"] }
}
```

Behavior (add-role-gated-extensions): a gated entry is hidden from the market
for users outside its groups; installing one stamps `requiredGroups` on the
MCP record and is rejected server-side for non-members; at runtime the
effective MCP profile drops stamped servers the current user's groups no
longer cover — so **revoking a Logto role takes effect on the user's next
profile application or cell restart** (in a hosted cell the owner's latest
groups are snapshotted to `PLATFORM_DATA_DIR/owner-groups.json` to survive
restarts). Bundled catalog entries never carry groups; with auth off
(desktop/dev) the requester is the machine owner and sees and installs
everything.

Operational note: renaming a group in Logto (or in `registry-groups.json`)
strands the mapping — gated servers silently disappear for affected users
until the file is updated. That is the designed failure mode: fail closed,
restore on fix.

**Ops access to the registry host** (updated 2026-09-18): china-cheap-1 is
`100.64.0.11` on the finddata Tailscale mesh (self-hosted control plane at
124.220.7.175; the paas workstation's profile `finddata` = chengs-mac
100.64.0.2). The workstation's key is in `/root/.ssh/authorized_keys`
(added 2026-09-18) and `~/.ssh/config` defines `Host cheap1` — so
`ssh cheap1` reaches it directly. The registry stack is docker compose at
`/opt/mcp-gateway-registry` (`docker-compose.prebuilt.yml`; recreate with
`--no-deps` — dependency init images reference docker.io and cannot pull
from the nodes). Fallback if mesh SSH is unavailable: privileged bridge pod
on cheap-4 (see git history of this file for the recipe).

**Registry nginx logto hotfix** (2026-09-19): the image's HTTP-only nginx
template (`/app/docker/nginx_rev_proxy_http_only.conf`) lacks the
`/oauth2/login/logto` + `/oauth2/callback/logto` proxy blocks that the
HTTP-and-HTTPS template has — with no TLS certs in the container the
entrypoint picks HTTP-only, so Logto login silently served the SPA shell
(blank "no login page" at `/oauth2/login/logto`). Fixed by patching those
blocks into a host-side copy at
`/opt/mcp-gateway-registry/nginx_rev_proxy_http_only.conf` and mounting it
read-only over the in-image template (see the `Hotfix 2026-09-19` volume in
`docker-compose.prebuilt.yml`); conf regenerations and container recreates
now keep them. Drop the mount after the upstream template gains the blocks.
Known residual after any conf regeneration: bare `/health` (use container
healthchecks; `/api/health` is also template-gated).

---

## NodePort

`30950` was free at authoring time (k3s range 30000-32767). If it collides with a future service, edit `k8s/service.yaml` `nodePort` and let ArgoCD sync. Current NodePorts in the cluster:

```
harbor 30880, argocd 30910, minio 30900, lawcraw 30500, litellm 30400, …
```

---

## Resource sizing

The container runs a single Node process (`server.js`) plus the dsh agent child it spawns. Set `resources.requests` / `resources.limits` in `k8s/deployment.yaml` to suit the node; a Node + dsh pair is comfortable around 1 CPU / 1.5Gi requested with headroom to ~2Gi.

The startup window is generous (`startupProbe` allows several minutes) because the first boot has to seed the SQLite store and complete the dsh `initialize` handshake before `/api/config` answers.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ImagePullBackOff` (401 Unauthorized) | Two root causes, both one-time: (1) the `paas_private` Harbor project doesn't exist yet — Harbor returns **401** for unknown projects, which looks like an auth failure but isn't (create it in the Harbor UI or via admin API); (2) the `harbor-pull` imagePullSecret is missing in `platform-private` — the k3s containerd mirror does NOT honor the `registries.yaml` `auth` block for mirrored endpoints (see architecture note). Run `make k8s-logs` and check the pod events; a `401 Unauthorized` from `localhost:30880` means one of these. |
| Pod restarts (OOMKilled) | Raise `limits.memory` in `k8s/deployment.yaml`. |
| `startupProbe` fails → `CrashLoopBackOff` | `make k8s-logs`; look for the supervisor's `server.js` log dump. Most common: the dsh CLI is missing from `PATH` or its profile home is unwritable, so the `initialize` handshake never completes. |
| ArgoCD shows `OutOfSync` on `Namespace` | Harmless — `CreateNamespace=true` created it; ArgoCD will self-heal. Or `make argocd-sync`. |
| Image built with mac binaries | `.dockerignore` wasn't in the build context, or you built from a dir with stale `resources/`. Rebuild from a clean checkout. |
| CI loop (workflow re-triggers itself) | The `paths:` filter excludes `k8s/**` and the commit message has `[skip ci]`. If you edit the filter, keep both guards. |

---

## Unit suite (local)

```bash
npm run test:unit        # node --test --test-concurrency=1 scripts/test-*.mjs
```

Three prerequisites are **not** obvious and each one fails in a way that looks
like a code regression (all hit on 2026-11-08):

**1. Batch it.** A single run over all ~450 files gets interrupted (hundreds of
cancelled, not failed). Split and run sequentially:

```bash
ls scripts/test-*.mjs | sort | split -l 40 - /tmp/batch-
for b in /tmp/batch-*; do node --test --test-concurrency=1 $(cat $b); done
```

**2. `DSH_BIN` must point at a complete dsh runtime.** `scripts/test-session-resume.mjs`
boots real dsh children; they resolve the profile's declared bundles
(`@platform/supply-probe-bundle`, shipped as `dsh-matrix/samples/…`) **only** from
the profile's own `node_modules`, which `dsh-profile.js` sources from
`DSH_BIN`'s tree and otherwise from this repo's `node_modules` — where that
package does not exist. Symptom: four resume tests fail together with
`dsh: cannot resolve profile bundle "@platform/supply-probe-bundle"`.

```bash
DSH_BIN=$PWD/dsh-matrix/node_modules/@deepseek-ai/dsh/lib/bin.js npm run test:unit
# or: (cd dsh-matrix && npm install)   # brings the file: sample dependency in
```

**3. `web/dist` must exist** for `scripts/test-cell-gateway.mjs` — the gateway
serves the SPA shell to anonymous browsers, so a tree without a built `web/dist`
returns 404 and the test reads as a broken route. `npm run web:build` once (or
point at any existing build) before running the suite in a fresh worktree.

Run from the repo root, never from a worktree that lacks `node_modules`,
`dsh-matrix/node_modules` and `web/dist`.

---

## Live service testing

The repo ships a Playwright suite that runs **read-only** checks against the
deployed k3s NodePort - so you can verify a deploy actually serves a working app
with one command, instead of opening the URL and clicking around.

```bash
make test-live LIVE_SERVICE_URL=https://craw.finddatatech.cloud   # read-only suite
# or, equivalently:
LIVE_SERVICE_URL=https://craw.finddatatech.cloud npm run test:e2e:live
```

The `live` Playwright project connects to an already-running external URL
(`LIVE_SERVICE_URL`; the built-in default — the old `23.144.68.246:30950` — is
dead, see the entry note above, so pass the current URL explicitly); it **never**
launches a local `node server.js` and **never** creates temp store dirs.

⚠️ The deployed instances now enforce Logto, so the SPA/WebSocket specs fail
without a session (observed against `craw.finddatatech.cloud`: 5 failed with
`websocket error` / no `/chat` redirect). Use the suite against an
unauthenticated deploy, or sign in first. Point it at a different deploy by
overriding the URL:

```bash
make test-live LIVE_SERVICE_URL=http://staging-host:30950
# or
LIVE_SERVICE_URL=http://staging-host:30950 npm run test:e2e:live
```

### What the read-only `@live` tests check

- `/api/config` responds 2xx with JSON (backend booted).
- `/` serves the SPA and routes to `/chat`.
- The chat shell renders (sidebar + composer + session list) and the **WebSocket
  connects** (`status-text` becomes `Connected`).
- A `list_models` WS round-trip returns a `models` response (the deployed agent
  session is live) - no tokens spent.
- The sidebar shows all nav entries; `/dashboard` resolves via the SPA fallback.

The read-only suite **never** writes chat history, uploads documents, switches
models, or spends LLM tokens.

### Opt-in LLM round-trip (`@live-smoke`)

To verify the full server -> Volces path with one real chat turn
(which **does** spend one LLM token and writes one chat session to the deployed
data dir), run the smoke variant - gated behind `LIVE_SMOKE=1` so it never runs by
default:

```bash
make test-live-smoke           # sets LIVE_SMOKE=1
# or
npm run test:e2e:live:smoke
```

> **Note:** live tests target a deployed entry (private IP NodePort or the
> public domain), so they are a dev-machine / self-hosted-runner concern - not
> run from `ubuntu-latest` CI, which has no route to either. The local
> `fast`/`smoke` suites (`npm run test:e2e`) are unaffected and still launch their own local
> `node server.js`.

---

### fd-prod 聚焦度量实录（add-persona-resource-sets，2026-09-29 sha-c1665d4）

Per-persona 探针（`node scripts/probe-pack-scope.mjs --db /data/data/app.db
--data-dir /data --dsh-home /opt/dsh-home [--auth <MP-JWT>]`，in-pod）：full
5 服务 / 116 工具 → 声明子集 persona 2 服务 / **72 工具（Δ−44，−38%）**；
turn-trace 单 turn token 差噪声级（schema 按需加载），硬收益在 roster 削减。
种子包已按四种声明形态重发（法律-合同未声明 / 法律-案件 MCP-only /
数据-股票空声明 / 数据-中国 mixed v3 已升级）。完整数字、M2M token 重铸与
MCP 行 credentialRef 化的运维实录见
`openspec/changes/add-persona-resource-sets/measurements.md`。

### 角色资源微调上线实录（add-focus-overlay，2026-09-29 sha-40a88aa）

订阅方对聚焦角色的 add/remove 微调（`focus.overlay.<presetId>` 偏好差异）。
**部署全局语义（v1 天花板，与 preset 选择一致）**：overlay 是共享运行时的
部署级状态——任何客户端（web）的调整对全体客户端立即可见（`overlay_changed`
广播），PUT 走 set_preset 同款串行变更路径（流式中 409、空闲时重写双 patch +
重启、下一会话生效）；per-client 隔离是文档化的升级路径而非待发现行为。
**MP 侧 fast-follow（本变更未含）**：小程序不提供微调面板，角色徽标保持
add-persona-resource-sets 的只读形态；e2e 以静态断言锁住「MP 源码不引用
/api/agent/overlay」。探针 `--overlay` 通道已验证：in-pod 对
pack-industry-analyst-macro 存演示 diff 后，`focused-derived`（基线 only）
与 `focused-overlay`（`+skills[stock-research-workflow]` → persona 组合根出
现，跨根链接 `../../../stock-research-workflow`；悬空 remove 静默忽略）双块
并排输出，演示后已清除。API：`GET/PUT /api/agent/overlay?preset=`（PUT 校验
add∩remove 冲突 400 点名字段；overlay 适用于 pack persona，shipped preset
保持可用性语义）。注：#43 构建曾因 cheap-3 上 builder 阶段镜像在构建中途被
回收（`COPY --from=builder: No such image`）失败，重试 #44 即成——冷构建慢
阶段与盘压 GC 的竞态，复发时先查节点 `docker system df`。

### 自建预设上线实录（add-custom-presets，2026-09-29 sha-f3523de/Jenkins #45）

「造」半边的用户侧决策落地：任何认证用户可在单元格内组合 persona 预设
（`user_presets` 表 db v21；id 服务端分配于保留 `user.` 前缀，作者只起名）。
**部署全局名册语义（v1 天花板，与 preset 选择、overlay 一致）**：自建预设
是共享运行时的部署级状态——每个连接的客户端看到同一份名册，任何认证用户
可增删改（`GET/POST/PUT/DELETE /api/agent/presets`，串行变更路径：流式中
409、目录刷新、空闲重启、`catalog_changed` 广播）；per-user 名册是文档化的
升级路径。**MP 侧 fast-follow（本变更未含）**：小程序保持
add-persona-resource-sets 的只读角色徽标，不提供自建预设管理页。资源引用
组合时解析（跨包技能随包生命周期进出、被禁用服务不可被引用复活、空引用
聚焦到基线）；②号 overlay 对自建预设同样生效（存储于目录 id 键下）。
**运维要点**：dsh-agent-presets 的目录名正则禁点——生成预设目录取
`user.<slug>` 的 dash 形（`rosterPresetId`），resolvePersona 双向匹配（顺带
修复点号 pack agent id 的同类潜在问题）；自建预设不可发布（共享走市场包草
稿），包清单 `user.` 前缀 agent id 发布+安装双拒，安装撞已有预设 id 跳过并
报告属主。探针已并入：自建预设作为聚焦角色逐预设输出（服务/工具数、
token delta 走 `--turn-trace`）。

### 模型名册探活刷新上线实录（refresh-llm-model-roster，2026-09-30 sha-8e235ce/Jenkins #46）

背景：`GET /v1/models` 是「认识的 id」而非「能服务的 id」——33 个 id 逐一 1-token
实测仅 13 个在服务，且当日网关把 deepseek 账户组从前缀 id
（`deepseek/deepseek-v4.1-flash`，约定默认道）切回裸 id（`deepseek-v4.1-flash`），
两个方向各复测 ×2 证实。**双轨落地**：①代码轨——VOLCES_MODELS 22→13（deepseek→
glm→免费池排序）、`getAvailableModels` 跨 provider 按 id 首现去重（下拉 React key
冲突）、e2e FROZEN/断言更新（6/6 绿），Jenkins #46 构建 + GitOps 48e0314 滚动
（镜像 sha-8e235ce + `DEFAULT_MODEL` 改裸 id 一次提交）；②数据轨（等构建期间
先行恢复服务）——pod 上备份 `/data/*.bak-2026-09-30` 后直写 13 条名册 + 裸 id
默认指针，`kubectl exec` 内跑 `node --input-type=module -e 'import("/app/dsh-profile.js")'`
调 `writeLlmProfile()` 重投影 settings.yaml（dsh Chokidar 热载，零停机）。
**验证**：settings.yaml 26 模型裸 deepseek 头、活 ConfigMap 与 pod env `DEFAULT_MODEL`
均为裸 id、32080 中继对裸 id 回 "ok"、站点 /api/ready 200；dev 隔离 boot 同代码
同数据 WS 聊天回复「收到」。**坑**：`kubectl cp` 对该 pod 持续 NotFound 而 exec
正常——用 `exec + base64 -d` 直写绕过；ArgoCD refresh 后 `rollout status` 会在旧
状态上立刻返回成功，需轮询新 pod 名出现。**遗留（add-llm-model-discovery）**：
`PUT /api/llm/providers/:id` 不接受 models 数组，后台 UI 无法改 provider 模型列表
（本次只能 /data 直写 + 手动重投影）；id 形态双向漂移（前缀↔裸）证明静态名册
必然腐烂，探针同步 + 名册可编辑是治本。

### 模型发现同步上线实录（add-llm-model-discovery，2026-09-30 sha-6048f89/Jenkins #47）

上次实录的「遗留」本次全部收口：`POST /api/llm/providers/:id/sync` 探活分类
（并发4×1-token、六桶、限流/网络单重试）、serving 追加合并（家族元数据
deepseek 32768+efforts / glm-5.3-flash 32768 / 默认 128k-8192）、死 id 只标记
不驱逐、家族 rank 排序、`PUT …/providers/:id` 接 models 数组（运行时名册
编辑，400 回滚）、Models 页同步按钮/编辑器/状态芯片（admin 门禁，五语言）。
单测 18/18 + e2e 5/5（llm-model-sync.spec.js）。

**部署管道**：走了 Jenkins #47 降级路径（TCR 主链路当日并行演进中——本
变更的 GHA run 构建的是瘦身前胖镜像 ~2GB，1.3-2Mbps 推 TCR 需数小时，Push
步 1h 后取消；其间用集群凭证 token dance 探到 `NAME_UNKNOWN`，实为**空仓
库假阴性**——`yizuo/platform` 已建，同晚 22:22 并行会话的瘦身镜像 run 已全
绿入库 sha-828a6df，勿重蹈覆辙）。Gitee `deploy/prod-snapshot` fast-forward
（Gitee `deploy/prod-snapshot` fast-forward 到 6048f89，generic-webhook
token=`platform` 触发），冒烟过推 Harbor sha-6048f89；GitOps f3cd6e3（manifest
维持 Harbor 路径未动）；ArgoCD refresh 后节点闪断（FailedScheduling + pod 重建），
镜像经 mesh 拉取约 10 分钟，最终 1/1 Running。

**生产同步（finddata-token）**：33 id 全分类，4 serving（全免费池：cohere/
dots-studio/gemma-26b/ling-sante，后者自动合并 13→14，discovery 33 条落盘）。
**deepseek 车道与 glm-5.3-flash 在 dev+prod 两把 token 上都 unauthorized**
（"not supported by any configured account in this group"）——网关侧新挂的
deepseek 账户没绑到平台 token 所在组，等绑定后一次 sync 即可回归（排序保
deepseek 头部）；「≥13 serving」验收因此未达，属网关外部状态。**真实对话**：
`PUT /api/llm/default` 只改指针不动运行中会话的活跃模型——首轮照打 dark
deepseek（平台如实透传网关 404，错误路径端到端验证）；WS `set_model` 切
cohere 车道后一轮回复「收到」；默认指针已恢复（恢复 PUT 偶发 503，重试即过）。

### 内置车道后台可配 + 默认车道守卫（add-editable-llm-route）

10-01 事故（暗默认 + 重启锚回 = 新会话全 404）之后，内置 Volces 车道不再
是镜像常量的只读投影。**Models 页（admin）现在可以直接编辑它**，全程热载、
零重启、零重打包：

- **名册 + base URL 覆盖层**：持久化在 `llm-providers.json` 的
  `volcesOverride` 键，优先级 **override > env（LLM_BASE_URL）> 镜像常量**。
  sync 对 volces 不再干跑——serving id 落盘进 override；卡片上有「已覆盖」
  徽标和**清除覆盖**按钮（一键回滚到 env/镜像态）。API key 永不出 env、
  路由不可删（key 轮换照旧走 Secret patch）。
- **每模型 contextWindow / maxTokens 均可编辑**（名册编辑器每行两个输入框，
  全部 provider 通用）。
- **默认车道守卫**：boot / sync 后 / 改默认后，对默认模型发一发 1-token
  探活。明确 `model_not_found`/未授权类 4xx → 自动把默认切到最近一次 sync
  分类里第一个 serving id，广播 `model_fallback`（客户端弹 toast）。网络
  错误/超时**不回退**（网关抖动不得悄悄挪默认）；无 serving 已知时保持
  原默认并打日志。boot 探测失败不影响启动（listen-first 窗口内完成）。

网关再漂移时，处置从「改代码 → 建镜像 → 滚动」降级为「Models 页点同步 →
必要时编辑名册」；默认车道暗了自愈，不再等人工发现。

## Multi-tenant cloud deployment (gateway + cells)

The single-process deployment above serves **one** shared runtime. The hosted
product shape is different: each user gets their own isolated runtime, and a
thin **gateway** in front authenticates them and routes to it.

```
                  ┌──────────────────────────────────────────────┐
browser ──https──►│ gateway  (gateway/index.js)                  │
                  │  Logto login · session cookie · WS upgrade    │
                  │  cell registry: spawn / health / idle reap    │
                  └───────┬───────────────────┬──────────────────┘
                          │ loopback + gateway secret
              ┌───────────▼─────────┐  ┌──────▼──────────────┐
              │ cell alice          │  │ cell bob            │
              │  server.js + dsh    │  │  server.js + dsh    │
              │  /data/<alice>/…    │  │  /data/<bob>/…      │
              └─────────────────────┘  └─────────────────────┘
```

A **cell** is exactly the single-process deployment above — one `server.js`,
one dsh child, one data root — so the desktop app and `npm start` are the
one-cell form of the same thing. Nothing inside a cell knows other users exist;
that is what makes isolation a process boundary instead of application logic.

### Running it

```bash
# One gateway, which starts cells as users arrive.
CELL_GATEWAY_SECRET=$(openssl rand -base64 32) \
CELL_DATA_ROOT=/data/cells \
GATEWAY_PORT=3080 GATEWAY_HOST=127.0.0.1 \
AUTH_MODE=logto PAAS_BASE_URL=https://paas.example.com \
LOGTO_ENDPOINT=https://auth.example.com LOGTO_APP_ID=… LOGTO_APP_SECRET=… \
SESSION_SECRET=$(openssl rand -base64 32) \
node gateway/index.js
```

`npm run gateway` is the same thing. Cells are spawned by the gateway; you
never start them by hand in production (`.env.example` documents the per-cell
env matrix for doing so while debugging).

### Environment

**Gateway:** `GATEWAY_PORT` (default 3080), `GATEWAY_HOST` (bind address — this
is the deploy's public surface), `CELL_DATA_ROOT` (per-user data root),
`CELL_GATEWAY_SECRET` (**required**; the gateway and cells share it),
`CELL_IDLE_REAP_SECS` (default `0` = never), `CELL_START_TIMEOUT_MS` (default
60000), plus the `LOGTO_*` / `SESSION_SECRET` / `PAAS_BASE_URL` set from the
Logto section above.

**Cells** are configured entirely by the spawner: `PLATFORM_DATA_DIR`,
`DSH_HOME`, `MCP_CONFIG_PATH`, `PORT`, `HOST=127.0.0.1`, `AUTH_MODE=forward_auth`,
`CLOUD_MODE=1`, `CELL_GATEWAY_SECRET`, `CELL_USER_EMAIL`. They inherit the
gateway's environment for everything else, which is how they get `LLM_API_KEY`
and friends. `DSH_SHARED_HOME` (default `~/.dsh`) is the deployment's installed
dsh tree; a fresh per-user `DSH_HOME` is scaffolded from `dsh-profile-template/`
and linked to it read-only, so every cell resolves the same bundles without a
per-user install.

Two rules are not optional:

1. **Cells bind loopback only.** Never expose a cell port. The gateway is the
   only reachable surface; the secret is defence-in-depth for the shared-host
   case, not a substitute for this.
2. **`CELL_DATA_ROOT` must be local disk.** Every store is SQLite + WAL, and
   SQLite over NFS corrupts. A network filesystem here will lose data.

### Logto app registration

The gateway is the **only** Logto client; cells never talk to the identity
provider. Register one confidential web application with redirect URI
`<PAAS_BASE_URL>/auth/callback` and post-logout `<PAAS_BASE_URL>/`, enable the
`organizations` / `organization_roles` claims as described above, and give the
gateway `LOGTO_ENDPOINT` / `LOGTO_APP_ID` / `LOGTO_APP_SECRET`. Group names
still arrive as cell identity (`X-Forwarded-Groups`), so `admin` remains the
administrative group.

### WeChat mini program client (Taro)

`miniapp/` is a Taro (React) thin client — chat + session history — that speaks
the same WS/REST contracts as the web app through the shared `packages/core`
package. It authenticates through a second identity path, WeChat login,
instead of the Logto browser redirect. The path exists on BOTH deployment
shapes: the multi-tenant gateway **and** the single-process `AUTH_MODE=logto`
server (`add-single-process-mp-auth` — same `/api/mp/*` contracts, same
shared `gateway/mp-auth.js` / `gateway/mp-bindings.js` modules, one
implementation).

**Server env** (all three required to enable the path; unset = the login
routes report "not configured" and every browser flow is unchanged):

| Variable | Meaning |
|---|---|
| `MP_APPID` | the mini program's AppID |
| `MP_SECRET` | the mini program's AppSecret (**server-side only**) |
| `MP_TOKEN_SECRET` | JWT signing key for platform tokens (`openssl rand -base64 32`) |
| `MP_TOKEN_TTL_HOURS` | token lifetime, default `12` (the client silently re-logins via `wx.login`, so a shorter value is fine) |

Login is **account binding with bind codes** (Logto offers no password
grant — OAuth 2.1 removed the flow — so credentials never enter the mini
program):

1. First launch on a device: the user signs into the WEB app in a browser
   (the normal Logto flow) and opens **`/api/mp/bindcode`** — a small page
   shows a 6-digit code (5-minute, single-use, minted from their
   authenticated session).
2. They type that code ONCE on the mini-program login page:
   `POST /api/mp/login-bindcode {code, bindCode}` pairs the fresh
   `wx.login()` code (the WeChat user) with the bind code (account
   ownership) and binds the openid to the account
   (`<CELL_DATA_ROOT>/mp-bindings.json` on the gateway;
   `data/mp-bindings.json` under the single-process deployment's
   `PLATFORM_DATA_DIR` — same file format, so a file can be carried between
   shapes).
3. Every later launch is silent: `wx.login()` → `POST /api/mp/login {code}`
   → `code2Session` → binding lookup → a platform JWT carrying the ACCOUNT
   email/groups, sent as `Authorization: Bearer` on REST and on the WS
   upgrade. Because the identity is the account email verbatim, the mini
   program and the browser resolve to the SAME dataset (the same per-user
   cell on the gateway; the one shared runtime single-process).
4. `DELETE /api/mp/bind` (logout) removes the binding.

`MP_TOKEN_SECRET` is deliberately separate from `CELL_GATEWAY_SECRET`.

**Demo mode (openspec: mp-demo-mode; gateway only)** — set on the PROD
gateway's env when enabling:

| Variable | Default | Meaning |
|---|---|---|
| `MP_DEMO_MODE` | `0` | unbound openids get a demo identity instead of `binding_required` (the WeChat-reviewer path: open, chat, zero popups) |
| `MP_DEMO_MAX_CELLS` | `3` | concurrent demo cells; beyond, a friendly busy `503 {"code":"demo_capacity"}` |
| `MP_DEMO_IDLE_SECS` | `900` | idle demo cells are stopped and their data dir deleted (account cells unaffected) |
| `MP_DEMO_MSG_LIMIT` | `20` | prompts answered per demo cell before the bind-your-account reply |

Demo identities are `demo-<hash>@demo.invalid` (reserved TLD — can never
collide with a real account), group `demo`, one isolated cell per openid.
Ignored by the single-process server on purpose (one shared runtime would
expose the owner's data). Rollback: unset `MP_DEMO_MODE` — leftover demo
cells reap themselves away. `/api/gateway/status` reports `demoCells` for
monitoring.

**Demo sandbox pod (openspec: mp-demo-sandbox)** — the fd-prod answer for
"reviewer must chat for real", since that deployment runs single-process and
cannot host cells. A dedicated accountless twin (`platform-demo`, manifest
`fd-infra-deploy/all-services/prod/platform-demo.yaml`, NodePort 31871):
`AUTH_MODE=none` + `DEMO_SANDBOX=true` (per-connection `MP_DEMO_MSG_LIMIT`
budget, uploads 403, sessions wiped every `DEMO_SANDBOX_WIPE_SECS`), emptyDir
data, anti-affinity with the account pod, LLM via the sub2api NodePort. The
mini program's unbound banner carries a 先体验 entry that switches the client
to `https://demo.finddatatech.cloud` (persisted base; 退出演示 restores).

Go-live checklist (operator, in order):
1. DNS A record `demo.finddatatech.cloud` → the entry IP (same as craw).
2. Safeline console: add site `demo.finddatatech.cloud` → `127.0.0.1:8080`
   + certificate (mirrors the craw site).
3. WeChat console → 开发管理 → 服务器域名: add
   `https://demo.finddatatech.cloud` to request **and** socket 合法域名.
4. Trigger the Jenkins `platform` image build (manual webhook as usual).
5. One GitOps commit: bump BOTH `platform` and `platform-demo` image tags to
   the new sha AND set platform-demo `replicas: 1`; ArgoCD syncs. The Caddy
   block (`demo.…:8080 → 127.0.0.1:31871`) is already in place and inert
   until this step.
6. Probe: fresh WeChat account → 先体验 → chats with zero popups; the cap
   replies after the budget; `/api/documents` 403s; sessions wipe on the
   timer. Then upload the new client version and resubmit for review.

Rollback: platform-demo `replicas: 0` (one commit) — nothing else holds
state; the client's demo entry then shows the sandbox unavailable and the
normal sign-in flow is untouched.
**Local rehearsal without the real MP AppSecret:**
`node scripts/dev-mp-gateway.mjs` — the real gateway + real Logto from
`.env`, with a mock code2Session that maps every wx.login code to one dev
openid, so the whole bind → silent-relogin flow can be rehearsed in
devtools.

**Release prerequisites (ops — start these early):**

1. **A registered mini program AppID** (个人主体 is fine for chat; web-view
   would require an enterprise entity — this client does not use web-view).
2. **HTTPS/WSS + an ICP-registered domain.** Release requires the domain in
   the WeChat admin console under 开发 → 开发管理 → 开发设置 → 服务器域名, in
   BOTH lists:
   - `request 合法域名` → `https://<PAAS_BASE_URL>`
   - `socket 合法域名` → `wss://<PAAS_BASE_URL>`
   An IP, a port-numbered host, or an unregistered domain cannot be added.
   Devtools bypasses the check (详情 → 本地设置 → 不校验合法域名), which is how
   the client is developed against a local server. The client's default base
   URL is `http://localhost:3000` — `localhost`, not `127.0.0.1`, because the
   dev server binds IPv6 localhost only; for 真机调试 (real-phone preview)
   set the base URL to the dev machine's LAN IP.

**Building the client:** `cd miniapp && npm install && npm run build:weapp`,
then open `miniapp/` in WeChat devtools (`miniprogramRoot: dist/`, test appid
— no devtools-side npm build needed). The API base URL lives in mini-program
storage (`platform.baseUrl`); the default is `http://localhost:3000`.

**Verification without devtools:** `node --test scripts/test-mp-auth.mjs`
(boots a real gateway against mocked WeChat/Logto upstreams and a stub cell —
login exchange, Bearer routing, header stripping, WS upgrade auth, identity
stability) and `node --test scripts/test-ws-reconnect.mjs` (the shared
reconnect state machine).

### Sizing and lifecycle

Each resident cell is a Node process plus a dsh child plus that user's page
cache — budget **roughly 150–300 MB per cell** and size the host for the number
of users you expect *concurrently resident*. 100 resident cells wants on the
order of 20–30 GB of RAM, so the always-on default is comfortable to low
hundreds of users on a modest pool and wants reaping or Phase 3 density work
beyond that.

Cells are **always-on by default**: the first authenticated request starts one
and it stays. Being started means the user's cron jobs fire and bots poll,
which is the point. Setting `CELL_IDLE_REAP_SECS` trades that away: after that
much idle time a cell is stopped. The reaper asks the cell for its enabled
scheduled work before stopping it, and a cell with **any enabled cron job or
bot is exempt** — so "reaped" never silently breaks a schedule that the user
set up and left enabled. A disabled job does not block reaping.

The offline contract, which must be stated to users: **a stopped cell means
that user's chat is briefly unavailable on their next visit and their scheduled
jobs do not fire while it is stopped.** Coming back is a cold start — the
server boots and completes its dsh handshake before the agent can answer, which
is seconds, once per idle cycle. Nothing is lost; the data root persists.

### Observability and operation

```bash
curl http://127.0.0.1:3080/healthz                 # liveness (+ resident cell count)
curl -H "Cookie: paas_session=…" http://127.0.0.1:3080/api/gateway/status
```

`/api/gateway/status` is admin-gated and lists every cell as
`{user, userId, state, pid, port, lastTraffic, uptimeMs, error}`. `state` is
`starting` → `running` → `stopping`, or `error` when a cell exits unexpectedly
(its user's next request cold-starts a fresh one). A crash is scoped: one cell's
failure never touches another user's.

`SIGTERM` on the gateway stops every cell before exiting, so a redeploy does not
leak one process per user on the host.

### Phase 3 outlook (explicitly out of scope today)

Cells here are child processes on one host, and `gateway/spawner.js` is the only
file that knows that. The intended next step replaces `spawn()` with a k8s
client and PVC-per-user, at which point:

- **Density and isolation** come from pods and namespaces rather than process
  cgroups; the gateway↔cell contract (HTTP + WS to a loopback-reachable cell,
  identity via headers + shared secret) is unchanged.
- **Durability**: cell data roots move to per-user PVCs, and backup/restore
  becomes a per-directory operation — the layout was chosen so it would be.
  Until then, **losing the host loses that host's users' data**; there is no
  replication or backup in this cut.
- **Scaling**: the gateway is single-instance and in-memory, so cells are not
  HA either. That is a deliberate first-cut trade, not an oversight.

---

## fd-prod 多租户网关布局（migrate-fd-prod-cells）

fd-prod 从单进程 platform 迁到网关+cells（ADR 0008：多租户隔离是 cell，不是进程内 ACL）。
对外 origin 不变（craw ingress 原样；Logto 回调、MP 客户端、已注册 Agent Service、分享链接
全部不动）。单进程模式（dev/桌面/demo pod）不受影响。

### 启动命令与 env

Deployment 的启动命令改为 `node gateway/index.js`（镜像不变；`GATEWAY_PORT` 默认 3080，
ingress 指向它即可，或设 `GATEWAY_PORT=3000` 沿用旧探针）。env 分三层：

```yaml
# platform-config（ConfigMap）——网关本体 + baseEnv 继承进每个 cell
GATEWAY_PORT: "3000"            # 沿用现有探针端口，或改 ingress 指 3080
CELL_DATA_ROOT: /data/cells     # hostPath，节点预建并 chown 1000:1000
CELL_GATEWAY_SECRET: <secret>   # 见 platform-secrets，随机 ≥32 字节
CELL_IDLE_REAP_SECS: "3600"     # 账号 cell 闲时回收（有启用的 cron/bot 的 cell 豁免）
AGENT_WORKSPACE: /data/workspace  # 保留：单进程回滚模式仍需要；网关路径下被
                                  # spawner 的 per-cell 值权威覆盖，无害
AGENT_SERVING_RUNNER_URL / AGENT_SERVING_PACKS_URL / AGENT_SERVING_BACKEND_TOKEN
  # 不变——deploy 路由挂在网关进程上（gateway/packs.js），env 必须在网关层可见
# LLM_BASE_URL / REGISTRY_URL / MARKET_REGISTRY_TOKEN 等经 baseEnv 流入每个 cell
```

**不要**把 `AGENT_WORKSPACE` 从 config 删掉：GitOps 回滚到单进程时它就是 workspace pin
（fix-agent-workspace 的原始语义）。spawner 在 `...baseEnv` 之后注入
`<CELL_DATA_ROOT>/<userId>/workspace`，网关级残留值永远不生效（有单测钉死）。

### 节点预备（一次性）

```bash
# fd-prod 节点（cheap-5）：cells 根 + 属主（镜像 node 用户 uid 1000）
mkdir -p /opt/platform/cells && chown 1000:1000 /opt/platform/cells
df -h /opt    # 迁移是拷贝语义，磁盘要能容纳旧 /data 的一倍（当前 ~786M，宽裕）
```

### 资源包络

网关 pod request 1Gi / limit 2Gi（实测：单进程 328Mi、网关空载 230Mi、活跃 cell ≈
300–400Mi；≈4–5 并发活跃 cell + 网关本体）。burn-in 一周后按观测调整（见检查单第 8 步）。

### 存量数据迁移（停机窗口内）

```bash
kubectl --context cheap -n fd-prod exec deploy/platform -- node scripts/migrate-single-to-cell.mjs \
  --email 3106241601@qq.com \
  --data-dir /data --dsh-home /opt/dsh-home --cell-root /data/cells --stamp-unowned
```

拷贝语义（旧 `/data` 原地保留 = 回滚路径）；`--stamp-unowned` 把无主会话盖给 owner
（session-ownership 的范围列表按 owner 严格匹配，不盖章旧会话会从列表消失）；
`--dry-run` 先看计划。已知遗留：`aloadtree@gmail.com` 名下 4 个会话会随全量落进 owner
cell（对其 owner 不可见的孤儿行）——cutover 前决定：接受（4 条，无害）/ 拆分到第二 cell /
让该账号自弃（见检查单第 1 步）。

### Cutover 检查单

1. **准入冻结（D7/Q11）**：Logto 控制台核对用户列表并处置第二账号（3106241601@qq.com =
   owner；aloadtree@gmail.com 的 4 个会话去留在此定）；注册开关置关，burn-in 后再开。
2. **取证**：registry 侧记下当前 Agent Service 注册 URL（cutover 后探活对照）。
3. **停机**：`kubectl scale deploy/platform --replicas=0`（Recreate 语义下等 pod 退净）。
4. **迁移**：跑上面的 migrate 命令；输出核对「landed N files」与计划一致。
5. **换入口**：GitOps 提交（command 改 `node gateway/index.js`、env 增补如上、资源包络
   1Gi/2Gi）→ ArgoCD sync → `kubectl logs | grep '\[gateway\]'` 确认 listening + 首个 cell。
6. **回归（web）**：登录（旧会话失效一次，预期）；会话列表/文档库/资源库逐项可见；让
   agent 写一个文件 → `/api/files?root=workspace` 200。
7. **回归（a2a + MP）**：演示服务 `vtdpsNmtW6OQ9I99mBhbDw` 原址 message/send 一次；
   MP 真机走查（含 401 静默重登分支）。
8. **隔离冒烟**：Logto 手建第二个测试账号登录 → 断言看不到 owner 的文档/资源/workspace
   文件；完成后删测试账号。
9. **burn-in（一周）**：ops-console 内存灯 + `kubectl top pod` 记录 cell 形态，决定
   `CELL_IDLE_REAP_SECS` 是否收紧；期满删旧 `/data` 原件（workspace 大文件先归档），
   并在此记录清理日期——**清理后回滚条款作废**。

### 回滚

revert GitOps commit → 单进程以原 `/data` 起回（`AGENT_WORKSPACE` pin 仍在 config）。
cutover 后 cell 侧新产生的数据不回流（公告口径）。旧 `/data` 删除前，回滚永远可用。

### 实录：fd-prod 网关化 cutover（2026-10-01 20:15–20:30，18/20）

- 镜像 sha-c34b6f3（代码侧 20 文件，paas@c34b6f3）；GHA 构建 + 中继窗口 5min。
- 停机窗口 ~15s（scale 0→迁移 pod 完成 3201 files/955.9MiB 对账一致、2 无主盖章、
  aloadtree 4 会话弃置）→ GitOps 7e5e18f。**教训两发**：①ArgoCD 无 gitee webhook，
  push 后 default reconciliation 不拉新——`kubectl -n argocd patch application
  all-services-prod --type merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'`
  立即触发；②fd-infra-deploy 的 `origin` 不存在、`gitee` remote 的 push 段被改指 github——
  ArgoCD 真源是 **gitee**，推 `git push git@gitee.com:FindDataTechnology/fd-infra-deploy.git main`。
- selfHeal 在 push 卡壳的 2 分钟里复活过旧 pod（无人写入，无害）；探针改 /healthz、
  资源 1Gi/1Gi Guaranteed（节点实为 liuliangjkiimypbdzxa 4Gi、与 Jenkins 同居——未上
  design 初稿的 2Gi，等 burn-in 数据再调）。
- 验证：craw /healthz 200；旧 session-secret 经 PLATFORM_DATA_DIR 回落 → **存量浏览器
  cookie 免重登**；owner 会话列表/文档/资源库 8 条/workspace 文件 200（自迁移后 cell）；
  pack 部署记录在册；隔离冒烟：第二身份 0 会话/0 文档/0 资源 + owner 文件 404。
- 迁移时会话数比午后快照多：用户当日下午在用（owner 行 70→77），非异常。

---

## File map

```
Dockerfile                          # multi-stage single-process image build
.dockerignore                       # excludes built resource payloads + secrets
Makefile                            # build/run/k8s/argocd shortcuts
k8s/
  service.yaml                      # NodePort 30950 → :3000
  deployment.yaml                   # 1 replica, Recreate, image tag set by CI
argocd/
  application.yaml                  # ArgoCD app (apply once)
.github/workflows/
  docker-deploy.yml                 # build + push + GitOps commit-back
  release.yml                       # (unchanged) Electron .dmg/.exe installers

gateway/                            # multi-tenant front door (not used by the single-process deploy)
  index.js                          # Logto auth, routing, WS upgrade, /healthz + /api/gateway/status
  mp-auth.js                        # mini-program identity: code2Session + platform JWT (Bearer)
  spawner.js                        # cell lifecycle: spawn, health, idle reap, shutdown
  proxy.js                          # HTTP + WebSocket forwarding; injects the verified identity
packages/core/                      # shared protocol core (WS client + chat store + REST clients)
                                    #   consumed by web/ and miniapp/ via file: — no build step
miniapp/                            # WeChat mini-program client (Taro + React)
  config/index.ts                   # webpack chain: @platform/core + zustand aliases
  src/lib/                          # runtime (auth/http/socket), markdown parser, canvas charts
  src/pages/chat|sessions/          # chat + read-only session history
scripts/
  test-cell-containment.mjs         # a cell writes only under its data roots
  test-cell-isolation.mjs           # two cells: no cross-cell state, events, or errors
  test-cell-gateway.mjs             # gateway auth, routing, sticky WS, restart, idle reap
  test-cell-bindings.mjs            # saved bindings are what a cell boots on
  test-mp-auth.mjs                  # mini-program login/Bearer/WS auth against a real gateway
  mp-stub-cell.mjs                  # stub cell used by test-mp-auth (not a test)
  test-ws-reconnect.mjs             # shared WsClient reconnect state machine
```

### Ops console (internal read-only board)

`ops-console` (fd-infra-deploy `all-services/prod/ops-console.yaml`) is the
internal operations board (spec: `openspec/specs/ops-console` in the paas
repo). NodePort **31890** on any node, e.g.
`http://<node-ip>:31890/` — every route except `/healthz` needs
`Authorization: Bearer <OPS_CONSOLE_TOKEN>` — or, better, just log in via
Logto: access is gated on membership in the Logto organization `ops-console`
(ID `tvs6wkjtn8ic`, carried by the ID token's organizations claim; fail-closed
when absent). To grant someone the board: Logto console → Organizations →
ops-console → Members → Add member. No redeploy needed. The tenant-roles
approach was tried and withdrawn — this Logto build never issues the roles
claim (see design D10). Secrets live only in the cluster Secret
`ops-console-secrets` (same rule as platform-secrets:

```bash
kubectl -n fd-prod get secret ops-console-secrets \
  -o jsonpath='{.data.OPS_CONSOLE_TOKEN}' | base64 -d; echo
```

The board's canonical URL is **https://paas-admin.finddatatech.cloud/** (SafeLine → Caddy on cheap-1 → NodePort 31890 over tailscale; the raw `http://<node-ip>:31890` still works VPN-side, and both redirect URIs are registered in Logto). Login is Logto SSO against the allowlist — visiting the board URL logged out auto-redirects to the sign-in page (API callers without a session keep a flat 401; send `Authorization: Bearer <token>`).

What it shows: cluster banner (per-node memory, 24h Evicted/OOM count,
Jenkins queue depth, ArgoCD sync), one vertical chain card per watched
deployment (replicas, image tag, `/api/ready` probe), Jenkins/Harbor blocks,
search-relay quota/cache stats, and a per-card **version-drift light**
comparing the running tag, the GitOps sync state, and the latest successful
Jenkins build's pushed tag — `newer-build-not-rolled` means a build exists
that was never rolled; `cluster-out-of-sync` means the cluster diverges from
the GitOps repo.

Updating the board's code: edit `services/ops-console/index.js` in the paas
repo, re-embed into the ConfigMap, push, then
`kubectl -n fd-prod rollout restart deploy/ops-console` — **subPath ConfigMap
mounts do not hot-update running pods** (same for search-relay's code).
Rollback is deleting the deployment; nothing else depends on the console.

### 实录续 2：6.2 全链路 ALL GREEN（2026-09-30 深夜）

`scripts/probe-agent-serving.mjs`（经 cheap1 `probe-wrapper.sh`：前置/后置扫删 probe 残留）对
staging 全链路七步全绿：deploy v1 → runner 拾取 → 健康复检出块 → 三层鉴权（匿名 401 /
仅网关凭证被 runner 401 / 双凭证 200 卡片）→ **真实 dsh 回合**（finddata/deepseek-v4.1-flash，
9.4s 含冷启，技能指令被遵守）→ SSE 流式 → v2 原地升级（排水、条目不增殖）→ 下线（监听器停）。
最终修形：**registry 技能按 name 全局键控**——部署库先按名查实际存储路径再 PUT（升级路径），
`skill_md_url` 指向 pack 网关的公开 md 路由（`AGENT_SERVING_PACKS_URL`），注册后安全扫描会
禁用 agent（库自动 toggle 回启用）。staging 栈：cheap1 容器 `agent-runner-dsh`
（node:22-slim + 挂载代码 + npmmirror 钉版 dsh 运行时，端口段 8790-8850 只绑尾网；
生产形态仍按 runbook 用平台镜像）。演练模型遵守用户规则 deepseek-v4.1-flash。
（2026-10-06 注：本行所记为其历史形态——容器已重锚为平台镜像第三角色，「staging
runner」称谓废弃，见「生产 runner 重锚平台镜像」一节。）

### 实录：agent-serving 全量上线 fd-prod（2026-10-01，sha-30edadc / GitOps 1108c15）

- **流程**（现行 canonical）：push main → `image.yml` 自动构建（3m18s，smoke 过）→ hkccr
  `sha-30edadc` → cheap-3 tcr-relay ≤5min 同步 ccr（**确认 RELAYED 后才 bump**，防
  ImagePullBackOff）→ `fd-infra-deploy` platform.yaml + platform-demo.yaml 双 bump →
  ArgoCD refresh → 新 pod Running，Synced/Healthy。
- **env 接线**（platform-config / platform-secrets，随本次 rollout 生效）：
  `AGENT_SERVING_RUNNER_URL=http://100.64.0.11`（staging runner 起步；正式迁移改新宿主
  origin 即可，端口由 `agentPortFor` 派生）、`AGENT_SERVING_PACKS_URL=https://craw.finddatatech.cloud`
  （技能 md 公开路由所在）、`AGENT_SERVING_BACKEND_TOKEN`（= runner 的
  AGENT_RUNNER_BACKEND_TOKEN，cheap1 `/opt/agent-runner-stage/.backend-token`；**轮换需两侧同步**）。
- **三验证**：`/api/ready` 200；`POST /api/packs/:id/versions/:v/deploy` 挂载（匿名 401）；
  registry 桥 agents 拉取 200（a2a: 0 —— 尚无带契约 pack，预期）。
- 注意：`kubectl rollout status` 在 pod 启动窗口可能超时报错——以 `get pods` +
  ArgoCD health 为准（本例即虚惊）。

### 实录：首个 Agent 服务上线（2026-10-01，§6.1 收口 — 21/21 全勾）

- **首部署**：pack「部署演示 · FingPt 分析师」v1（`vtdpsNmtW6OQ9I99mBhbDw`，一个技能 +
  一个 serving 契约角色）在 fd-prod 容器内经真实部署库发布+部署（`kubectl exec` +
  `createPackRegistry` + `deployToRegistry`，作者 ops-seed@finddatatech.cloud；
  bookkeeping 已记，详情页显示已部署 v1 在线）。**首对话**：经生产网关
  `/agent/packs/<id>/pack-demo-fingpt/` 一轮 message/send，runner（cheap1 staging）→
  专用 dsh 子进程 → deepseek-v4.1-flash，人设与技能指令严格生效（复述→结论→不编数）。
- **首部署三弹修复**（全部实弹暴露）：① registry 匿名抓取 skill_md_url 被 craw 会话门 401
  → `/api/packs/**.md` GET 进两个公开谓词（`isPublicRequest` + `isLogtoPublicRequest`，
  双谓词漏改一发）；② path-to-regexp 部分版本把 `.md` 留在路由参数 → 参数归一化；③
  dsh preset 插件 id 正则仅小写，base64url pack id 大小写混合 → runner preset id 小写化。
  伴生：staging runner 误写 `$PDD/packs.db`（正确是 `$PDD/data/packs.db`，已清）；
  matrix 启动门在 staging 用 `DSH_MATRIX_OVERRIDE=1`（手装树 vs 冻结锁差一包，报告照记）。
- **创作侧入口**：pack 编辑器新增「部署为 Agent 服务（A2A）」开关（sha-16cd264 起），
  市场 · 详情页「部署为服务」按钮即用。

### 驻留运行时（add-agent-residency，2026-10-02）

**行为变化**：runner 不再按 30min 闲置回收——已部署 agent 默认驻留（ADR-0010）。
温区是唯一降级路径：host 内存预算超限时逐出最久未活动的驻留 child（进程停、
home/会话留盘，下次触达秒级热起）；冷却 10 分钟内的 child 不逐（硬超 120% 除外）。

**旋钮**（agent-runner env）：

- `AGENT_RUNNER_RESIDENT_BUDGET_MB`（默认 3072）——host 内存预算（采样 RSS +
  每 agent 固定成本取大者计账）；
- `AGENT_RUNNER_AGENT_COST_MB`（默认 96）——**RSS 复调常数**。实测记档（2026-10-02）：
  cheap1 staging 长闲置 child Linux RSS 仅 4.9MB（换页回收后）、macOS 新起空闲
  18–54MB（活跃带载增长）；活跃稳态 Linux 未实测——保持 96MB 保守值，首次真实
  带载驻留后按 `docker top agent-runner-dsh -o rss` 复调（实测 ×1.3）；
- `AGENT_RUNNER_TURN_TIMEOUT_MS`（默认 180000，即 3m）——**部署默认回合预算**：无
  `effective_budget_minutes` 描述符的 agent 以此值为硬停上限（语义收窄，见「回合预算」）；
- `AGENT_RUNNER_TZ`（默认 Asia/Shanghai）——每日节奏与日界的时区；
- `AGENT_RUNNER_ARCHIVE_DIR`（默认 `<home>/agent-archive`）——每日纪要归档目标，
  NFS/对象卷直接挂此路径；
- `AGENT_RUNNER_METER_FILE`（默认 `<home>/meter.jsonl`）——每回合计量
  `{agent, kind: message|self|digest, tokens?, durationMs, at, budgetKill?}`，③ 计费结算的输入
  （`budgetKill:true` = 该回合超预算被硬停）。

**节奏与暂停**：`serving.rhythm`（pack 契约，作者默认）→ 部署时 `rhythms` 覆盖
（descriptor 记生效值）→ runner 调度器按节奏注入自主回合（错过即跳过不补跑）。
日界滚动：旧日会话由 digest 自主回合总结 → 归档 + 次日会话头部注入「昨日纪要」。
暂停 = registry 条目 `paused` 标记（deployer 按钮或平台急停端点写同一标记）；
runner 轮询生效（≤5min），对来话回显式 `-32010 agent paused`，恢复一键。回滚 =
旧镜像（idle-reap 行为回归，盘上状态无 schema 变更）。

### 回合预算（add-serving-budgets，2026-10-03）

**契约字段**：serving 契约可声明 `budget.turnMinutes`（正整数、≤120 平台上限；纯时长
声明，多余键与非时长形状一律拒绝——与 rhythm 同纪律，见 `lib/pack-manifest.js`）。

**部署覆盖**：deploy 请求体 `budgets: { "<agentId>": minutes | null }`（与 `rhythms`
同验证点）；`null` = 清除覆盖回契约声明。有效值 = 覆盖 → 契约声明 → 缺省，落描述符
`effective_budget_minutes`（纯数值；改预算的重新部署会排水旧 child，下次触达按新预算重生）。

**执行语义（硬停，ADR-0014 ④）**：runner 按每 agent 有效预算执行**所有回合来源**
（message / 节奏自主回合 / 日界纪要同一预算）；超限即硬停——child 进程被杀、下次触达
冷启重生（私有 home、会话存储、agent 写的文件全部留盘），调用方收到指名上限的结构化
错误（`-32001 turn budget (Nm) exceeded`），计量行带 `budgetKill: true`。无描述符预算的
agent 走部署默认 `AGENT_RUNNER_TURN_TIMEOUT_MS`（默认 180s）——env 语义收窄为「无声明时的
全局默认」，超时同样硬停（旧「仅放弃等待、child 照跑」的软预算已被 ADR-0014 否决）。
**展望**：dsh 提供中断 RPC 后，硬停降级为优雅停（发中断、等回合收敛再杀，ADR-0014 原文）。

**验证**：`scripts/probe-serving-budgets.mjs`（cheap1 `probe-budget-wrapper.sh` 驱动，
2026-10-03 staging ALL GREEN）：部署 budget=1m agent → 慢回合 63.8s 硬停、错误指名 1m
→ runner 报 warm（child 已移除）→ 同上下文快回合 4.8s 冷启重生作答 → `meter.jsonl`
有 `budgetKill` 行与重生 ok 行。同批把 staging 的 dsh-profile 链同步到 repo HEAD
（`dsh-profile.js` / `paths.js` / `llm-providers.js` + 模板缺失的 user-questions bridge；
旧版备份 `budget-bak-20261003`）——修复 ③ 计费同步后「新 compose.js × 旧 dsh-profile.js」
配对致新 agent 私有 home 缺 presets 桥文件的既存问题（表现为 child 启动即崩、
`-32003 JSON-RPC input closed`）。

### 生产 runner 重锚平台镜像（fix-agent-data-workspace-writes，2026-10-06）

**形态变化**（ADR-0018）：「staging runner」称谓废弃——cheap-1 容器 `agent-runner-dsh`
自 2026-10-01 起即承载 fd-prod 生产流量；2026-10-06 从 node:22-slim + 挂载代码重锚为
**平台镜像第三角色**（`REGISTRY_IMAGE=<sha>` + `command: node agent-runner/index.js`），
代码只经 GHA→hkccr→tcr-relay→ccr 镜像通道落地。`/opt/agent-runner-stage` 退役（代码入
镜像、dsh 树入镜像冻结 matrix、env 迁 `agent-runner.prod.env`）；`DSH_MATRIX_OVERRIDE=1`
遗留豁免关断（启动门 pass 实测）。

**迁移要点（重放清单）**：

- 保留同名卷 `agent-runner-data` → `/data`（homes/meter/fleet spool 零搬迁）；旧容器
  stop + rename `agent-runner-dsh-old` 留回滚位；
- env 从旧容器 inspect 生成（去掉 `DSH_MATRIX_OVERRIDE` 与 `AGENT_RUNNER_SEED_HOME`，
  后者由镜像默认 `/opt/dsh-home` 接）——值不落文档；
- **运行时状态显式外置**：`LLM_PROVIDERS_STORE=/data/llm-providers.json`（旧 `/app` bind
  里的用户路由真件迁入卷；漏迁的症状 = child 初始化 `no adapter registered for
  provider "finddata"`）；
- 端口段 8790-8850 绑尾网 IP、`--user root`（卷属主 root；compose 亦钉 `user: "0:0"`，
  漏带 = 镜像默认 node 对 root 卷全线 EACCES）、`-m 1572864000` 与旧容器一致；
  healthcheck 带 compose 形态探针 `node -e "fetch('http://127.0.0.1:8790/health')…"`
  （镜像自 2026-10-07 起不再烘焙 HEALTHCHECK——角色错配曾让 runner 恒显 unhealthy；
  漏带只是没有健康信号，不再有假 unhealthy）。
- 回滚 = `docker start agent-runner-dsh-old`（child 再重启一回，home 完好）。

**验收实录**：4 在役 agent 全部重新监听；对 daas-analyst 直连 a2a 写/读回任务——agent
自报「workspace-write 未拒写 `$AGENT_DATA_DIR`」，`/data/packs-…-daas-analyst/data/
write-probe.txt` 独立复核 22 字节，meter 记录该回合。注意 `/opt/agent-runner-stage/
.backend-token` 文件值与容器 env 已漂移（「轮换需两侧同步」预警的现实版）——直连验收
取容器 env 值，不取文件。

### serving runner 独立 deployment（add-serving-runner-split，2026-10-13）

**形态变化**：上面「cheap-1 容器」形态退役——serving 车道迁入 k8s 独立 Deployment
`agent-runner-serving`（GitOps `all-services/prod/agent-runner-serving.yaml`）：专用节点
cheap-4（100.64.0.8）、hostNetwork、hostPath `/data/agent-runner-serving`、4Gi Guaranteed
（QoS armor）、常驻预算 3328MB / MAX_CHILDREN 8（M2 实测 ≈540-600MB/child → 真并发 5-6，
对比旧形态 2-3）、标准端口几何 ops 8790 + 8791/32（专用节点无撞口）。镜像与 runner-b/c
同源平台镜像（滚镜像 = 三清单同滚）。secret `agent-runner-serving-env` 带外（四 token
值自旧容器 env 原样拷：registry/backend/relay/fleet——**backend token 与 facade 共享，
轮换需两侧同步**）。cheap-1 侧 `agent-runner-dsh` 容器已 stop；**2026-10-13 深夜清理完毕**
（新 runner 过两次完整镜像滚 + 计费链复核后）：容器 `agent-runner-dsh-retired-20261013`
与卷 `agent-runner-data`/`agent-runner_agent-runner-home` 已删，卷内容 tar 归档留
cheap-1 `/root/retired-archive/agent-runner-data-20261013.tar.gz`（85M，最终回滚位）。

**切换配方（接管波，零手工改点）**：① rsync 旧卷数据（llm-providers.json 必带——漏迁
= child 初始化 `no adapter registered for provider "finddata"`）；② 新 Deployment 先带
`AGENT_RUNNER_DEFAULT_ID=cheap-1` 惰性启动（防与旧 runner 双宿主未打标条目——residency
无闲置回收，双宿主=白耗 1-2GB 常驻）；③ facet packs.db `agent_runners` 插新行（upsert
语义）；④ 停旧容器 → fleet-scheduler 90s stale 判死 → 条目自动改点余量最大 runner（新
runner 预算 3328 必胜）+ 打 `runner_id` 标签 + 端口环探防撞；⑤ 卫生步：fleet 表删旧行、
新行回填 created_at 成默认行 rows[0]、Deployment 去 DEFAULT_ID 滚一次、platform-config
`AGENT_SERVING_RUNNER_URL` 种子改新地址（ConfigMap 改动不动 pod template——facet/platform
需手动 rollout restart 吃新值）。回滚 = 重启旧容器 + 按本节语义手工 PUT 条目回旧几何
（滞回保证调度器不会自动搬回）。

**空回合免单（fix-empty-turn-billing，2026-10-13）**：child.js 采集器在
`session.status=idle` 结算时若整回合零 assistant 文本（trim 空）→ 按失败结算
（-32005，与 -32003 自报失败区分归因）→ 计量 ok:false / A2A JSON-RPC error /
facade 免单自动接管。判别式只能是**文本**：当时的 700/700 ok:true 行 tokens:null 不
表示 usage 缺席——真因是 tokensOf 字段名错配（dsh harness 是 camelCase 分列
inputTokens/outputTokens 无总数字段），已由 fix-turn-token-attribution 修复
（滚后实证 tokens:428）；即今日 usage 可用，判别式仍以文本为准（空回合问题域不同）。**探针配方**（复现静默空返做生产验证）：直写 registry
`/api/agents/register`（visibility:public + metadata.effective_model 指 roster 外
模型——trusted 平面绕过双门，正是事故原形状）→ 注册后安全扫描会禁用条目（鸡生蛋），
需 `POST /api/agents/{path}/toggle?enabled=true` 且要抢在扫描落禁用之后（部署库的
90/210/330s reassurance 同款时序）→ runner 20s poll 接管 → 直打 per-agent 端口验
HTTP 200 + `-32005` → 完事 DELETE 条目（runner 下轮 poll 自动排空）。

**切换实录**：101s 判死、8 条目（6 pack 代理 + 2 legacy 无 packId 条目）一次改点、撞口
环探真触发一次（override 8807）、rsync 的 home 让 spider-heal 直接 warm。计费全链经新
runner 复核：usage settled + 部署者分成 $0.07/回合落账。切换日 openrouter 上游大面故障
（deepseek 502/全线 free 车道限流），内容成功回合回执由链路验证+计费行+错回合 waived
管道代证；错回合误计 outcome:ok = F3.3 挂账缺陷②的活体再现（已退演练号 $0.20）。

### 开放前置双件：身份门 + 容量水位线（add-opening-gates，2026-10-13）

**默认全部为现行语义**（closed/512），开门=拧开关（改 GitOps env + rollout restart）：

| 开关 | 默认 | 语义 | 拧开动作 |
|---|---|---|---|
| `PACK_ACCESS_MODE` | `closed` | closed=发布/部署限 creator 组（逐字节不变）；`open`=任意登录用户可发布/部署（计费键经济闸仍在） | platform.yaml + facet.yaml env 改 `open` |
| `FLEET_CAPACITY_WATERLINE_MB` | `512` | 新增 child 的部署在最优 runner 余量（`budget_mb_limit−budget_mb`，board 读）低于水位时 503 `FLEET_AT_CAPACITY`（指名 runner/余量/水位）；在役 pack 重部署/升级豁免；board 不可达降级开 | 调数值（按 child 实测 ≈540-600MB 校准；0=关闸） |

**观测**：facet `/api/whoami` 带 `accessMode` 字段（生产实证 closed）；水位线判定读同一
board（`GET {FLEET_BOARD_URL}/api/fleet/v1/board`，runner 行 `budget_mb/budget_mb_limit`）。
**水位线手工对照配方**（改闸值前自查）：

```bash
FT=$(kubectl --context cheap exec -n fd-prod deploy/agent-runner-serving -- sh -c 'echo $AGENT_RUNNER_FLEET_TOKEN' | tail -1 | tr -d '\r\n')
curl -s -H "Authorization: Bearer $FT" http://100.64.0.8:31881/api/fleet/v1/board \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(k, v['budget_mb_limit']-v['budget_mb'], 'headroom') for k,v in d['runners'].items()]"
```

**验证实录**：facet whoami `accessMode:"closed"`；market-flash-briefer 真实重部署 200
（水线豁免+kept 键重校验路径）；三 runner 余量 2854/768/573 全 ≥512 与 ADMIT 一致；
新套件 `scripts/test-opening-gates.mjs` 8/8（closed 文案逐字节/open 双路径/水位四态）。

### 事件通知（add-agent-notifications，2026-10-03）

**契约面（pack 作者视角）**：每个部署的 child 组合经桥行获得一个 `bot_notify` 工具
——`bot_notify(event, text[, channel])`。`event` 是短事件键（萬星爬虫自愈四类示例：
`ticket_done` 工单终态 / `pr_opened` PR 开出 / `gate_changed` 总闸变更 /
`handoff_needed` 超限转人工；pack 可自定义），`text` 是正文（投递时平台加
`[event] ` 前缀），`channel` 可选且必须等于本部署绑定通道。工具返回平台真实回执
（`ok` / `reason` / `message` / `status`），拒绝进入回合、可写进 agent 状态；事件文案
与时机是 pack skill 的职责（平台只提供通道），失败不要盲目重试。

**部署绑定**：deploy 请求体 `notifyChannel: { "<agentId>": "<channel>" | null }`
（与 `rhythms` / `budgets` 同验证点；通道名形状 `[a-z0-9][a-z0-9._-]{0,63}` = 管理员
预绑的命名通道）。三态：**省略=保留**既有绑定（从 registry 条目描述符读回，同一版本
重部署不丢绑定）、`null`=解绑、字符串=绑定。通道存在性不在部署时校验——绑定表是平台侧
活数据，未知通道在发送时被 relay 结构化拒绝（404 Unknown channel）。描述符记
`notify_channel`；改绑会排水旧 child，下次触达按新绑定重生。

**runner 接线（env）**：

- `AGENT_RUNNER_RELAY_URL`——默认从 `AGENT_RUNNER_PACKS_URL` 同 origin 推导
  `/api/bots/relay/send`；
- `AGENT_RUNNER_RELAY_TOKEN`（=平台 `BOTS_RELAY_TOKEN` 的值）——**只在 runner 配置里**；
  child 的 spawn 环境在组合前被排干该键（含 `BOTS_RELAY_TOKEN`），spec 有专场景
  「令牌永不下发 child」；
- `AGENT_RUNNER_NOTIFY_RATE_PER_MIN`（默认 6）——每 agent 令牌桶（重生的 child 继承
  同一预算）；relay 侧 per-channel 10/min 仍是兜底，单 agent 先在 6/min 处被拦；
- `AGENT_RUNNER_NOTIFY_LOG`（默认 `<home>/notify.jsonl`）——runner 侧审计：每决策一行
  `{agent, channel, outcome: sent|rejected|failed, reason, textLen, at}`，**不落正文**；
  与 relay 侧 `bot_relay_log`（同样不落正文）双层。

**四类结构化拒绝（回传回合，绝不静默丢弃）**：`not-configured`（未设 relay token）、
`unbound`（本部署未绑通道，错误指名该缺失）、`channel-mismatch`（显式通道 ≠ 绑定）、
`rate-limited`（超 per-agent 上限，**未外发**）；relay 自身拒绝（401/404/429/5xx）以
`reason: relay` + `status` + `message` 原样回传。

**启用前置**：平台侧 `BOTS_RELAY_TOKEN` 未配置时 relay 路由整体 404（惰性，见
「Bot relay」节）。启用 = 生成 token → patch `platform-secrets` → rollout → 管理员绑
一个命名通道（`POST /api/bots/channels`，需一个 bot 已见过的 chat 对）；runner 侧补
`AGENT_RUNNER_RELAY_TOKEN` 后重建容器。**当前 prod 未启用**（secret 中无该键），
启用后无需任何代码改动。

**验证**（本批 2026-10-03）：

- 单测：`scripts/test-agent-runner.mjs`（绑定投递/三拒绝形状/第 7 次每分钟被拒且
  无外发/token 不入 spawn spec 与私有 home）、`scripts/test-agent-notify-bridge.mjs`
  （wire 帧与桥类：`botNotify/send` 上行 + `botNotify/result` 下行、超时/关机兜底、
  工具注册与渲染、notify.patch.yml 置换行）；
- 本地排演（真实 dsh child + 真模型 deepseek-v4.1-flash，stub relay）：绑通道回合
  → relay POST（`Bearer` 宿主令牌、`[event]` 前缀）+ runner 审计 + child 回执
  `NOTIFY-OK`；[RATE] 回合 → 超限拒绝无外发；未绑 agent → 结构化拒绝零外发；
- staging 探针 `scripts/probe-agent-notify-live.mjs`（复用 `probe-budget-wrapper.sh`
  的 cheap1 驱动形态：容器内 `docker exec agent-runner-dsh node scripts/…`，skill md
  放 ACME 公共路径；**待平台 relay 启用后实跑**）：绑 `test-channel` 部署 → 回合内
  bot_notify → relay/runner 审计行 + child 回执；未绑定与超限两路径。

### ② 跨 agent 委派 ops 前置（add-agent-delegation-a2a，2026-10-02 已执行）

invoke 门=scope 规则（非 allowed_groups）。本机 registry 的 scope **无公开 CRUD API**（仅
`/api/export/scopes` 导出）——真相在 mongo `mcp_registry.mcp_scopes_default`（`_id` 即
scope 名），auth-server 有缓存（`/internal/reload-scopes` 需内部签名 JWT，实操用容器重启清）。

已执行步骤（复用配方）：

1. 插 scope：`docker exec mcp-mongodb mongosh -u $U -p $P --authenticationDatabase admin
   mcp_registry` → `insertOne({_id:"paas-agent-callers", group_mappings:["paas-agent-callers"],
   server_access:[{agent:"*",actions:["invoke_agent"]}], ui_permissions:{}, is_idp_managed:false,
   updated_at:new Date()})`（凭据取自 registry 容器 env `DOCUMENTDB_USERNAME/PASSWORD`）；
2. `docker restart mcp-gateway-registry-auth-server-1` 清 scope 缓存；
3. 复核：`GET /api/export/scopes`（admin Bearer）应见 paas-agent-callers 且 invoke 规则仅一条。

cell 调用身份=M2M 账户（`POST /api/management/iam/users/m2m`，组 `paas-agent-callers`），
平台侧惰性开通（server/agent-caller-identity.js）。撤销整条授权=删该 scope 文档+重启 auth-server。

### ② 跨 agent 委派 staging 冒烟（add-agent-delegation-a2a，2026-10-02）

runner 断环代码已同步 staging（a2a/config/manager 三文件 + ① 全套）并重启。零 LLM 成本探针
（直打 runner 尾网 100.64.0.11:8793，Authorization=容器 env `AGENT_RUNNER_BACKEND_TOKEN`——
注意 `/opt/agent-runner-stage/.backend-token` 是模板占位，真值在容器 env）：

- `X-Delegation-Depth: 3` → `-32011 delegation depth bound (3) reached`（拒绝先于 spawn）✓
- `X-Delegation-Depth: 2` + 非法方法 → `-32601`（鉴权与深度双过，仅方法不存在）✓

cell 侧全链（发现→创建→远端执行→落会话→卡片徽标）由 e2e `delegation-a2a.spec.js` 覆盖
（2/2）。cell→真 registry→真 runner 的端到端委派随 ② 平台侧部署后由用户演练一回。

### ③ 平台运营 ops 前置（add-agent-platform-ops，2026-10-02 已执行）

- **管理员/API Key**：管理员凭证（用户持有）→ `POST /api/v1/auth/login` 换 JWT →
  `POST /api/v1/admin/settings/admin-api-key/regenerate` 生成 Admin API Key（`x-api-key`
  头鉴权）→ 已入 fd-prod Secret `platform-secrets` 键 `sub2api-admin-key`。找回路径：
  面板登录 admin@finddatatech.cloud → 管理设置重新生成（旧 key 即失效）。密码不落任何仓文件。
- **平台池组**：id=7 `paas-platform-pool`（composite/active）。**上游账号加入组前 key 不得绑组**
  （组内无账号=推理断）——运营加独立上游账号后，部署铸 key 时带 `group_id:7` 完成隔离。
- **充值（day-one）**：0.2.7 无充值码端点（实测 404）→ 手工调额：
  `POST /api/v1/admin/users/:id/balance`（x-api-key + `Idempotency-Key` 头 + body 按面板
  校验形状）；内置支付未配置，接入是运营后置决策。
- **实测在位的管理 API**：`GET/POST /api/v1/admin/users`、`GET /api/v1/admin/users/:id`、
  `GET /api/v1/admin/users/:id/api-keys`、`GET /api/v1/admin/groups`、`POST /api/v1/admin/groups`。

### ③ 并发准入治理（add-llm-retry-resilience，2026-10-04 已执行）

**事故根因（2026-10-04）**：平台全部内部 LLM 流量（cell 聊天 / bot / cron / MP / 并行子代理）
共用部署者账号 `admin@finddatatech.cloud`（user 1）的 key，而 sub2api 用户级并发默认 **5**。
并行委派 + 标题生成即可瞬时限流（`Concurrency limit exceeded for user`），且该文案在 dsh 适配器
按消息正则分类下落入不可重试兜底桶 → 回合死亡。修复为双层（ADR-0016）：客户端有界重试
（`dsh-profile.js` 生成的 retryPolicy，兜底码纳入）+ 本节预算治理。

- **探查配方**（key 不落日志）：
  `kubectl --context cheap -n sub2api port-forward svc/sub2api 18080:8080`，然后以
  `x-api-key: <sub2api-admin-key>`（fd-prod secret `platform-secrets/sub2api-admin-key`）
  `GET /api/v1/admin/users?search=<LLM_API_KEY>`（search 同时匹配 key 值）反查持有者，
  读 `concurrency` / `current_concurrency` / `rpm_limit`。
- **调整配方（已执行）**：`PUT /api/v1/admin/users/1`，body `{"concurrency": 30}` ——
  2026-10-04 从默认 5 调至 **30** 并复测生效（面板同路径：用户管理 → 编辑 → 并发数）。
- **容量账**：用户并发须 ≤ 上游账号池真实并行度。当前池 9 个活跃账号 × 各自并发 10 ≈ 90；
  30 ≈ 池容量 1/3、旧值 6 倍。加账号后可同步上调；反过来调账号池时先看这里。
- **上游语义**（Wei-Shaw/sub2api）：用户级 `concurrency`（本节）与账号级并发是两层
  （后者报 `Concurrency limit exceeded for account`）；key 级并发与弹性配额尚是
  feature request（issues [#5071](https://github.com/Wei-Shaw/sub2api/issues/5071)、
  [#4100](https://github.com/Wei-Shaw/sub2api/issues/4100)）。按租户拆并发域
  （每租户独立 sub2api user/key）推迟到套餐层（ADR-0016 ④）。
- **复测**：调整后跑 `node scripts/probe-llm-retry.mjs`（chaos 探针，无需真实限流配合）。

### ③ 计费链真机冒烟（add-agent-platform-ops，2026-10-02 已执行）

对真 sub2api（port-forward svc/sub2api）以 Admin API Key 跑通 `lib/sub2api-admin.js` 全链：
ensureDeployerUser（probe4 → userId 45）→ mintAgentKey（`POST /api/v1/keys`，keyId 24，
quota $1 + 三窗）→ adjustBalance（`{balance, operation:"add"}` + Idempotency-Key）→ readUser
（balance 1.00）。**实测形状修正两处**：建 key 用户面板路由是 `/api/v1/keys`（非上游文档的
`/api/v1/user/keys`）；余额调整 body 为 UpdateBalanceRequest `{balance, operation}`（amount
不被接受）。探针账户 paas-ops-probe{1..4}@finddatatech.cloud 留存（$0-1 余额，无 key 在用，
可运营侧清理）。runner 侧 key 注入的真回合记账随 ③ 平台部署后演练。

### ③ 计费链闭环 + A2A invoke 门修复（revise-billing-key-acquisition 复测，2026-10-03 深夜）

**结论：粘贴 key 的真实回合全链闭环**——平台（lawbench cell）→ registry 网关（修复后的 invoke 门）
→ staging runner（cheap1）→ 子进程按**部署者自己的 key**（ref `pk_8920c39cf2d899c2a762f1c3` →
aloadtree 的 sub2api key 26）推理 → SSE 回流。sub2api 记账实锤：该 key `quota_used 0.00030125`、
所属用户余额 `$2 → 1.99969875`；runner `meter.jsonl` 同回合 `ok:true`。

复测发现并修复四处（都在「连接流 / 分发链」上，非归档代码的语法问题）：

1. **registry fork（auth-server）**：`IDP_USER_GROUP_FALLBACK` 富化出来的组不会重映射为 scope
   （上游重映射分支只认 pingfederate），个人 minted 凭证永远拿不到 `invoke_agent` → A2A chat
   恒 403「missing invoke scope」。补丁与构建/回滚配方见 `docs/registry-fork-patches/`
   （fork 本地提交 01a25cb；cheap1 已重建 `mcp-auth-server:logto`，回滚 tag `:logto-prev-20261003`）。
   实例化证据：同一 token 修复前 403 / 修复后 200；无组用户 403 不变（不越权）。
   （与「secret 轮换后旧 pod 持旧令牌致 403」是两条独立的 403 根因，排查时先分流。）
2. **平台 caller-group.js**：挂组调用三处形状错——PATCH 打不存在的记录（应为 POST 创建）、
   body `{add:[…]}` 非模型字段（应为 `{groups:[全量合并]}`）、`marketAdminFetch` 未
   `JSON.stringify`（fetch 把对象强转 `"[object Object]"`）；且 username 应取 token `sub`
   声明（auth-server 富化按同一值回查）。已重写 + 7 单测（`scripts/test-caller-group.mjs`）；
   另 `routes/registry.js` 的 URL 兜底 `MARKET_REGISTRY_URL || REGISTRY_URL`（fd-prod
   configmap 只有后者——这是线上挂组静默失败的直接原因，旧日志为
   `[caller-group] assignment error … Failed to parse URL from /api/iam/user-groups`）。
3. **staging runner（cheap1 `agent-runner-dsh`）**：挂载代码里没有 D2 取钥实现
   （manager/compose/config 三文件落后），且缺 `AGENT_RUNNER_PACKS_URL`——子进程一律回落
   runner 级 key 且无任何日志。已同步三文件（旧版备份 `agent-runner.bak-20261003`）、env 补
   `AGENT_RUNNER_PACKS_URL=https://platform.finddatatech.cloud` 并重建容器（重建命令：
   `docker run --name agent-runner-dsh --restart unless-stopped --env-file agent-runner.env
   -v /opt/agent-runner-stage:/app -v .../opt/dsh:/opt/dsh -v .../opt/dsh-home:/opt/dsh-home
   -v agent-runner-data:/data -p 100.64.0.11:8790-8850:8790-8850 -w /app
   public.ecr.aws/docker/library/node:22-slim node agent-runner/index.js`）。另 `applyBillingKey`
   修正为写 provider 实际读的 ref（settings.yaml `apiKeyEnv`，如
   `LLM_PROVIDER_KEY_FINDDATA`；原先只写 `LLM_API_KEY` 是死 ref）。
4. **sub2api 测试 key 的可推理性（运营侧）**：aloadtree 的测试 key 26 绑在 group 1（default，
   无上游账号）→ 推理 `503 No available accounts`；绑 exclusive 组还需 `user_allowed_groups`
   放行（否则 403 `GROUP_NOT_ALLOWED`）。复测处置（SQL）：`api_keys.id=26 → group_id=3` +
   `user_allowed_groups (2,3)`，实测 `/v1/chat/completions` 200。**公开多租户前必须补的运营件**：
   group 7 `paas-platform-pool` 加独立上游账号；且部署期活性探针只打 `/v1/models`，测不到
   「组内无账号 / 组未放行」这类不可推理态——建议活性探针加一记最小 chat 往返，或把上游
   code 透出到部署 UI（现状：403/503 的 code 只在运行期暴露）。

**回归**：`npm run test:unit` 712/712（含新增 billing 两测 + caller-group 七测）。

**遗留**：①平台侧本轮修复尚未部署（需新镜像 + GitOps；configmap 的 `MARKET_REGISTRY_URL`
可有可无——代码已兜底 `REGISTRY_URL`）；②registry fork 补丁未推 gitee/上游（上游 issue 候选，
见 `docs/registry-fork-patches/README.md`）；③chat 会话在 cell 运行时重启后会丢「Agent 绑定」
（strip 变回 FD local，回合静默走本地执行）——复测时应重选 Agent 或先核对 strip 徽标。

### 部署密钥（deployment secrets）— add-deployment-secrets

为被部署 agent 注入任意命名密钥（如内容仓 git PAT）的通道：录入在部署请求里，
值只在平台侧存一次，描述符只带不透明引用 `ws_<24hex>`，子进程经认证的内部路由
按引用取值并 pin 进自己的凭据文件。与 billing key 同一信任模型、同一通道形状。

**1. 录入形状**（`POST /api/packs/:id/versions/:v/deploy` 请求体）：

```json
{
  "billingKeys": { "<agentId>": "sk-…" },
  "secrets": {
    "<agentId>": {
      "repo_token": "<value>",
      "old_name": null
    }
  }
}
```

- 名称 `[a-z0-9_]{1,32}`（小写标识符——YAML 安全，且与凭据文件里大写的 provider ref
  天然不同命名空间）；**每 agent 结果集 ≤4 条**（按合并后的绑定集计，非按请求计）；
  值非空字符串且 ≤8KB；目标 agent 必须是该 pack 的 serving agent。
- 违规即整单拒绝，`400` + `code:"SECRET_INVALID"` + `reason`
  （`name` / `shape` / `size` / `count` / `unknown-agent`）；拒绝时不落任何行。
- 密钥通道与 billing 判据无关：billing 未接（或未绑定）也照常生效。

**2. 生命周期**（对齐 billing key 三态）：

- 重部署**省略** `secrets` → 既有绑定保留，**同一引用**随新描述符下发；
- 显式 **`null`** 逐名解绑（服务面即消失，runner 下次组合不再 pin 该名）；
- **重粘贴=轮换**：同名新值铸新引用，旧引用立刻失效；
- agent **停服**（serving 契约移除）时随该次重部署清退其全部绑定；
- 没有 liveness 概念（任意凭据无从探活）——存在即用，停用靠解绑/轮换。

**3. 存储 · 通道 · 注入**：

- 表 `deployment_secrets(pack_id, agent_id, name, secret_ref, secret_value, deployer,
  created_at)`，与 `deployment_keys` **同库同信任面**（明文静态存储，不加密——与 billing
  key 现状一致，加密升级统一后置）。
- 描述符字段 `secret_refs: { "<name>": "ws_…" }`——registry 条目 / 市场 / 卡片**零值**。
- runner 逐 secret 调 `GET /api/packs/internal/secret/:ref`（registry 服务凭据 Bearer，
  与 llm-key 路由同门）；**逐次审计**（ref 掩码 + agent + name，无值）。
- 组合时先取全量值、再一次性写入 child 私有 `.credentials.yaml` 的 `refs`（环境已被洗刷，
  凭据文件是唯一到达 child 的通道）；**任一失败=该 agent 组合失败**（错误带缺失的
  name/ref，无部分集、无兜底值）。

**4. 脱敏与可见面**：

- 日志/审计/部署面统一 `ws_xxxx…last4`（引用头 + 值尾四位）；**API 永不回值**；
- 绑定可见（`GET /api/packs/:id/secret-bindings` → 每 serving agent 的**名称列表**），
  引用/掩码/值均不出该路由；部署响应 `deployed[].secretRefs` 为掩码面。

**5. 最小权限示例**（GitHub fine-grained PAT）：仅勾
`Contents: Read and write` + `Pull requests: Read and write`，**不勾** Administration；
scopes 选目标仓。child 内密钥对其全部工具可见（无 per-secret 作用域语义），
权限收敛靠凭据本身的最小授权（签发侧解决），不要粘贴经典 PAT（classic 无法细粒度）。

**6. staging 全链探针**（前端平台 + registry + staging runner，含负例）：

```bash
# 需要：creators 组的平台 Bearer（小程序 token）、该账号的 sub2api key（平台接了 billing 时）、
# registry 管理员 JWT、runner 凭据。runner 宿主机上跑（或给 PROBE_READ_CMD 读容器内文件）。
PLATFORM_URL=https://platform.finddatatech.cloud \
PROBE_TOKEN=<platform Bearer> PROBE_BILLING_KEY=<sk-…> \
REGISTRY_URL=https://mcp.finddatatech.cloud \
REGISTRY_TOKEN=<admin JWT> \
RUNNER_BASE=http://100.64.0.11:8790 BACKEND_TOKEN=<runner credential> \
RUNNER_HOME=/data \
PROBE_READ_CMD='ssh cheap1 docker exec agent-runner-dsh cat {path}' \
node scripts/probe-deployment-secrets.mjs
```

探针发布私有 pack → 部署带假 secret → 断言部署面掩码/公开面零值/registry 描述符仅引用 →
触发组合并读 child home 凭据文件断言键值在位 → 再用一个 store 无法解析的引用重部署，
断言组合失败文案带缺失名 → 清理 registry 条目并下架 pack。**旧平台**（未含本变更）上探针
会在部署面检查处明确报「platform does not run add-deployment-secrets yet」。

## Push-time lint gate (release-line-hygiene)

`release/cell-session-persona` 是多人共用的发布分支。推送前有一个钩子只检查**本次推送改动的文件**：

```bash
npx biome check --write <改动的文件>   # 先自动修一版，再人工收尾
git push                               # 通过即静默；红则指名文件与修法

SKIP_LINT_HOOK=1 git push              # 紧急逃生（CI 仍会红）
```

出片前仍应跑一次 `npm run lint`（全仓）：那个是全量的最终判据，钩子只挡"本次引入"。

## 出片车间的 CI 是排队的

镜像仓同一 ref 上的 CI **串行排队**，不会互相取消（单测真跑 ~26 分钟，多人并行出片时"后推顶前推"会让先开始的永远跑不完）。所以连推两次快照时，第二次会 `queued` 等第一次结束——这是预期，不是卡住。
