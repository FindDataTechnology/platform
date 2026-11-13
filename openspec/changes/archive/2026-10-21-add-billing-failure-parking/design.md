## Context

The turn pipeline is one discipline for every source (`manager.turn`: messages, rhythm self-turns, digests); failures meter an error line and rethrow, and the A2A adapter propagates `e.code ?? -32003` with `e.message` verbatim for both `message/send` and streams. The LLM-failure code `-32003` is settled by the dsh adapter (`harness/dsh.js` finish-error frames); its message comes from dsh's own client, which drops the gateway's JSON body — production shows the string `403 status code (no body)`. Two precedents shape this design: pause (`pausedKeys`, agent-residency D5 — registry-marked, skips scheduler/rollover, inbound `-32010`) and the budget kill (`-32001` + `budgetKilled` marker + `budget_killed` fleet event + hard stop). The rollover check runs on a fixed 60 s timer and deliberately leaves its day-marker stale on failure so the next check retries — correct for transient failures, a storm for a dead key (2874 retries / 48 h, 2026-10-21). Each deployment's key is pinned at compose time (`applyBillingKey` — billing ref fetched over the pack gateway's internal route, runner-level key as fallback); the routing store (`LLM_PROVIDERS_STORE`) names the provider's `baseUrl` and type. The gateway's model-list endpoint (`GET {baseUrl}/models`) is documented to build its list locally — no upstream spend — while running the full billing gate (`lib/sub2api-admin.js` probe notes); `INSUFFICIENT_BALANCE` / `INVALID_API_KEY` / 200 are distinguishable from its JSON.

## Goals / Non-Goals

**Goals:**

- A billing-rejected role stops burning turns within one failed turn, and tells callers why in words a deployer can act on.
- Automatic recovery with no operator action when the key becomes valid again.
- Zero behavior change for every failure mode that is not a billing-gate rejection.

**Non-Goals:**

- Rendering park state in the 萬星 console or embed widget (fd-wanxing follow-up; the `-32011` message is already human-readable).
- Changing dsh's error reporting (below the adapter boundary).
- Parking on upstream flakes, model-unavailability empty turns (`-32005`), or child exits (`-32002`) — those keep today's retry behavior.
- Auto-recharge, alerts, or any registry-entry marking.

## Decisions

**D1 — Classify by probing the billing gate, not by parsing the harness message.** On a `-32003` turn failure the manager probes `GET {baseUrl}/models` with the role's pinned key (10 s timeout, one in-flight guard per key, 60 s floor between probes of the same key). Mapping: HTTP 401 or 403 with `code: INVALID_API_KEY` → park `key-invalid`; 403 with `INSUFFICIENT_BALANCE` → park `insufficient-balance`; 200, transport error, or any other status → no park. Only providers of type `openai-completions` are probed; other types never park. *Alternatives rejected:* grepping the turn error text (`403`, `INSUFFICIENT`) — the message is harness-owned, already lossy today, and unstable across dsh versions; counting consecutive `-32003`s — cannot tell a dead key from a down upstream, which is exactly the confusion this change exists to remove. The probe's negative prediction is authoritative: a gate rejection fails every subsequent turn, so parking on it is safe; a probe pass never parks, so a false positive is structurally impossible — the worst case is a false negative, which is today's behavior.

**D2 — Park is a process-local map, distinct from deployer pause, cleared by re-pin.** `parked: Map<key, {reason, detail, since}>` checked at the same three seams `pausedKeys` already gates (scheduler tick, rollover check, `turn()` entry) — pause wins precedence when both hold. Inbound turns while parked throw `-32012` with `agent parked: <reason> (<detail>) since <time>`; `a2a.js` propagates code and message verbatim already, so the adapter needs no change. (Apply-time correction: the drafted `-32011` is already the a2a delegation depth bound — `a2a.js` POST entry, archived add-agent-delegation-a2a D4 — so the parked error takes `-32012`, the next free runner code; a structured error must be distinguishable by code alone.) The map is deliberately not persisted: the restart bound is one failed turn per role (spec scenario), and a persisted marker could outlive a recharge and wedge a healthy role — the park re-derives from the same evidence that created it. *Alternative rejected:* reusing `pausedKeys` with a reason side-table — pause is deployer-intent with registry semantics and a documented resume path; overloading it would make an automatic state visible as a manual one.

**D3 — The probe uses the compose-time pinned key, refreshed on every re-pin.** The manager records `{keyValue, baseUrl, providerType}` per role at `applyBillingKey` time (and the runner-level store key when no billing ref exists — the same fallback the child runs on). A descriptor change re-materializes the role and re-pins, refreshing the record and clearing the park. *Alternative rejected:* reading `.credentials.yaml` from the home on the failure path — a file parse on a hot path for data the manager already held; the record's lifetime is exactly the pin's lifetime.

**D4 — Re-probe on a slow timer; fleet events on both edges.** One timer in `index.js` (default 600 s, `AGENT_RUNNER_BILLING_REPROBE_SECS`) probes only parked roles; a pass unparks. `billing_parked` / `billing_unparked` events ride the existing fleet event bus with `{reason, detail, since}` — the same consumption path as `budget_killed`. Health rows gain a `parked: {reason, since}` annotation when set; the five-state lifecycle vocabulary is untouched.

**D5 — An env kill-switch ships with the feature.** `AGENT_RUNNER_BILLING_PARK` (default `on`); `off` disables probing and parking entirely — minutes-level rollback without an image roll. The line-board postmortem's standing lesson: a rollout lever must exist before it is needed. *Alternative rejected:* image-level rollback only — the serving image carries unrelated changes by then.

## Risks / Trade-offs

- [Probe pass ≠ next turn succeeds] (upstream down while the gate is open) → harmless: pass never parks, and the parked→unparked transition only happens on a pass, so an unparked role can still fail turns — that is today's behavior, not a regression.
- [Runner restart re-burns one turn per parked role] → bounded and spec'd; acceptable at the observed failure cost (one 403).
- [New error code reaches callers] → `grep` shows no consumer switches on `-32003`; the facade relays code+message verbatim and surfaces the message. The parked code is `-32012` (`-32011` was already the delegation depth bound — caught at apply time). Noted in the change log for the sister change's widget states.
- [Provider-type drift] (store gains a non-openai provider serving deployments) → D1's type gate makes it fail open (never park); extending coverage is a follow-up, not a correctness hole.
- [Probe load] → one request per failed turn at most, floored at 60 s per key, plus one per parked role per 10 minutes — negligible against the ~1 turn/minute the storm used to generate.

## Migration Plan

1. Ship in a serving image release; defaults are on. No schema, secret, registry, or facade change.
2. Rollback lever: `AGENT_RUNNER_BILLING_PARK=off` + pod restart (minutes); image rollback also clean — park state is process-local and nothing is persisted.
3. Post-roll verification: drain one test deployment's sub2api key to zero and watch one failed turn → `billing_parked` → inbound `-32011` → recharge → `billing_unparked` within one cadence (the acceptance anchor in the proposal).
