# Composer control strip

## Why

The chat composer is a bare `[📎] [textarea] [↑]` row. Every knob that shapes a
turn lives somewhere else:

| Control | Where it lives today |
|---|---|
| Model | `/models` ops page, or the `/model` slash command |
| Reasoning effort | `/models` ops page dropdown (`ModelList.tsx:68`) |
| Commands | A hardcoded 4-entry array in `Composer.tsx:50` |
| Working folder | Nowhere — fixed at process start, never changeable |

Two of these (model, effort) are fully wired end-to-end and are simply parked on
an operator screen a chat user has no reason to visit. One (commands) is
discoverable only by typing `/` and hoping. One (folder) does not exist at all,
which pins the agent to whatever directory the server was launched from for the
life of the process.

The reference point is the dsh official web composer, which surfaces these as a
control strip beneath the input.

## What changes

A control strip renders under the composer textarea, left-aligned, before the
send button:

```
┌──────────────────────────────────────────────────────────┐
│  Ask anything…                                           │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  📁 ~/paas   ⌘ Commands   ◈ deepseek-v4-pro   ⚡ medium   │
│                                              📎      ↑   │
└──────────────────────────────────────────────────────────┘
```

- **📁 Workspace** — switches the dsh runtime's `cwd`. Recents list + an
  absolute-path input. New capability, requires backend work.
- **⌘ Commands** — opens the existing `SlashCommandPicker` by click instead of
  only by typing `/`. Pure UI; the picker already exists and already merges
  builtins with loaded skills.
- **◈ Model** — the existing `set_model` WS message. Pure UI.
- **⚡ Effort** — the existing `set_effort` WS message, shown only for models
  that declare `reasoningEfforts`. Pure UI.

Each control that mutates runtime config shows a restart affordance, because
dsh bakes config into the `initialize` handshake (see Design D1).

## What is explicitly NOT in scope

Two controls from the original request are cut. Recording why, so this is a
decision and not an oversight.

**Mode (plan / code / ask).** dsh has no mode concept. The SDK's entire wire
protocol is three methods — `initialize`, `session/prompt`, `shutdown` — and
`InitializeParams` is `{ cwd, provider, model, maxTokens }`. A mode selector
would be a feature we invent (a system-prompt prefix, or a host-side tool
allowlist) wearing a dsh-shaped button. That may be worth building; it is not
"mirroring the official composer," and bundling an invented feature into a
mostly-cosmetic change hides its cost. Propose separately.

**Execution mode (auto-approve / ask / read-only).** dsh auto-allows every tool
declared by the profile's plugins — `server.js` passes no allowlist at all.
`dsh-user-approval` is a per-request ask/answer service, not a policy enum, and
since nothing ever asks, no approval event is emitted to hook a UI onto. A
working toggle needs an approval pipeline built first: profile-level tool
gating, an approval event on the WS contract, and a blocking UI. That is a
change of its own, and larger than the other five combined.

Also out: multi-root workspaces. `InitializeParams.cwd` is one string. Multiple
simultaneous roots have nowhere to go in the protocol.

## Capabilities

- `chat-composer-controls` (new) — the strip, its controls, and the restart UX
- `workspace-selection` (new) — cwd switching, path validation, recents
- `dsh-runtime-bridge` (modified) — `restart()` accepts a new `cwd`

## Impact

- `web/src/components/Composer.tsx` — strip added below the textarea
- `web/src/components/ChatHeader.tsx` — model/effort text becomes redundant;
  header keeps them read-only, strip owns interaction
- `web/src/types/ws.ts` — `set_workspace`, `workspaces`, `workspace_changed`
- `web/src/locales/*/common.json` — five locales, per the i18n build guard
- `dsh-bridge.js` — `restart({ cwd })`
- `server/agent-session.js` — workspace switch handler, recents persistence
- `server/ws.js` — new message routing

Non-goals that stay non-goals: no change to how prompts are sent, no change to
the streaming contract, no change to the `/models` page (it keeps its controls;
the strip is an additional surface, not a migration).
