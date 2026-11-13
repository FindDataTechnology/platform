## Why

The cockpit v2 reads like an org chart plus a post-mortem replay. An owner opening `/fleets/:id` can see the declared structure and scrub a finished run, but cannot SEE the fleet breathing in real time — which edges are carrying turns right now, which bot just failed a tool call, or whether the whole fleet is healthy at a glance. We need a runtime data-flow layer on top of the existing canvas, plus a horizontal config overview, so the answer to 「谁在跑、往哪跑、跑得怎么样」is visible without leaving the page.

## What Changes

- **Runtime data-flow overlay on the existing React Flow canvas**: animated particles along active edges during live turns, fading out after a short quiet window.
- **Node-embedded mini span**: collapsed tool-call waterfall inside post cards for in-flight or recently-failed turns, surfaced on hover/selection without opening the inspector.
- **Fleet config bar**: horizontal read-only aggregate above the canvas — model distribution, effort levels, context budget histogram, edge traffic heatmap (24h OK/FAIL color temperature).
- **Bot first-class citizen**: complete MemberView type semantics for bot/tool kinds, native icons and status indicators on canvas and inspector; store and API expose bot heartbeat fields.

## Capabilities

### New Capabilities

- `fleet-config-overview`: horizontal read-only aggregate bar showing model distribution, effort levels, context budget histogram, and 24h edge traffic heatmap derived from the existing cockpit aggregate.

### Modified Capabilities

- `agent-fleet-cockpit`: canvas gains runtime data-flow edges (animated SVG particles driven by live turns and edge traffic) and node-embedded mini spans (tool-call waterfall inside post cards for in-flight or recently-failed turns).
- `agent-fleet-core`: MemberView shape, fleet store, and /api/fleets/:id/cockpit response extend bot and tool kinds to first-class citizens with type, icon, status, and heartbeat fields consumed by canvas and inspector.

## Impact

- **Frontend**: `web/src/components/fleet/FleetCanvas.tsx`, `web/src/pages/FleetsPage.tsx`, `web/src/store/fleet-store.ts`, `web/src/lib/fleet-layout.ts`, plus new component files for config bar and mini span.
- **Backend**: `/api/fleets/:id/cockpit` response shape unchanged for existing fields; bot heartbeat and tool fields may be added to MemberView. No new endpoints required.
- **Dependencies**: None new; stays within `@xyflow/react` and existing WebSocket lanes (`fleet_turn_*`, `cron_status`, `cron_completed`).
- **E2E**: fleet cockpit spec tests add runtime flow assertions; bot canvas tests add first-class citizen icon and status checks.
