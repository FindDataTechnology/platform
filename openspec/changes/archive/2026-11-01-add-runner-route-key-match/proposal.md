# Proposal: add-runner-route-key-match

## Why

The runner route (add-fleet-carrier D2) matches a2a catalog entries by entry id — but the registry bridge always prefixes catalog ids with `registry-` (`registry-${pathToName(path)}`, registry-bridge.js mapAgent), so a catalog id can never equal a member's bare persona roster key (e.g. `service-agent`). Production verified (2026-11-01 活体取证): chat∩a2a same-id is empty across all 84 catalog agents, and both a bare pack persona key and a full a2a catalog id are rejected by the persona roster — **the runner route as shipped can never match any entry**, every runner-carried turn fail-opens with `runner-no-entry`. The matching data already exists: each a2a entry's registry path ends with the deployed agent key (`/packs/<packId>/<agentKey>`), which is exactly the namespace member personas are keyed in.

## What Changes

- `runnerEntryFor` (server/cron-runner.js) matches a2a catalog entries by **registry path suffix (the deployed agent key)** instead of entry id: the last path segment of the entry's `path` (or its composed `url` when the snapshot entry carries the raw path) is matched against `rosterPresetId === job.preset`.
- **Ambiguous matches** (≥2 a2a entries whose agent key matches — e.g. `reception` deployed from three packs) → honest fail-open with a NEW recorded reason `detail.carrierFallback: "runner-ambiguous"` — never a guess, never a silent pick.
- No-entry fail-open unchanged (`runner-no-entry`), the a2a executor job rewrite unchanged (`{preset: entry.id, targetType: "a2a"}`), the claimant/executor metering rules unchanged.
- Spec delta: `agent-fleet-carrier` MODIFIED — the runner-route requirement's matching rule is restated (id match → agent-key match + ambiguity clause); all other scenarios of the requirement carry over unchanged.

## Capabilities

### Modified

- `agent-fleet-carrier` — the runner-route requirement (D2): matching rule restated from "entry id equals the task preset" to "the entry's deployed agent key (registry path suffix) equals the task preset", plus the ambiguity fail-open clause.
