## Context

Rooms and the round router live in `gateway/zhiyu` (phases 1 & 2). IM receive/send and bot credentials live in cell-side bots (`social-bot-channels`). Cross-process calls use the same pattern as `/api/roles/self`: `GATEWAY_SECRET` + `x-actor-email`.

## Goals / Non-Goals

**Goals:**
- IM group messages land in the room under their sender's identity; room answers travel back to IM with seat attribution; IM-originated rows never echo back; binding can be removed instantly with zero behavior drift; phase-1 fuses/caps/budget/settlement stay untouched.

**Non-Goals:**
- External A2A seats (3B, separate change); IM rich cards/buttons; bridging bot DMs (groups only); IM slash commands (e.g. `/room join`, later); per-IM budget tuning (inheriting the room's daily budget).

## Decisions

### D-A: the bridge is two-sided by topology, not one monolith

- Cell-side `server/zhiyu-im-bridge.js`: intercepts the bots.js inbound hook BEFORE the legacy agent-turn — when a binding exists it forwards the parsed message into the gateway room API instead of running a turn; it also holds the output subscription to the gateway event stream and calls the adapter's `sendText` back into IM.
- Gateway-side `gateway/zhiyu/im-bridge.js`: binding management REST (owner-only, 404-shaped invisibility) + a read-only, bot-scoped event subscription face for the cell's forwarder.

Rationale over a gateway-only bridge: bot credentials (and all platform signing) live in the cell; gateway cannot sign IM replies without them.

### D-B: binding lives only on the bot row — the room table is untouched

Cell-side `bots.zhiRoomId` (guarded ALTER migration). The room keeps no bot back-reference; revoking the binding is a one-column write with zero room-side fallout.

### D-C: one sender ⇔ one guest seat (sha1 prefix)

`im_<12 hex of sha1(chatKey + ":" + imUserId)>` as member ref. Same person, same seat on repeat; same person across two groups = two seats (correctly isolated timelines).

### D-D: delivery pipeline for room → IM

Read-only EventSource-like replay with `after=<seq>` (replays must not duplicate sends); text over each platform's practical cap is split sequentially with the attribution prefix only on the first chunk (Telegram ~4096 chars; Feishu/WeCom ~2048 safe cut); per-bot outbound bucket at 60/min; failed IMDeliver attempts are retried once and then surfaced as a room event (never silently swallowed).

## Risks / Trade-offs

- **Offline window (cell↔gateway link down)**: inbound IM messages would be lost silently. Mitigation: cell-side retry-three with honest log + fallback path (degrade to the legacy agent session for that message only, flagging meta) — never queue unbounded.
- **Group noise amplification**: open groups can spam the room. Mitigation: the existing per-room daily budget + reply cap remain the authority guests inherit; no separate per-IM budget in this change.
- **Load-bearing duplication on replay**: re-subscriptions after a restart must not re-send. Mitigation: seq-anchored replay + per-bot last-sent cursor persisted in cell state (UDP-less idempotency).

## Migration Plan

`bots.zhiRoomId` column addition only; `ZHIYU_IM_BRIDGE_*` default off until walkthrough; rollback = column ignored (no revert of the column needed).

## Open Questions

- IM-native @-for-agents (Telegram's @bot mention parsing vs. text parsing) — apply-time; text parsing is the current default.
- Display-name sync for guests when a user renames in IM — apply-time; current posture is snapshot-at-first-contact.
