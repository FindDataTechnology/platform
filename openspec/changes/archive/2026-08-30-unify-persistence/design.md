## Context

Post-split, each store module owns its write path. Current inventory: SQLite (db.js, WAL + versioned migrations — the mature path), three JSON file stores (llm-providers.json, cron-store/jobs.json, sessions-store/workdirs.json) each with load-cache→mutate→full-rewrite cycles, four YAML write sites in dsh-profile.js (settings/credentials/patches — format-locked to dsh's hot-reload watcher), plus read-only catalog JSONs and skill SKILL.md materialization. Concurrency today: llm-providers mutations hold an in-process lock (in server route code, 409 on contention); MCP patch writes are single-flight chained; chat deletes per-id promise locks; **cron and workdir writes are unlocked** — and every temp+rename uses a FIXED `.tmp` sibling name, so any two concurrent saves on one file race on the temp path itself.

## Goals / Non-Goals

**Goals:**
- One implementation of atomic-write / read-fallback; every existing call site migrated; byte-identical file contents.
- No store file can be corrupted by concurrent in-process writes (unique temp names + per-store serialization).
- Crash-durability parity: fsync before rename for all stores (SQLite already durable).
- Unit tests for the persistence module itself (concurrency + fallback semantics).

**Non-Goals:**
- NO schema/format/path changes to any existing file; NO moving JSON stores into SQLite (deferred deliberately — jobs.json is `[]` today making a future import trivial); no cross-process locking (single-process server assumption documented; supervisor spawns one server); no changes to dsh-profile's merge-preserve semantics, 0600 chmod, or ref-pruning.

## Decisions

**D1 — `lib/persistence.js` is dependency-free (node:fs, node:crypto only) with sync and async variants of the same code path.** Existing call sites are mixed sync (llm-providers, dsh-profile) and async (cron, workdir). Provide `atomicWriteJsonSync/atomicWriteTextSync` and async `atomicWriteJson/atomicWriteText` sharing a `_writeViaTemp` core; call sites keep their current sync/async character (changing sync→async would ripple into dsh-profile's call graph for zero benefit in this change). Alternative rejected: async-only + refactor callers — larger diff, mixes mechanical move with semantic change.

**D2 — Unique temp names + fsync, per `write-file-atomic` semantics, hand-rolled.** `${basename}.${pid}.${randomUUID().slice(0,8)}.tmp` in the same directory (rename must be same-filesystem). Sequence: open/write → `fs.fsync(fd)` → close → rename → best-effort `fs.opendirSync(dir)` + `fsync` (ignore errors on platforms that reject dir-fsync). No new npm dependency: the behavior is ~30 lines and adding `write-file-atomic` would drag its own queue semantics (it serializes per-file globally — see D3) into every store. Alternative considered: adopt `write-file-atomic` — rejected to keep the zero-dep module and exact control; revisit if requirements grow (e.g. mtime preservation).

**D3 — Per-store write serialization via a tiny `createFileStore(path, {load, save})` wrapper (promise-chain, not mutex library).** Same pattern as the existing `mcpChain` single-flight in server code (proven in this repo): `this._queue = this._queue.then(work, work)`. The wrapper exposes `async mutate(fn)` — load state (cached), apply fn, serialize save — so cron's add/remove/pause/resume become `store.mutate(...)` one-liners and the race disappears. llm-providers adopts it too, replacing `withLlmWriteLock` in route code (the 409-on-contention behavior is dropped — mutations queue instead of rejecting; the 409 was an artifact of protecting a full-file rewrite, not a product requirement; e2e `llm-models.spec.js` does not test concurrent-edit rejection — verify during implementation, and if a test asserts 409, keep a nonblocking `tryMutate` variant that rejects on busy). Alternative rejected: async-mutex dependency — overkill for a single-process chain.

**D4 — `readJsonOr(path, fallback)` single policy: ENOENT → fallback silently; EACCES/other stat errors → warn + fallback; JSON.parse failure → warn (path + error) + fallback. Never throws.** Matches the most defensible current behavior (llm-providers') and upgrades the silent-catch sites (workdir-store, migrate helper). Catalog/market readers keep their degrade-to-default logs but via the shared helper with a `label` option for the log prefix.

**D5 — dsh-profile.js keeps its YAML merge logic; only the final 4 write calls swap to `atomicWriteTextSync`.** The watcher-tripping avoidance (`:196-197` — no-op writes must not touch mtime) is preserved by its existing compare-before-write guards, which run BEFORE the write call. Credentials file keeps `chmod 0600` after rename (fsync doesn't change perms; explicit chmod stays).

**D6 — Micro-helpers:** db.js's `nowIso` and `randomUUID` id gain re-exports in `lib/persistence.js` (single home for future call sites; db.js internals unchanged); `truncateTitle` moves to persistence (used by chat-history + migrate); `normalizeBaseUrl` stays duplicated IF removing it creates an import cycle (the existing comment at llm-providers.js:109 says exactly that) — attempt consolidation via `lib/` (both can import lib without cycle), delete the dupe. Dead `chat-history.js:98-104 toIso` deleted.

**D7 — Test plan: new `scripts/test-persistence.mjs` (node:test, tmpdir):** (a) atomic write produces exact expected bytes + no leftover tmp files; (b) two concurrent `mutate()` calls both apply (no lost update) — the exact cron add/remove race, now impossible; (c) readJsonOr fallback on missing/corrupt/ENOENT-dir; (d) unique tmp names never collide under concurrency; (e) dsh-profile writes still produce identical YAML for a fixture profile (golden-file compare before/after refactor).

## Risks / Trade-offs

- [fsync adds ~ms-level latency per save] → These paths save on user actions (provider edit, job save), not per token/message; acceptable. SQLite hot path untouched.
- [Dropping 409-on-contention for llm-providers may break an untested expectation] → Task verifies against e2e suite; fallback plan (`tryMutate`) documented in D3.
- [A latent consumer depends on `.tmp` sibling naming (e.g. a deploy script copying jobs.json while excluding *.tmp)] → grep for `.tmp` references in scripts/, Dockerfile, workflows during implementation; the unique-suffix name still matches `*.tmp` glob patterns.
- [Hand-rolled atomicity vs battle-tested package] → Mitigated by unit tests incl. concurrency; scope is 3 JSON stores + YAML sites, not a database.
- [Mixed sync/async surfaces confusion later] → Documented in module JSDoc: new code SHOULD use async variants; sync exists for the dsh-profile call graph.

## Migration Plan

Pure code change, no data migration (formats identical). Land per-module with e2e subset per step: persistence module + tests first, then cron (race fix — the only behavior fix), then llm-providers, workdir-store, dsh-profile + skill-materialize + catalog/extension/first-run readers last. Rollback: revert — old writers' output was byte-identical, so no on-disk artifacts from the new code survive a revert beyond normal files.

## Open Questions

- None blocking. Future option recorded: import jobs.json into SQLite via migrate.js once real jobs accumulate (the deferred D-item in the proposal).


## Implementation Notes (2026-08-29)

- D3 amended in shape, not guarantees: the generic load/mutate/save wrapper became `createWriteChain()` (mutate queues; tryMutate rejects with BusyError code "busy"). cron + workdir serialize their flushes through it; llm-providers exposes it as `tryWithWriteLock` — the REST layer's 409-on-contention contract (and its e2e test) is byte-identical. The mutex now lives next to the data it protects instead of route code.
- Golden-file check for dsh-profile satisfied structurally: only the write mechanics changed (atomicWriteTextSync); the `yaml.dump` serialization is untouched, and the persistence unit tests assert exact-bytes writes.
- log-text deltas: extension-store's ENOENT info lines ("No market-catalog.json found") folded into readJsonOr's policy (ENOENT silent, parse-error warn); catalog's unreadable-file warning now names the path via the shared label. No on-disk bytes changed anywhere.
- migrate.js keeps its `toIso` (used); the dead chat-history copy was already removed in the add-ci-quality-gates lint pass. migrate's truncateTitle keeps its "New chat" empty-fallback on top of the shared helper.
- Deferred (unchanged): JSON stores stay JSON — jobs.json→SQLite import remains trivial while jobs.json is empty; dsh-watched files (settings.yaml/.credentials.yaml) are format-locked.
