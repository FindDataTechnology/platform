# Design: add-mp-demo-sandbox

## Context

fd-prod runs the single-process shape (512Mi pod pinned to cheap-3, 3.9GiB,
shared with Jenkins) — the gateway/cell demo mode (`add-mp-demo-mode`) cannot
run there, and the second review rejection shows the reviewer needs REAL chat,
not a browsable shell. The cluster has five ~8GiB nodes with ~4GiB free each;
the client already has a persisted-base-URL mechanism; the entry node (cheap-1,
a cluster node) runs Safeline→Caddy with per-hostname blocks; sub2api (the LLM
gateway) is reachable in-cluster as a ClusterIP service.

## Goals / Non-Goals

**Goals:** reviewer chats for real with zero popups; fd-prod untouched;
bounded anonymous exposure (per-connection prompt cap, no uploads, periodic
wipes, ephemeral volume); one small pod, no new infra.

**Non-Goals:** accounts or quotas per person (the sandbox is deliberately
accountless); gateway/cell mode (separate capability); curating demo content.

## Decisions

### D1 — One dedicated sandbox pod instead of in-process sandboxing of fd-prod

Sandboxing INSIDE the fd-prod process would require per-connection filtering
of every broadcast/event (the single process shares sessions, documents and
events across all sockets) — a re-implementation of multi-tenancy. A separate
accountless pod with empty emptyDir data gets isolation for free at the cost
of one replica. Anti-affinity with the platform pod keeps it off cheap-3.

### D2 — Reuse the demo budget, per connection, for everyone

`createDemoBudget` (from add-mp-demo-mode) gains an `everyone` mode: the
budget applies to every identity. In sandbox mode each WS connection gets its
own budget instance (per-CONNECTION, not per-process — a shared counter would
let the first visitor exhaust the pod for everyone). Reconnect = fresh budget;
bounded by the free-tier model. The gateway per-cell budget is unchanged.

### D3 — Uploads blocked, sessions wiped; both small and boring

Upload guard: one flag check at the POST route (403 + friendly text) — the cap
can't bound disk from uploads, so uploads simply don't exist in the sandbox.
Wipe: a dependency-injected step (`server/sandbox.js`) — skip while streaming,
`startNewSession()`, delete every other session — on an interval (default 2h).
The volume is emptyDir, so pod recreation is a full reset regardless.

### D4 — Client switch via the existing base-URL mechanism + runtime re-boot

The client persists its base URL (storage key `platform.baseUrl`). Entering
the demo stores the previous origin (`platform.preDemoBase`), switches to the
demo origin, clears the (irrelevant) platform token, and re-boots the runtime
through a new `runtime.switchBase()` (final-close the one WsClient, reset boot
state, `boot()` — the existing single-flight invariants hold). Exiting
restores the saved origin the same way. Demo detection = origin comparison
(the login-email heuristic stays for gateway deployments). The login page is
never reachable from the demo origin; the demo notice's exit restores the
production origin first.

### D5 — Routing and go-live

Caddy on cheap-1 gains `http://demo.finddatatech.cloud:8080 → 127.0.0.1:31871`
(NodePort on the local node) — inert until the pod exists. Safeline (the TLS
terminator) needs the site + cert added in its console; DNS needs an A record
to the entry IP; WeChat's console needs the origin in request+socket legal
domains. The GitOps manifest ships `replicas: 0` with the current image tag —
go-live is: build the image (Jenkins), bump BOTH deployments' tags + demo
replicas to 1 in one commit, ArgoCD syncs.

## Risks / Trade-offs

- [Anyone with the demo origin gets free LLM chat] → per-connection cap,
  uploads blocked, free-tier model, periodic wipes; the origin is only
  advertised inside the mini program. Accepted residual exposure.
- [Demo pod cold start makes the first reviewer wait] → same wait as any
  fresh cell (~dsh boot); the client's initializing state covers it. Optional
  follow-up: keep the pod always-on (it is — no idle reaping for pods).
- [Two deployments to keep in sync] → same image tag for both, one GitOps
  commit; the sandbox flag is the only env difference of substance.
- [Safeline/DNS/whitelist are manual console steps] → go-live checklist; the
  Caddy block is inert until then, and the pod stays at replicas: 0.

## Migration Plan

Everything ships dark: server flag default-off, client feature present but the
demo origin unreachable (whitelist), Caddy block inert, GitOps replicas: 0.
Go-live (operator checklist): DNS → Safeline site+cert → WeChat whitelist →
Jenkins build → one GitOps commit (both tags + replicas) → submit the new
client version. Rollback: replicas back to 0 (or remove the Caddy block);
nothing else holds state.

## Open Questions

- Whether the demo ConfigMap should set `ASSISTANT_NAME` differently (e.g.
  "FD 演示") — cosmetic, decided at go-live.
