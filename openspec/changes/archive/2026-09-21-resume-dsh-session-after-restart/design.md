# Design: resume-dsh-session-after-restart

## Context

The platform already ships a subclass of the stock `dsh-sdk-jsonrpc-server`:
`dsh-profile-template/platform-preset-bridge.js`, copied verbatim into the
profile dir at boot and inserted by `presets.patch.yml` (which disables the
stock `sdk-jsonrpc-server` row). Its `createSession` override today always
calls `ctx.agents.create(...)`. The stock server's `getOrCreateSession`
likewise only ever creates — there is no resume path anywhere on the SDK
protocol.

dsh itself has the needed primitive:
`agents.resume({ resumeSessionId, agentOptions, setup })` (read in
`@deepseek-ai/dsh-agent`'s `AgentRegistry`) loads a persisted session through
`dsh-session-persistence` and resumes an agent on it. `ResumeAgentOptions`
carries the same `setup` hook as create, so the preset mount composes the same
way. Session logs live under `$DSH_HOME/sessions/<workspace-slug>/<id>/`
(zstd-compressed jsonl).

Observed failure mode (trace DB, session `platform-5d597a7a…`): after a
`set_model` restart, every `turn/start` is followed within milliseconds by
`turn/end {kind: "error", message: "…already has a persisted log on disk that
does not match this live session (id collision)"}` with zero assistant output.

## Goals / Non-Goals

**Goals**

- Prompting any persisted session after ANY child restart works and keeps
  model-side context (current conversation, sidebar conversations after a
  server F5, conversations left dead by past restarts).
- The fix lives entirely in the dsh-side bridge plugin — no WS protocol change,
  no server-side session bookkeeping change.

**Non-Goals**

- Fixing logs written by older dsh versions (resume error is surfaced; the
  user starts a new chat).
- Restoring the in-flight turn that a restart aborts (existing behavior: the
  server aborts it on `bridge.exit`; the user re-sends).
- Server-restart rehydration of the plan panel (already specified in
  `chat-plan-progress`: in-memory cache, cleared on server restart).

## Decisions

### D1: resume-or-create inside the bridge's `createSession`, decided BEFORE creating

The override becomes: probe whether the session id is persisted → if yes
`agents.resume`, else the current `agents.create` path (preset mounted via
`setup` either way).

Why not try-create-then-resume-on-error: the collision does NOT reliably
surface at create time. `dsh-session-persistence.create` rejects a persisted
id ("load/resume it instead of creating"), but the observed production error
is the LATER one — `seedCoversPrefix` failing at the first append during the
turn. Catching create errors alone would leave exactly the observed bug in
place. The probe must happen first.

Probe implementation: ask dsh, do not sniff files. The bridge resolves the
persistence service from its scoped context (the same lookup pattern the
bridge already uses for `agentPresets`) and calls its stored-log lookup
(`loadStored(id) !== undefined` shape); if the service is absent or the probe
throws, treat the session as unpersisted and keep today's behavior (graceful
degradation, same posture as the preset roster). Filesystem sniffing of the
`sessions/<slug>` tree is rejected: the slug derivation is a dsh internal.

### D2: `agentOptions` parity between create and resume

`agents.resume` accepts `agentOptions` (provider/model/maxTokens). The bridge
passes the same `{ provider: this.provider, model: this.model, maxTokens }`
it passes to create, so a restart that also switched the model resumes the old
conversation under the NEW model. This is the existing product behavior
intent: `set_model` restarts precisely so the next turn runs the new model.

### D3: preset mount on resume via the `setup` hook

`ResumeAgentOptions.setup` has the same pre-publication contract as create's.
The bridge's `setup` (resolve preset → `agentPresets.mount(agentCtx, id)`) is
reused verbatim for both paths. When no roster is composed the override
delegates to `super.createSession` today; for resume-without-roster the
override calls `agents.resume` directly with no `setup` (there is no super to
delegate to — the stock server has no resume).

### D4: server-side code unchanged; per-session error surfacing already shipped

The bridge RPC surface (`initialize`, `session/prompt`, `presets/list`,
`permissions/*`) is untouched, so `dsh-bridge.js`, `server/ws.js`, and every
restart trigger keep their current shape. A failed resume surfaces through the
turn/end error path that now broadcasts (yesterday's silent-empty-turn fix),
satisfying the "never silent" scenario with no new plumbing.

### D5: tests ride the append-before-LLM ordering

The id collision fires when the turn's user message is appended to the log —
before any LLM request. A child-level test with a dummy LLM endpoint therefore
sees either the collision error (before the fix) or an LLM connection error
(after) — deterministic and token-free. Context preservation (the part that
needs a real model) gets one `@smoke` test, gated the same way as the existing
smoke specs.

## Risks / Trade-offs

- [Resume of a torn tail (child killed mid-turn)] → dsh's log is append-only
  with write-batched tails; the explicit torn-tail scenario in the spec plus a
  SIGKILL-based script test verify it. If a torn log ever fails resume, the
  surfaced error tells the user to start a new chat.
- [Pinning dsh internals (`agents.resume`, persistence probe)] → the bridge
  already subclasses the SDK server and resolves dsh packages through the
  profile's node_modules; this adds one more pinned surface. Version drift is
  caught at boot/session-creation time with a surfaced error, not a hang.
- [Resume cost on very long sessions] → logs are zstd-compressed and
  lazily loaded once per session per child; the alternative (context loss
  plus a dead conversation) is strictly worse.
- [Cross-child concurrent resume (dev-cells stack sharing a DSH_HOME)] →
  outside this change; dsh's collision guard remains the backstop and now
  surfaces as a visible error.

## Migration Plan

1. Ship the bridge template change; `dsh-profile.js` already rewrites the
   profile on every boot, so the next server restart picks it up with no
   migration.
2. Sessions broken by past collisions start working on their next prompt
   after the restart (their logs are intact — only the live child refused
   them).
3. Rollback = revert the template file; behavior returns to today's
   (surfaced) collision error.

## Open Questions

- Exact persistence-probe call shape (`loadStored` vs a lighter `has`) —
  resolved during implementation by reading the installed
  `dsh-session-persistence` service surface; either satisfies the spec.
