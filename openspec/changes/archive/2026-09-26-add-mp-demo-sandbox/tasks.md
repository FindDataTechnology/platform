# Tasks: add-mp-demo-sandbox

## 1. Server — sandbox mode

- [x] 1.1 Parse `DEMO_SANDBOX` into ctx (server.js config object, `=== "true"` convention) and add the `everyone` mode to `createDemoBudget` (server/ws.js); unit-test: everyone-mode counts any identity, per-instance budgets are independent
- [x] 1.2 In sandbox mode give every WS connection its own budget and answer past-cap prompts with a sandbox-specific limit reply; verify with the fake-ctx cell-level test: two connections each get the full cap, a capped connection's next prompt gets the reply and starts no turn
- [x] 1.3 Reject document uploads when `ctx.DEMO_SANDBOX` (server/routes/documents.js) with a friendly 403; verify a route-level test (or extend the fake-ctx suite) shows no file is written
- [x] 1.4 Implement the wipe step in `server/sandbox.js` (skip-while-streaming → new session → delete the rest, all injected) and wire a periodic timer in server.js behind the flag (default 2h, env-tunable); unit-test the injected step against fakes covering the streaming-skip and wipe paths

## 2. Client — demo entry/exit

- [x] 2.1 Add the demo origin constant + `isDemoBase()` (config.ts) and `runtime.switchBase()` (final-close client, reset state, re-boot); verify typecheck + a unit assertion that switching updates the persisted base — switchBase carries a boot-generation guard so a pre-switch in-flight boot cannot install a stale client
- [x] 2.2 Unbound banner gains "先体验 ›" (enter demo: persist pre-demo origin, clear token, switchBase); demo notice shows while on the demo origin with "退出演示" (restore origin, switchBase); verify via typecheck + weapp build + compiled-bundle assertions (both affordances present, no auto-navigation added)
- [x] 2.3 Demo detection covers both shapes (origin OR login email); the login page remains unreachable from the demo origin; verify bundle assertions + typecheck

## 3. Deployment & routing

- [x] 3.1 Write `fd-infra-deploy/all-services/prod/platform-demo.yaml` (Deployment replicas:0 + NodePort 31871 Service + ConfigMap; anti-affinity vs platform; emptyDir data/dsh-home; LLM via the sub2api NodePort on cheap-4 — node IP, since the pod uses `dnsPolicy: Default` like platform; LLM_API_KEY from platform-secrets) and commit+push both remotes; verified ArgoCD synced: replicas 0, no pod
- [x] 3.2 Add the inert Caddy block on cheap-1 (demo hostname → 127.0.0.1:31871) with a timestamped backup (`Caddyfile.bak-20260925-194823`); `caddy validate` passed, reload via admin API; craw and token re-verified 200, demo answers 502 (inert, as designed)
- [x] 3.3 Document `DEMO_SANDBOX` + the wipe interval in `.env.example` and the demo-pod go-live checklist in DEPLOY.md

## 4. Verification

- [x] 4.1 Run `npm run test:unit` (new `scripts/test-mp-demo-sandbox.mjs` included) — 271/271 green (one unreproduced flake in an earlier run)
- [x] 4.2 Run the fast e2e suite — 211 passed / 1 skipped / 0 failed (11.1m), better than the pre-change baseline
- [x] 4.3 Local end-to-end rehearsal: booted `server.js` with `DEMO_SANDBOX=true AUTH_MODE=none` — clean boot, `/api/config` answers unauthenticated, upload POST answers the friendly 403; the per-connection cap and wipe are covered by the fake-ctx/unit tests, and the devtools UI pass rides the go-live probe

## 5. Go-live (operator checklist — needs the user)

- [x] 5.1 DNS A record `demo.finddatatech.cloud` → entry IP (user); Safeline site + cert (user); chain verified end-to-end
- [x] 5.2 WeChat console: add `https://demo.finddatatech.cloud` to request + socket legal domains (user confirmed 2026-09-25)
- [x] 5.3 Builds #24/#25 (sha-3d68a79 → sha-0ccd811 after the Dockerfile hmr-pin fix), GitOps rolls, live probe GREEN: 3-min stable 200s through Safeline→Caddy→NodePort, real chat (user→agent_start→text deltas→done), upload 403. Go-live debugging found and fixed: emptyDir shadowing the baked dsh home; cordis-plugin-hmr floating to 1.0.19 in the profile tree; LLM route must be the sub2api ClusterIP. Also rescued a cluster incident mid-go-live (cheap-4 containerd restart GC'd harbor's own images → registry/sub2api outage; images re-imported via the daocloud mirror relay, harbor + sub2api restored)
- [ ] 5.4 Upload the new client version and resubmit for review with the demo-flow explanation + screenshots — client upload ready via wechatide (needs IDE approval); console resubmission is the user's
