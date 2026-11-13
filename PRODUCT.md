# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

The primary user is the product's owner-developer: locally, 壹座 is a personal, daily AI assistant used in the browser (`npm start`, the app at `localhost:3000`, or `npm run web:dev` on Vite :5173) and as the packaged Electron desktop app. The hosted deployment (`fd-prod`) is the second, equally real product home: it serves demo/early external users who arrive through the WeChat mini-program (bind-code login), the facet registry marketplace (Logto SSO with roles), the 智语 rooms and their website-embed guest seats, and social bots on WeCom/Feishu/Telegram/微信公众号. The job across those homes: chat with a capable agent runtime, keep agent *teams* working unattended, retrieve over the user's own documents, and manage models/extensions/agents/fleets from one place.

## Product Purpose

壹座 (Yizuo — 寻数·壹座「智能体基础设施」) is an AI agents & teams execution platform built on the DeepSeek Harness (dsh) runtime, run in two topologies: a local self-contained assistant (one process, one launcher) and a hosted multi-user deployment where a gateway fronts per-user "cells". It streams dsh agent chat (thinking, tools, skills); assembles the product's core equation — **agent = persona + skills + tools(MCP)** — in the Studio builder and ships the result through the facet marketplace as vertical packs and teams; runs those teams as fleets with scheduled rounds, decision lanes, a cockpit canvas and run timeline; hosts 智语 multi-party rooms where humans and agent avatars share one table (with WeCom/Feishu bridges and embed widgets); persists long-term memory (永忆) over all of it; and manages the surrounding stack (models, MCP extensions, skills, cron, bots, runners) from one place. Success means the owner relies on it daily, the hosted product demos and serves early external users credibly, and an agent team completes real work while nobody is watching.

## Positioning

Locally: one process, one launcher, no cloud setup — the complete assistant (dsh runtime, first-party documents RAG, management UI) boots from a single command, and the desktop app carries the same thing. Hosted: per-user isolation on the same unit — each user gets a dedicated cell (one `server.js` process + its dsh runtime + a private data directory), so multi-user hosting adds a topology, not a sidecar. This rests on mechanisms a hosted chat product cannot truthfully copy: the depth of the dsh agent runtime (skills, tools, persistent sessions, model routing, native MCP connectors), fleet execution with rounds/decisions/metering that survives the browser being closed, first-party docs RAG over the user's own corpus, and a registry marketplace whose vertical packs (one entry skill + MCP servers + conversational agents + visibility roles) assemble industry workflows without forking the product. The product's own vocabulary (智能体/团队/小组/能力包/市场, five locales) is governed by the wordlist in `docs/roadmap-agents-native-teams.md`.

## Operating Context

- **Run modes (local):** `npm start` (headless launcher supervising `server.js`), `npm run web:dev` (Vite HMR), Electron desktop (`npm run start:electron`; arm64/x64 `.dmg` and Windows `.exe`).
- **Run modes (hosted):** `fd-prod` on K8s — a `gateway/` fronts many per-user cells; images build on GitHub Actions and ship registry → GitOps tag bump → ArgoCD (running table + release log in `docs/registry-maintenance.md`; build-channel rules in `AGENTS.md`).
- **Design languages (adaptive):** the dark-first web workbench (documented in `DESIGN.md`; browser + desktop render the identical UI, and since 2026-11-02 both consume one foundation kit — see Constraints) and the WeChat-native mini-program language (`miniapp/`, Taro 4 + React, compiled to weapp). The MP follows WeChat platform conventions — not iOS HIG or Material.
- **Surfaces (web routes):** `/chat` (default) and `/chat/:sessionId`, `/knowledge` (Documents), `/resources`, `/memory` (永忆 portal), `/agents` (智能体构建器总门面), `/studio` (agent builder), `/apps` (生态产品发现面), `/fleet` and `/fleets/:fleetId` (团队总览与驾驶舱), `/machines` (runners), `/tasks` (cron), `/zhiyu` and `/zhiyu/:roomId` (智语空间; `/zhiyu/embed/*`, `/zhiyu/join/*` as guest lanes), `/boards/:line` (产品线门面), `/settings/:section` (models, mcp, skills, channels, diagnostics, status — older `/models`, `/mcp`, `/skills`, `/bots`, `/trace`, `/dashboard` routes redirect here), `/external/:appId` (catalog-declared embedded apps), and public read-only `/share/:token`.
- **Surfaces (mini-program pages):** chat (home; history lives in its slide-up drawer), login (account bind), share, cron.
- **Configuration:** `.env` in dev, `userData/settings.json` in the desktop app, ConfigMap + Secrets on hosted; every optional component degrades gracefully — the server always starts.
- **Data:** SQLite under `PLATFORM_DATA_DIR` (sessions, chat history, documents index, cron, extension/MCP config, packs/fleets ledgers); on hosted, that directory is per-user inside the cell.
- **Auth:** local — optional, default open access or `forward_auth` behind a proxy (oauth2-proxy → Logto). Hosted — MP bind-code login and Logto SSO for market credentials. The public `/share/:token` and 智语 guest lanes are exempt from every auth posture within their declared scope.

## Capabilities and Constraints

Confirmed capabilities: streaming dsh agent chat with thinking/tool/skill rendering, plan progress, composer control dialogs, outline navigation, collapsible activity groups, chart rendering, and copy/regenerate; model and agent selection including locally-run pack agents with a configurable persona name; the Studio three-bucket builder (persona + skills + MCP tools on one manifest, with fork/lineage and AI drafting); a facet marketplace of official and community packs/teams with install, drafts, and per-user registry credentials; fleet execution — teams of agents with scheduled rounds, a cockpit canvas (graph + run timeline + inspector drawers), decision lanes, report attribution, turn metering and pricing estimates; runners/machines management for remote execution; 智语 spaces — multi-party rooms where humans and agent 分身 co-attend, with WeCom/Feishu bot bridges, website-embed guest seats and join links; bot channels (WeCom self-built apps, Feishu custom apps, Telegram, 微信公众号) with verified webhooks, per-(bot, chat) sessions, and a machine-caller relay (`bot-relay`); a long-term memory layer (永忆: digests, anchors, visibility-gated browse-and-correct portal); a local document library (PDF/Markdown/text/URL ingestion with deterministic local extraction — no LLM calls — and two retrieval rungs: keyword search that is always on, local and ranked, and an optional semantic rung the owner switches on per library after acknowledging that chunk text leaves for an embedding lane; exposed as `list_library`/`search_library` and managed from `/knowledge`); scheduled jobs (cron) with notifications and fleet round discipline; tool discovery; public session share; the WeChat mini-program thin client; vertical packs and business-team sets assembled per the wordlist.

Confirmed constraints:

- **Chinese-first copy** — zh-CN is the primary product language; en/es/fr/ja are secondary. All UI strings flow through the checked locale files (`npm run check:locales` gates the build).
- **Desktop app parity** — the Electron app is a first-class surface; browser and desktop render the same web UI and neither may regress the other.
- **One foundation, many pages** — since 2026-11-02 (`web-design-system`): pages inherit visual nouns from `web/src/components/ui/` (Card/StatusPill/Tabs/Select/Tooltip/Toast-v2/ConfirmDialog/PageShell/StatesKit), color comes from the lamp/status/series vocabulary only, and `scripts/design-lint.mjs` ratchets literal-color and native-confirm debt to zero. A new surface hand-rolls nothing.
- **One cell per user** — per-user state (history, documents, config, skills, cron, bots) lives in that user's data directory and is never readable or writable from another cell; registry tokens and secrets are never committed in plaintext and never reach the browser.
- One dsh session serves all connected clients; the WS message contract in `openspec/specs/` is binding.
- **Mini-program lifecycle** — backgrounding kills sockets (resume on foreground) and the absence of DOM forces degraded rendering; the MP shares `@platform/core` (`packages/core`) with the web app and stays a thin client over the same WS/REST contracts.

## Brand Commitments

Product name: **壹座 (Yizuo)** — the 智能体基础设施 of FindData Technology (寻数), repo `paas`; hosted at `platform.finddatatech.cloud`. The line naming is fixed by the five-lines wordlist: 寻数·壹座 (base), 识律, 柏讯, 谦面, 萬星 (智语 lives under 萬星). The assistant persona's display name is configurable via `ASSISTANT_NAME` (default "Platform"; the hosted deployment runs "FD") and names the built-in agent's picker row and sidebar presence. README follows the five-lines public-surface convention (decided 2026-10-01): `README.md` (English primary) + `README.zh-CN.md`, interlinked at the top, each opening with the Base-line banner linking to `www.finddatatech.cloud/products/base`; versioned releases ship via GitHub Actions. No logo, identity assets, or voice guide exist yet — none is binding.

## Evidence on Hand

- Working codebase: Express + WS backend (`server.js`, one process per cell), React 19 + Vite + Tailwind v4 + shadcn-style `ui/` foundation frontend (`web/`), Taro 4 + React 18 mini-program (`miniapp/`), shared core (`packages/core`), hosted gateway (`gateway/`), agent-runner (`agent-runner/`).
- Documentation: `README.md` (zh + en), `CLAUDE.md` (architecture), `DEPLOY.md`, `DESIGN.md` (Night Workbench + color vocabulary + primitives), `docs/registry-maintenance.md` (release ledger), `docs/roadmap-agents-native-teams.md` (wordlist v4), ~230 OpenSpec capability specs under `openspec/specs/`, Playwright e2e suites under `e2e/`.
- Absences future work must not fabricate: no logos or brand assets, no product screenshots, no testimonials, customers, benchmarks, or pricing.

## Product Principles

1. **Local-first, always-runs.** The whole assistant boots from one launcher, and every optional component degrades gracefully rather than blocking startup — locally and per cell on hosted alike.
2. **Chat is the door; teams are the work.** The chat surface is how the owner arrives daily, but the platform's substance is agents and teams that keep working after the tab closes — scheduled rounds, decisions surfaced to a human, results waiting in the cockpit.
3. **Chinese-first, locale-checked.** zh-CN leads; every user-facing string lives in the checked locale files, never inline.
4. **One product, two design languages.** Browser and desktop are the identical web UI (parity is a constraint, not a nicety); the WeChat MP is the WeChat-native dialect of the same contracts — each surface speaks its platform, not a port.
5. **Secrets stay server-side; one cell per user.** API keys, external-service tokens, and per-user state never reach another client, another cell, or the repository.
6. **The workbench is one system.** Every surface draws from the same tokens, primitives, and the one-lamp + status-vocabulary + series-ramp color discipline; pages inherit, never hand-roll, and the ratchet gate keeps the promise honest (`web-design-system`).
