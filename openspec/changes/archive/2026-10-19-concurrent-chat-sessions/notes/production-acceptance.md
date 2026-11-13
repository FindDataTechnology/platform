# Production acceptance — sha-63ce2a2 / digest 4c1fbc08

Date: 2026-10-19. Deployment: cheap cluster, `fd-prod/platform` (gateway + cells share the image).

## Provenance chain

| Step | Value |
|---|---|
| paas commit | `36e0477` (gitee `main`) |
| snapshot commit | `63ce2a2` (testaction002/build-pool) |
| image tag | `ccr.ccs.tencentyun.com/yizuo/platform:sha-63ce2a2` |
| ccr digest (skopeo) | `sha256:4c1fbc0837704ff6d0c34824859ba0178355136da576a9b8a237ee8b0d3ad5b7` |
| pod imageID | `ccr.ccs.tencentyun.com/yizuo/platform@sha256:4c1fbc08…ad5b7` — **matches** |
| GitOps | `fd-infra-deploy` `dd776df` (`all-services/prod/platform.yaml`) |

Build run `39278782996`, relay log `OK yizuo/platform:sha-63ce2a2 (3s)`.

## Module liveness

`/app/server/turn-dispatch.js` md5 `decea0bf69baa829c807b9bad0539b88` — identical locally
and inside the running pod. `runtime-bindings.js` contains the forwarded-args fix
(`originalFinishTurn?.(outcome, sid)`, 1 occurrence).

## End-to-end (real image, real dsh, real LLM route)

A throwaway cell was booted **inside the production pod** from `/app/server.js` on a temp
data dir (no real user's cell touched), then driven over its own port with the
`x-cloud-gateway-secret` identity headers.

Result (`queue` policy, the default):

```
A streaming ✓
switched to B while A streams ✓        <- the headline behavior
B queued ✓  { position: 1, waitingOn: <A's session> }
A finished naturally ✓                 <- NOT cancelled by the navigation
B dequeued ✓ dispatched
B started ✓
B finished ✓
errors: []
event types seen: user, agent_start, queued, dequeued, text, done, session_loaded, …
```

The queue announcement named **A's** session as `waitingOn`, then `dequeued{dispatched}`
preceded B's `agent_start` — the exact contract in `turn-dispatch/spec.md`.

## Rollback drill

Same cell booted with `TURN_DISPATCH=legacy`: switching away from a streaming session
finished A's turn **immediately** (`done` within the same tick, latency 0 ms) — the
pre-change behavior is restored by env alone, no redeploy.

## What this does NOT cover

- **Multi-user / multi-tab over the public gateway**: the gateway admits only Logto
  cookies or mini-program Bearer tokens, so the drill used the cell's internal identity
  channel. The cross-connection case is covered by e2e (`turn-queue.spec.js` third
  connection shapes) and by the unit-level navigation repro, not by a browser session.
- **A real user's cell after this rollout**: existing cells were terminated by the pod
  restart (they are gateway children); the next visit spawns one on the new image.
  Verified the gateway is healthy and serving (`/healthz` ok, cells spawn lazily).
- **cron turn queuing in production**: exercised in unit tests (reservation +
  collector-close drain), not in a live scheduled task.
