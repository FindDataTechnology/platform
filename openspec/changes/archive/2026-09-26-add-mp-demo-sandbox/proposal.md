# Proposal: add-mp-demo-sandbox

## Why

The second WeChat review rejection ("首页暂无法完整体验功能") shows the reviewer
cannot complete any login path on a client-only fix — the bind code requires a
platform account the reviewer can never have. The gateway-shaped demo mode
(`add-mp-demo-mode`) cannot ship on fd-prod because fd-prod runs the
single-process shape on a 3.9GiB node that cannot host per-user cells. We need
a reviewer-usable real chat experience that fits fd-prod's cluster as-is.

## What Changes

- **Sandbox server mode (`DEMO_SANDBOX=true`)**: a single-process deployment
  flag that (a) caps prompts per WS connection (reuse the demo budget, applied
  to EVERY connection), (b) rejects document uploads, and (c) periodically
  wipes chat sessions so the shared runtime never accumulates strangers'
  conversations.
- **A dedicated demo pod** (`platform-demo`, same namespace and image as
  `platform`): auth-free (`AUTH_MODE=none`), emptyDir data (nothing survives
  pod recreation), LLM via the in-cluster sub2api service, anti-affinity with
  the platform pod so it never lands on the 3.9GiB cheap-3 node. Shipped
  scaled-to-zero in GitOps; enabled by bumping replicas together with the new
  image tag.
- **Client demo entry**: the unbound banner gains "先体验 ›" — switches the
  mini program to the demo origin (`https://demo.finddatatech.cloud`), which
  runs the authless sandbox; a "退出演示" affordance restores the production
  origin and re-boots. The switch uses the existing persisted-base mechanism.
- **Entry routing**: a Caddy block on the entry node proxies the demo hostname
  to the demo pod's NodePort, mirroring the craw block; TLS/Safeline and DNS
  are operator steps (checklist in design).

Non-goals: no identity/账号 work on the sandbox (it is accountless by design);
no changes to `add-mp-demo-mode`'s gateway path (both coexist: cells where the
gateway exists, a sandbox pod where it does not); no reviewer-specific content
curation (the packs' agents and prompts serve as-is).

## Capabilities

### New Capabilities

- `mp-demo-sandbox`: the accountless demo sandbox — server sandbox mode
  (per-connection prompt cap, upload guard, session wipe), the demo pod's
  deployment contract (auth-free, ephemeral data, bounded LLM route, isolation
  from the account deployment), and the client's demo entry/exit switch.

### Modified Capabilities

(none — `miniprogram-auth`'s unbound-state behavior is untouched: the demo
entry is an additional affordance on the same banner, not a change to the
sign-in contract; `mp-demo-mode`'s gateway requirements are untouched.)

## Impact

- `server.js` (config parse + sandbox wipe timer), `server/ws.js` (per-
  connection budget), `server/routes/documents.js` (upload guard),
  `server/sandbox.js` (new: the wipe step, dependency-injected for tests).
- `miniapp/src/lib/{config,auth,runtime}.ts` + `pages/chat/index.tsx` (demo
  entry/exit, sandbox banner).
- `fd-infra-deploy`: `all-services/prod/platform-demo.yaml` (Deployment +
  NodePort Service + ConfigMap, replicas: 0 until go-live).
- Entry node Caddy: one inert block (demo hostname → NodePort 31871).
- Operators: DNS record, Safeline site + cert, WeChat legal-domain whitelist,
  Jenkins image build, replicas/tag bump (all in the go-live checklist).
