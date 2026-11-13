# Proposal: resume-dsh-session-after-restart

## Why

After any dsh child restart — a model / workspace / preset switch, an MCP
hot-swap fallback, or a crash auto-restart — the platform keeps the same
`dshSessionId`, but the fresh child's SDK server only ever calls
`agents.create()`. dsh's persistence layer rejects that on the session's
existing log, so every subsequent turn fails instantly with `session "…"
already has a persisted log on disk that does not match this live session (id
collision)`. Until yesterday this error was also swallowed silently
(fixed separately: turn/end errors now broadcast), which is exactly the
"对话没有返回" symptom the user reported. dsh ships a first-class resume API
(`agents.resume({ resumeSessionId, agentOptions })`) that loads the persisted
log and continues the conversation; the platform's profile bridge simply never
calls it.

## What Changes

- The platform profile's SDK bridge (`dsh-profile-template/platform-preset-bridge.js`,
  already a subclass of the stock `dsh-sdk-jsonrpc-server`) gains
  create-vs-resume logic in `createSession`: when the session id has a
  persisted log, call `agents.resume(...)` instead of `agents.create(...)`,
  mounting the deployment's agent preset through the resume `setup` hook the
  same way create does today.
- Resume is decided BEFORE attempting create. A failed create is not a usable
  fallback: `create` can succeed with an empty seed and only blow up later at
  the first event append (`seedCoversPrefix` → the id-collision turn error), so
  the bridge must ask dsh whether the session is persisted first (persistence
  service probe) rather than catching create-time errors.
- No server-side protocol changes: `session/prompt` keeps its shape; the
  create-vs-resume decision is entirely inside the dsh child. `dsh-bridge.js`
  and every WS handler (`set_model`, `set_workspace`, `switch_session`, …)
  stay untouched.
- Deterministic tests at three levels: a child-level script test (dummy LLM —
  the collision fires at the user-message append, before any LLM call, so no
  tokens are needed), a fast-project e2e spec that restarts the child via
  `set_model` and asserts the next turn does NOT report an id collision, and a
  `@smoke` context-preservation test (tell it a name, restart, ask for the
  name).

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `dsh-runtime-bridge`: the bridge's session-creation contract changes from
  "always create" to "create for unpersisted ids, resume for persisted ones",
  with the preset mounted either way, and a torn final turn in the log (a
  restart mid-turn) must not block resume.

## Impact

- `dsh-profile-template/platform-preset-bridge.js` — the `createSession`
  override becomes create-or-resume; template is copied into the profile at
  boot, so the fix reaches every spawned child with no migration.
- Possibly `dsh-profile.js` — only if the probe needs a new dependency or
  config (expected: none; the bridge already resolves dsh packages through the
  profile's node_modules).
- Tests: new `scripts/test-session-resume.mjs`, new e2e spec
  (`e2e/session-resume.spec.js`, fast project) + one `@smoke` context test.
- Risk: `agents.resume` on a log whose last turn never ended (killed
  mid-turn) — dsh's append-only tail is expected to tolerate this; the design
  verifies it explicitly. Logs written by an older dsh version are out of
  scope (resume failure falls back to the surfaced error, never a silent
  empty turn — guaranteed by the separate turn/end broadcast fix).
