# fix-gateway-sigterm-graceful-shutdown

## Why

Since the facet platform cutover (33389f7, 2026-10-03), the gateway's SIGTERM/SIGINT handler crashes instead of shutting down gracefully in pack-registry mode — which is fd-prod's mode. The handler references `packRegistry`, a const scoped to the `else` branch that sets it up (gateway/index.js:371); the module-scope reference throws `ReferenceError` inside the async handler, becomes an unhandled rejection, and kills the process **before** `registry.shutdown()` runs. Verified live: every gateway boot killed with SIGTERM dies with `ReferenceError: packRegistry is not defined` at gateway/index.js:542. Consequences: on every platform rollout since 10-03 the old pod terminates by crash (Error status, noisy termination logs) and its cells are hard-killed by pod teardown instead of the designed graceful stop — the "No cell outlives the gateway" invariant now holds only by kernel accident, and host/compose-shaped deployments would genuinely leak cell processes. The facet-proxy mode (`FACET_BASE_URL` set) accidentally survives via `!facetBase && …` short-circuit.

## What Changes

- Hoist `packRegistry` to a module-scope binding (assigned inside the pack-mode branch), so the shutdown handler's reference is valid in both modes.
- Make each auxiliary closer (`shareRegistry.close()`, `packRegistry.close()`) failure-isolated (try/catch) so no single throw can skip `registry.shutdown()` again — the shutdown chain must be resilient to any one link failing.
- Fix the pasted-in indentation of the two handler lines (cosmetic, same commit).
- Regression coverage: `test-cell-gateway.mjs` gains a graceful-stop assertion — SIGTERM to a booted gateway must exit 0 with the "stopping N cell(s)" log and no unhandled rejection.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `cell-gateway`: new requirement — the gateway shuts down gracefully on termination signals (cells stopped via the registry, clean exit, auxiliary-close failures non-fatal).

## Impact

- **Code**: `gateway/index.js` only (binding hoist + two try/catch + indent).
- **Tests**: `scripts/test-cell-gateway.mjs` (+1 graceful-stop block).
- **Deploy**: needs an image rollout this time (the gateway ships in the platform image): GHA→TCR → GitOps double bump (`platform.yaml` + `platform-demo.yaml`) → ArgoCD sync. The bump also carries commit 07cb7f7's mobile fix to platform-demo, which still runs sha-f221a40 — the documented double-roll procedure.
- **Verification**: old pod's termination logs show the graceful stop instead of the ReferenceError crash; new pod `/healthz` 200.
- Discovered during fix-ops-console-board-alarms apply (task 1.2 local boot); deliberately deferred there as out of scope.
