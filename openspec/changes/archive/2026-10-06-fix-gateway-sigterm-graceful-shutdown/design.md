# Design — fix-gateway-sigterm-graceful-shutdown

## Root cause (verified)

`gateway/index.js` boots in one of two modes:

```js
if (facetBase) {
  registerFacetProxy(app, { ... });            // facet-proxy mode
} else {
  const packRegistry = createPackRegistry({...});   // ← block-scoped const (line 371)
  registerPackRoutes(app, { registry: packRegistry, ... });
}
```

The signal handler (module scope) pasted in by the facet cutover (33389f7) reads:

```js
process.on(signal, async () => {
  console.log(`[gateway] ${signal} — stopping ${registry.cells.size} cell(s)`);
  shareRegistry.close();
  const facetBase = (process.env.FACET_BASE_URL || "").replace(/\/+$/, "");
  if (!facetBase && packRegistry) packRegistry.close();   // ← ReferenceError in pack mode
  await registry.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
```

`packRegistry` is only in scope inside the `else` block. Facet mode survives by short-circuit (`!facetBase` → false, `packRegistry` never evaluated); pack mode — fd-prod's mode (packs marketplace runs on the gateway) — throws on identifier lookup. Inside the async handler the throw becomes a rejected promise: Node ≥15 kills the process as an unhandled rejection, **before** `await registry.shutdown()`.

Observed: local boot (CELL_GATEWAY_SECRET set, no FACET_BASE_URL) killed with SIGTERM dies with `ReferenceError: packRegistry is not defined at gateway/index.js:542`. Every platform rollout since 10-03 (f221a40, 07cb7f7) terminated its old pod this way: crash-status termination, cells hard-killed by pod teardown instead of graceful stop, and the 3-second forced-exit fallback never reached. Host/compose-shaped deployments leak the cell processes outright.

## Fix

1. **Hoist the binding**: declare `let packRegistry = null;` at module scope before the mode branch; inside the `else` branch assign it (drop the `const`). The handler's existing `if (!facetBase && packRegistry)` line becomes valid in both modes — null-guarded in facet mode.
2. **Isolate the closers**: wrap `shareRegistry.close()` and `packRegistry.close()` each in `try { … } catch (e) { console.error(...) }` — the lesson of this bug is that one throw on the shutdown path silently eats the whole graceful chain; cell shutdown (and the exit) must be unreachable-by-accident from auxiliary failures. `registry.shutdown()` itself stays as the final authority, with the existing 3s `setTimeout` fallback unchanged.
3. **Cosmetic**: fix the mis-indented two lines inside the handler (same commit, zero behavior).

## Testing

- **Local boot check** (same recipe as the discovery): `CELL_GATEWAY_SECRET=x CELL_DATA_ROOT=$(mktemp -d) GATEWAY_PORT=<free> node gateway/index.js` → SIGTERM → assert exit code 0, stdout contains `stopping 0 cell(s)`, no `ReferenceError`.
- **Regression in `test-cell-gateway.mjs`**: the harness already boots real gateways with logs; after the existing subtests, send SIGTERM to the gateway process and assert: clean exit (code 0), the cell-stop log line, and no unhandled-rejection text in the captured logs. Run in a **clean git worktree** — the main working tree is churned by the parallel reconnect-resync session's `server/*` edits, which makes cell-dependent verdicts unreliable there (established during fix-ops-console-board-alarms apply).

## Release

The gateway ships in the platform image, so this one needs a real rollout — unlike the console change: paas commit → `image` GHA workflow → TCR tag → fd-infra-deploy double bump (`platform.yaml` + `platform-demo.yaml`) → ArgoCD sync. platform-demo currently lags at sha-f221a40; the double bump carries it (and 07cb7f7's mobile fix) forward per the documented procedure.

Verification post-rollout: the replaced pod's termination log shows the graceful path (no ReferenceError, exit 0); new pod `/healthz` 200; ops board stays `all nominal` (probes run against `/healthz` and `/api/ready`-on-demo, both untouched by this change).

## Risks

- None behavioral beyond the shutdown path: request routing, cell lifecycle, and both mode branches are untouched; the hoist only widens one binding's scope.
- The 3-second forced-exit fallback remains the ceiling for a hung `registry.shutdown()` — unchanged by design.
- Rolling platform re-exercises the usual rollout risks (image pull, ArgoCD lag); mitigation is the standard poll-then-verify pattern, no new mechanisms.
