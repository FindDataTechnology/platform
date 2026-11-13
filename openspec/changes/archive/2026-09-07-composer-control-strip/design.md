# Design — Composer control strip

## Context

The constraint that shapes every decision here: **the dsh SDK wire protocol is
three methods.**

```
initialize { cwd, provider, model, maxTokens }   ← all config, once
session/prompt
shutdown
```

`dsh-sdk-protocol/lib/types/types.d.ts:92`. There is no `setModel`, no `setCwd`,
no reload. Config changes are expressed the only way they can be: tear the child
down and hand a new `initialize` to a fresh one. `dsh-bridge.js:202` already does
this for model and effort.

So a control strip is not four dropdowns over four RPCs. It is four dropdowns
over one process restart.

## Decisions

### D1 — Restart is visible, not hidden

Model, effort, and workspace changes all restart the dsh child. dsh persists
sessions by id, so the conversation reloads from disk — but in-memory state is
dropped and there is a real gap of seconds.

The tempting move is to hide this behind a spinner and hope. Rejected: a control
strip *invites* fiddling — four dropdowns under the input say "poke me" — and
silent multi-second stalls after a poke read as a hung app.

Instead: a changed control shows a brief inline "restarting…" state on the strip
itself, and the composer's send button disables until the child is healthy. The
strip is the thing that changed, so the strip is the thing that reports.

**Alternative considered:** queue config changes and apply them on next send.
Rejected — it makes the strip lie about current state, and "I selected the model
but it didn't take yet" is a worse confusion than a visible pause.

**Alternative considered:** debounce rapid changes into one restart. Deferred.
Worth adding if users actually chain changes; premature now. A single restart
per interaction is the honest default.

### D2 — Workspace is a path input plus recents, not a browser

A browser cannot pick a server-side directory. There is no native affordance,
and the three ways to fake one all cost something:

| Approach | Cost |
|---|---|
| Directory-browse API (`GET /api/fs/dirs?path=`) | New filesystem-listing endpoint. Path traversal surface. Reads the whole disk to the client. |
| Electron native dialog | Only works packaged; browser users get nothing |
| Text input + recents | Crude first entry; one click thereafter |

Taking the third. Type an absolute path once, and it joins a recents list you
click from then on. The crude part is only ever the first use of a given folder.

This deliberately declines to build a filesystem browser. Adding one later is
additive — the recents list and the switch mechanism do not change. Adding one
now means shipping a disk-enumeration endpoint to save typing a path once.

**Deferred, not forgotten:** under Electron, the supervisor could open a native
directory dialog and post the result. Cheap to add on top; not a blocker.

### D3 — The path is validated server-side, always

The client sends a path string. The server is the only thing that decides
whether it is acceptable. Validation before any restart:

- must be absolute
- must exist and be a directory
- must be readable by the server process
- symlinks resolved before the check, so the resolved target is what gets
  validated and what gets stored

A rejected path returns an error and the runtime is never touched — a bad path
must not cost a restart, and must not leave the agent in a half-switched state.

Note what this is *not*: an allowlist. The server process already runs with the
user's full filesystem access, and the agent it supervises can read any path it
is pointed at. A path allowlist here would be theatre — it constrains the picker
while the tool layer stays unconstrained. Genuine sandboxing is a different
change (and belongs with the execution-mode work the proposal cuts).

**Trust boundary caveat:** under `AUTH_MODE=forward_auth` this endpoint lets any
authenticated user repoint the shared agent at any directory the server can
read. That is consistent with the existing single-shared-session model, where
any user can already switch the model for everyone. Flagging it rather than
solving it — per-user workspaces need per-user sessions first.

### D4 — The strip reads state it does not own

```
        useChatStore
             │
    ┌────────┼────────┬──────────┐
    │        │        │          │
 currentModel │  currentWorkspace │
          currentEffort       skills
    │        │        │          │
    └────────┴────────┴──────────┘
             │
    ┌────────▼────────────────────┐
    │  ControlStrip (presentational)│
    │  renders state, emits intent  │
    └───────────────────────────────┘
             │ send({type:"set_model"|...})
             ▼
        server → restart → broadcast
             │
             └──▶ store updates ──▶ strip re-renders
```

No optimistic local state in the strip. It renders what the store holds and
sends intent; the server's broadcast is what moves the UI. This matches how the
composer already handles user turns (`Composer.tsx:141` — "The server echoes the
user turn back … no optimistic append here, or it renders twice").

The consequence worth naming: a dropdown will briefly show the *old* value after
you click a new one, until the restart completes and the broadcast lands. That
is correct. The strip should show what the runtime is actually configured with,
not what was requested.

### D5 — Commands button reuses the existing picker verbatim

`SlashCommandPicker` already exists, already merges builtins with loaded skills,
already does filter + keyboard nav + Esc. The button opens it with an empty
query. No new component, no second code path, no duplicated command list.

The one real change: `CMD_META` in `Composer.tsx:50` is a hardcoded array of
four. It stays hardcoded — dsh has no command registry to fetch from, so there
is nothing to discover. Making it dynamic would be building a registry to hold
four constants.

### D6 — Effort hides itself

`ModelInfo.reasoningEfforts` is already optional and already absent for models
that do not support it (`model-selection/spec.md` — "the `models` payload SHALL
omit the `reasoningEfforts` field"). The effort control renders only when the
active model declares them. A greyed-out permanently-disabled control teaches
users to ignore that region of the strip.

## Risks

**Restart churn is the whole risk.** Four controls, one restart each, and the
strip makes them all one click away. If real use shows people chaining changes,
D1's deferred debounce becomes necessary rather than premature. Worth watching
before adding.

**The strip competes with the header.** `ChatHeader.tsx:157` already displays
model and agent as read-only text. Two places showing the model is tolerable
(one is status, one is control) but if they ever disagree, the header is wrong
by construction — both read the same store. Leaving both; revisit if it reads as
noise.

**Workspace switching mid-conversation is semantically odd.** The agent has been
reasoning about files in directory A; now it is in directory B with the same
conversation history loaded. Nothing breaks, but the transcript will reference
paths that no longer resolve. Not solving this — a warning on switch when the
session is non-empty is the cheap mitigation, and it is in tasks.
