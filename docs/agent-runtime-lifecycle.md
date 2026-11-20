# Agent runtime lifecycle — restart, delivery, and how to read the log

One page for the machinery that decides **when the shared dsh child restarts** and **whether
what you wrote actually reached it**. Every failure mode below was measured, not theorised:
2026-11-13/14 the fast e2e lane lost 5–9 tests per run to these, and each one looked like a
different bug from the outside.

The rule that ties the sections together: **a restart that returns is not a delivery, and a
cell that is "busy" must be able to name who holds it.**

## The moving parts

| Piece | Where | What it decides |
|---|---|---|
| `dsh-bridge.restart()` | `dsh-bridge.js` | shutdown → spawn → initialize. Holds `#restarting` for the WHOLE thing; a second caller gets `dsh restart already in progress (running Ns)` |
| deferred delivery | `server/dsh-mcp-delivery.js` | MCP patch / credential rewrites: restart now, or defer to the turn boundary (never kill a live turn) |
| catalog-preset delivery | `server/agent-session.js::flushCatalogPresetRestart` | roster rewritten on disk → a restart must carry it; parked as `catalogPresetRestartPending` when the runtime is busy |
| retry policy | `lib/catalog-restart-retry.js` | how often a parked rewrite may look again (pure policy, unit-tested) |
| busy definition | `server/turn-dispatch.js::runtimeBusy` | reservations ∪ collectors ∪ task-turn registry ∪ web streaming ∪ worker slots |

`ctx.describeRuntimeBusy()` prints those five sources **with names** — that is the function
that turned a 90-second mystery into a one-line answer.

## Knobs (all optional; defaults are the measured-sane values)

| Env | Default | Meaning |
|---|---|---|
| `DSH_SPAWN_BUDGET_MS` | `45000` | Wall budget for a whole spawn. Past it the child is **closed** and the attempt reported as a failure, so `#restarting` cannot be held for minutes |
| `DSH_INIT_TIMEOUT_MS` | `30000` | Per-attempt bound on the initialize handshake. ~5× the measured steady-state spawn (1.2–6.0 s); a cold e2e boot with nine patch files needs more than 10 s |
| `DSH_INIT_RETRIES` | `20` | Retries of the *only* retryable initialize race (`no adapter registered for provider`), 500 ms apart |
| `DSH_REQUEST_TIMEOUT_MS` | `60000` | Per JSON-RPC request |
| `BRIDGE_RESTART_WAIT_MS` | `30000` | How long a roster read waits for an in-flight restart before answering honestly empty |
| `BRIDGE_RESTART_POLL_MS` | `100` | Poll interval for that wait |
| `CATALOG_RESTART_RETRY_MS` | `5000` | Cadence of the parked-rewrite look (tests override it) |
| `CATALOG_RESTART_MAX_ATTEMPTS` | `3` | Budget for **failed** restarts |
| `CATALOG_RESTART_MAX_LOOKS` | `120` | Budget for **declines** ("busy", "bridge not ready") — a separate, much larger allowance (10 min) |

## Three invariants worth defending in review

1. **Delivery is judged by the child, not by the call.** After a restart, read the child's own
   roster (`presets/list`) and compare against what was written
   (`dshProfile.catalogPresetDefinitions()`). A restart onto a stale patch file returns
   successfully and delivers nothing.
2. **A decline is not a failure.** "busy" / "bridge not ready" means nothing was attempted; it
   must draw on its own allowance. Charging declines to the failure budget is what lost a
   roster for good: three looks inside one long turn exhausted the budget, and that same turn
   guaranteed no idle transition would come. Measured cost: five tests per run.
3. **A restart in flight is "down and coming back", not "never booted".** `isReady()` is false
   for the whole restart; answering from that window is what produced
   `No agent modes are available in this deployment` on a deployment that had every mode.
   Use `isRestarting()` to tell the two apart, and bound the wait.

## Log lines → what to conclude

| Line | Verdict |
|---|---|
| `[dsh-bridge] spawn generation=N … budget=Xms` | a spawn started (the number is this generation's wall clock base) |
| `[dsh-bridge] ready generation=N in Xms` | healthy spawn; if `Xms` creeps past ~15 s the budget or the adapter ladder needs a look |
| `[dsh-bridge] spawn ABANDONED after Nms (budget …)` | **our** timeout, not a collision. The child was closed so the next restart can run |
| `[dsh] restart already in progress (running Ns)` | two callers; a large `N` means the owner is wedged — look for the line above it |
| `[dsh] catalog preset restart deferred (busy): reservations=[…] collectors=[…] taskTurns=[…] streaming=[…] workers=N` | **who** holds the child. Empty lists + `streaming=[sid]` = a web turn; `collectors`/`taskTurns` with the same sid = a delegating turn |
| `[dsh] switch waited for an in-flight restart (attempt N)` | a user action deferred behind a background restart instead of failing it |
| `[dsh] runtime restarted for N catalog agent preset(s)` | the rewrite was delivered *and* the child listed it |
| `[dsh] catalog preset roster still undelivered after …` | bounded give-up; the reason distinguishes `failed restarts` from `looks (busy)` |
| `[mcp-delivery] … deferred until the turn boundary` / `restarted with the fresh patch` / `restart collided (…) — retrying` | the MCP/credential lane's three branches; the collision message carries the underlying error |

## Triage: "the agent I just installed is not in the picker"

1. **Is it in the catalog at all?** `grep 'catalog agent presets:'` — the ids are printed on
   every sync. Absent here ⇒ the pack/agent never became catalog-derived; stop looking at the
   restart machinery.
2. **Was the overlay written?** `wrote preset overlay (… N preset row(s))` — `N` counts the
   shipped `standard` row plus the derived ones.
3. **Did a spawn happen after that write?** `spawn generation=` with a higher number.
   No spawn ⇒ look for `deferred (busy)` and read the named holder.
4. **Did the child list it?** Ask the roster, not the restart.
5. **Still nothing after a restart?** The child composed from a patch file that the writer had
   not landed yet (same-path rewrite) — that is the stale-roster case, and the delivery check in
   step 3 of the previous section is what catches it.

## Traps that cost whole runs

- **A phantom "busy" is usually a leaked registration, not a live turn.** A delegation turn
  whose `prompt()` failed used to leave its collector in `sessionCollectors` +
  `taskTurnRegistry` for the full 10-minute turn timeout; both feed `runtimeBusy()`, so every
  deferred restart in the cell was blocked and four unrelated preset tests went red. The fix is
  the same three lines `cron-runner`'s own catch already had (`settle` / delete / `onRuntimeIdle`).
  Any new lane that registers a turn must release it on **every** exit path.
- **A dropped option is invisible.** `lib/dsh-client-launch.js` destructured a fixed set of keys,
  so `initializeTimeoutMs` was accepted by the caller and silently discarded; the client fell back
  to the 60 s request timeout and a wedged handshake outlived the 45 s spawn budget (a plain
  timeout is not the retryable adapter race). When a bound "does not take", check the shim.
- **Don't weaken a test to fit one host.** `e2e/voice.spec.js` asserts playback ends; this
  machine's headless Chromium has no advancing audio clock (`duration=0.40`, `play()` resolves,
  `currentTime` stays 0.00), so the assertion observes the host. It is documented at the line and
  left intact — on a lane with a real sink it is meaningful.

## Turn claims — "this attempt exists", and beating

The claim lane answers a question the ledger could not: **did this attempt happen at all?**
`member_turn_events` is written at the END of a turn, so a pod roll mid-turn used to leave
nothing on disk — the run header stayed open with 0 turns, and the orphan sweep later
guessed `failed` for something that was really "stopped from outside, re-runnable".

`lib/turn-claim.js` (rules, pure) + `lib/turn-claim-store.js` (the `turn_claims` table).

- **One write point.** `server/fleet-runs.js::begin()` writes the claim. All three execution
  paths (cron serial, worker pool, delegation ruling) reach `begin`, so no lane can forget.
  The claim is written **before** the run broadcasts and before any lane can prompt.
- **A claim that cannot be written fails the turn** (`TURN_CLAIM_FAILED`), and the in-memory
  handle is unregistered so nothing else picks it up. Executing without a claim is
  indistinguishable, afterwards, from never having run.
- **Liveness is a heartbeat, not an inference.** `heartbeat_at` is renewed by the ledger (one
  tick in `server.js`, coalesced to one persist per half-heartbeat). A lapsed lease is closed
  by the sweeper as **`lease_expired`** — a sweep is the only place expiry becomes a fact.
- **The terminal set is closed**: `ok | failed | interrupted | cancelled | lease_expired`.
  `interrupted` / `lease_expired` / `cancelled` are **not failures** — they must never sit in a
  failure-rate denominator. `end()` derives the reason from the ROW's status (`skipped` closes
  nothing), so the claim and the ledger can never disagree.
- **Claim and measurement are separate tables, by force.** The export contract is an
  AUTOINCREMENT-id increment (`export_platform.mjs --after-id`): an UPDATE to an exported row is
  never re-sent, and re-sending the row is refused as a rewrite. So mutable fields live on the
  claim; `member_turn_events` stays append-only.

Read-face states (`deriveClaimState`): `running`, `stalled`, `lease_passed`, `closed_ok`,
`closed_failed`, `closed_cancelled`, `dead`, `never_dispatched`, `undetermined`,
`pre_contract`, `indeterminate`. Every board/console/task-query reads this ONE derivation —
`stalled`/`lease_passed` are open AND unhealthy at once, and an absent claim with no evidence is
`undetermined`, never the comfortable `never_dispatched`.

### Knobs

| Env | Default | Meaning |
|---|---|---|
| `TURN_CLAIM_HEARTBEAT_MS` | `30000` | Beat interval; persists at most once per half-interval |
| `TURN_CLAIM_LEASE_MS` | `3 × heartbeat` | Past it with no beat ⇒ the sweeper closes `lease_expired` |
| `TURN_CLAIM_STALL_MS` | `2 × heartbeat` | Board says "stalled" before the sweeper acts |
| `TURN_CLAIM_CONTRACT_EPOCH` | unset | Start of the contract; attempts before it derive `pre_contract` |

### Triage

| Symptom | Conclude |
|---|---|
| Board says `lease_passed`, sweeper has not closed it | sweep tick has not run (hourly); the claim is telling the truth |
| A run is `interrupted` with 0 turns | the turn died before writing a row — the claim (if any) names who held it and when the last beat was |
| `undetermined` on an attempt the engine says started | a claim writer fault — check `TURN_CLAIM_FAILED` in the log |
| `pre_contract` spread over recent days | `TURN_CLAIM_CONTRACT_EPOCH` was never set after deploy |

## Runtime revisions — versions whose identity is their content

A revision is a version of a deployment's running **configuration**. Its id IS its
fingerprint (`lib/runtime-fingerprint.js`), so "roll back to v3" is a lookup, not a guess:
either the content reproduces or the rollback is refused.

Rules (`lib/runtime-revision.js`, pure; storage in `lib/revision-store.js`):

- **Identity is content.** Two paths to the same fingerprint are ONE revision
  (trial-then-promote vs straight deploy do not create two "versions").
- **A trial is evidence about a fingerprint.** `runTrial` stamps the fingerprint of what it
  actually provisioned; a report about a different build is refused at attach time, not
  stored as if it were about this one.
- **Promotion needs a green trial under the same fingerprint** — or an audited human
  override that carries **who** and **why**. A reason without a name is not an audit trail.
- **Rollback is a pointer move that must reproduce.** The route re-materializes the target
  and hashes it; a mismatch is `diverged` and a refusal to re-derive is `cannot-reproduce`.
  An approximation of the old version is worse than an honest refusal, because it looks fixed.
- **One active revision per deployment**, set inside the same transaction that writes the
  audit row. "v3" of two different packs are unrelated — the deployment key is part of it.

Routes (`server/routes/revisions.js`), owner-gated like the rest of the fleet surface:

| Route | Verb | Refusals you should expect |
|---|---|---|
| `/api/revisions/:deployment` | GET | — (a never-promoted deployment answers `active: null`) |
| `/api/revisions/:deployment` | POST | `FINGERPRINT_REQUIRED`, `trial-fingerprint-mismatch` |
| `/api/revisions/:deployment/promote` | POST | `no-trial`, `trial-not-green`, `override-needs-reason`, `already-active` (no-op) |
| `/api/revisions/:deployment/rollback` | POST | `diverged`, `cannot-reproduce` |

Triage: a rollback refused as `diverged` means a dependency moved under the label — fix the
label (new revision) rather than forcing the pointer. A promotion refused as `no-trial` is
the gate doing its job; if you must go around it, the override is recorded and visible.

Worked example (version chain):

```
  edit one skill → new bundle_fp → revise candidate → trial (green, same fp)
      → promote (pointer moves, audit row) → rollback (reproduces → allowed)
```
