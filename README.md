# Platform

[![CI](https://github.com/FindDataTechnology/platform/actions/workflows/ci.yml/badge.svg)](https://github.com/FindDataTechnology/platform/actions/workflows/ci.yml)

> **Part of the [Base line (寻数·壹座)](https://www.finddatatech.cloud/products/base) of [FindData](https://www.finddatatech.cloud)** — the execution base of the FindData product matrix: every FindData project runs on this AI harness.
>
> [English](README.md) · [简体中文](README.zh-CN.md)

**Platform (v1.3.0)** is a local-first AI assistant platform built on the **DeepSeek Harness (dsh)** runtime. It streams the full agent loop — thinking, tool calls, skill execution — to a browser or an Electron desktop app (the identical UI on both), answers over your own documents via a local RAG index, and manages the surrounding stack: models, MCP extensions, skills, agents, scheduled jobs, and bot channels. The same unit also hosts: a gateway fronts one isolated **cell** per user, and a WeChat mini-program ships as a thin client over the same contracts.

## Highlights

- **Streaming agent chat** — chain of thought, tool calls, and skill execution rendered in real time; per-conversation model and agent selection.
- **Document RAG on a local index** — bring PDF / Markdown / plain-text files or web URLs; answers are grounded in your corpus. All data stays in local SQLite.
- **MCP extensibility** — connect MCP servers with zero code changes; an extension marketplace can wire into a self-hosted [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry).
- **Agents, packs, and scheduled work** — agent/app catalog with cloud refresh, versioned vertical packs, cron jobs with notifications.
- **Bot channels** — WeCom, Feishu, Telegram, and WeChat Official Account bots with verified webhooks and per-(bot, chat) sessions.
- **Session sharing** — public read-only `/share/:token` views.
- **One product, several surfaces** — web, Electron desktop (macOS / Windows), and a WeChat mini-program, all speaking the same WS/REST contracts.
- **Local-first, always runs** — one command boots the whole thing; every optional component degrades gracefully instead of blocking startup. Keys and tokens stay server-side.

## Quick start

```bash
npm install        # backend deps + builds web/dist
npm start          # http://localhost:3000 (headless launcher)
npm run web:dev    # Vite dev server :5173 with HMR (backend must also run on :3000)
```

`npm start` runs the headless launcher (`scripts/start.js`), which supervises a single child process — `server.js` — handling `.env` loading, health checks, restart-on-crash, and log capture. LLM routing is handled natively by the bundled `dsh-llm` plugin (`settings.yaml` + `.credentials.yaml` hot-reload) and SaaS connectors by `dsh-mcp-client`, so the project bundles and deploys no additional gateway or proxy service.

> Running `node server.js` directly also works, but skips the supervisor's config injection and supervision. Use `npm start` for day-to-day work.

### Build resources before packaging

```bash
npm run predist   # download the standalone Node matching your Node version into resources/node/
npm run dist      # then package the installers
```

## Configuration

Everything sensitive lives in **`.env`** and **`mcp.json`** (both gitignored; template is `mcp.example.json`). The server degrades gracefully when optional config is missing — it always starts.

| Variable | Purpose |
|---|---|
| `LLM_API_KEY` / `LLM_BASE_URL` | Default LLM provider (OpenAI-compatible gateway). No key is bundled: with `LLM_API_KEY` unset, the server starts with chat disabled (logged) and everything else keeps working. `LLM_BASE_URL` defaults to the Volces Ark coding endpoint. |
| `DEFAULT_MODEL` | Default chat model (must be one of the model ids declared in `dsh-profile.js`). |
| `ASSISTANT_NAME` | Display name of the built-in agent persona (default "Platform"). |
| `PORT` / `HOST` | Bind address (default `3000` / `localhost`). |
| `PLATFORM_DATA_DIR` | Root for all on-disk stores (SQLite, sessions, cron). |
| `RESOURCES_STORAGE_PATH` | Override for the resource library's store dir (default `PLATFORM_DATA_DIR/resources-store`). |
| `RESOURCE_MAX_FILE_BYTES` | Per-file byte cap for saved resources (default 20MB); lower it to match a client platform's download limit. |
| `AUTH_MODE` | Login mode: unset for open access, `forward_auth` for trusted proxy headers, or `logto` for Logto OIDC login. |
| `PAAS_BASE_URL` | Public callback base URL for Logto; derived from request `Host` when unset. |
| `SESSION_SECRET` | Session signing secret; auto-generated and persisted under `PLATFORM_DATA_DIR/auth/session-secret` when unset. |
| `SESSION_TTL_HRS` | Session TTL (default 24 hours), with sliding renewal for active sessions. |
| `LOGTO_ENDPOINT` / `LOGTO_APP_ID` / `LOGTO_APP_SECRET` | Logto OIDC settings; web uses a confidential client and desktop uses a public/PKCE client. |
| `LOGTO_CLIENT_TYPE` | `confidential` (default) or `public`; set to `public` for desktop. |
| `LOGTO_END_SESSION` | Set to `true` to chain logout through Logto end-session. |
| `DESKTOP_SERVER_PORT` | Desktop fixed port (default 47600) for `http://127.0.0.1:47600/auth/callback`. |
| `SSO_ENABLED` | Only meaningful with `AUTH_MODE=none`: layers an **optional** sign-in entry on top of open access (anonymous use keeps working). Once signed in, a per-email preference records the user's model and MCP availability overlay, applied when the shared runtime is idle. **Not multi-tenant isolation** — chat, sessions, documents and the runtime stay shared. Requires the proxy to let anonymous requests reach the app while still injecting identity for signed-in ones, and the app must be reachable only through that proxy (the identity header is otherwise forgeable). |
| `AGENTS_CONFIG_URL` / `CATALOG_REFRESH_SECS` | Cloud JSON for agent/app catalog, refreshed every N seconds (default 60). |
| `NANGO_SECRET_KEY` | Server-side Nango secret for connect sessions (never sent to browser). |
| `DOCUMENTS_MODEL` | Documents RAG model (default `deepseek-v4-pro`). |
| `MARKET_REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` | Wire in a self-hosted [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry): its MCP servers, skills (content fetched at install time), and agents appear in the extension market and agent catalog. Group visibility comes from a local `registry-groups.json` (gitignored); without a URL only the bundled catalog is used. |
| `MARKET_REGISTRY_LOGIN_PATH` / `MARKET_REGISTRY_CSRF_PATH` / `MARKET_REGISTRY_TOKENS_PATH` | Registry routes the connect flow uses: its login page and the personal-token mint (defaults `/login`, `/api/auth/csrf-token`, `/api/tokens/generate`). Override them when a registry version moves a route — no code change needed. |
| `MARKET_REGISTRY_TTL_SECS` | Registry snapshot refresh interval in seconds (default 300). |
| `BOTS_RELAY_TOKEN` | Machine-caller channel (cloud MCP services → chat-platform bots): `POST /api/bots/relay/send` authenticates with this bearer token and can only deliver to channels an operator pre-bound (`/api/bots/channels`; a channel binds to a chat that has messaged the bot). Unset (default) makes the route answer 404 — the feature is off. The token must only travel over a network you trust (loopback/LAN, or a TLS ingress you front yourself). |

Want a self-hosted LLM proxy or a SaaS-connector gateway? Run it yourself and wire it in as an MCP server (`mcp.json`) or as an `external-service` entry in the catalog — the project ships neither.

### Logto login configuration

Register two applications in the Logto console and enable organizations / organization roles in ID tokens:

1. Web confidential client: redirect URI `https://<host>/auth/callback`, with `AUTH_MODE=logto`, `LOGTO_ENDPOINT`, `LOGTO_APP_ID`, and `LOGTO_APP_SECRET`.
2. Desktop public client: redirect URI `http://127.0.0.1:47600/auth/callback`, with `LOGTO_CLIENT_TYPE=public`, `DESKTOP_SERVER_PORT=47600`, and `SESSION_TTL_HRS=720`. The desktop installer contains no client secret and uses PKCE S256.

The packaged desktop app injects backend configuration from `app.getPath("userData")/settings.json`. At minimum, provide the Logto tenant endpoint and public client id; never put `LOGTO_APP_SECRET` in desktop settings:

```json
{
  "AUTH_MODE": "logto",
  "LOGTO_ENDPOINT": "https://<logto-tenant>",
  "LOGTO_APP_ID": "<desktop-public-client-id>",
  "LOGTO_CLIENT_TYPE": "public",
  "SESSION_TTL_HRS": "720",
  "DESKTOP_SERVER_PORT": "47600"
}
```

`AUTH_MODE=logto` does not support a first login while offline: Logto discovery and JWKS must be reachable during startup or the backend will not start. An existing unexpired session remains usable while the process is running, but new logins, callbacks, and end-session redirects still require the network. Unset `AUTH_MODE` to restore open access.

Organization names become groups; role short names from `organization_roles` are added too, so `<org>:admin` maps to `admin`. Enable `organizations` and `organization_roles` in the Logto application's ID token (or equivalent custom claims), and allow the organizations scope requested by Platform. Platform reads only those two claim names. Administrative access requires the exact role short name `admin`, because catalog filtering and the admin gate match that name.

### Hosted deployment (the cell run contract)

A cloud deployment puts each user in a separate **cell**: one `server.js` process, its own dsh runtime, its own data directory. No mutable state crosses cells, so isolation comes from the process boundary rather than from multi-tenant logic inside the app; the desktop app and `npm start` are the single-cell form of the same thing.

The per-cell env matrix (`PLATFORM_DATA_DIR`, `DSH_HOME`, `MCP_CONFIG_PATH`, `PORT`, `HOST`, `AUTH_MODE=forward_auth`, `CLOUD_MODE=1`, `CELL_GATEWAY_SECRET`) and the two hard rules — bind loopback only, and keep cell data on local disk because every store is SQLite + WAL and SQLite over NFS corrupts — are documented in the "Hosted cells" section of `.env.example`, together with a complete two-cell worked example.

## Architecture

- **`server.js`** — Express + WebSocket orchestrator; spawns dsh, translates events, broadcasts to clients.
- **`dsh-bridge.js`** — dsh runtime bridge (stdio JSON-RPC child process).
- **`dsh-profile.js`** — writes dsh profile (`settings.yaml`, MCP patch, skills patch).
- **`documents.js`** — first-party document RAG (LlamaIndex.TS + PageIndex + SQLite).
- **`chat-history.js`** — read-only chat persistence (mirrors each turn to SQLite).
- **`resources.js`** — first-party resource library: charts generated in chat are captured automatically (```echarts fences) and users can save workspace files; bytes live under `resources-store/` and are served read-only via `/api/files?root=resources`.
- **`server/routes/external-services.js`** — `/external/:appId` reverse proxy for catalog `external-service` apps. **Tokens stay server-side.**
- **`gateway/`** — hosted identity gateway: fronts one per-user cell per login identity (spawn, supervise, route).
- **`agent-runner/`** — deploys a pack persona as a standalone A2A conversational agent service.
- **`electron/`** — desktop supervisor (process management only).
- **`web/`** — web frontend (Vite + React 19 + TypeScript + Tailwind v4 + shadcn). Routes: `/chat`, `/knowledge`, `/resources`, `/agents`, `/bots`, `/trace`, `/tasks`, `/external/:appId`, and public `/share/:token`.
- **`miniapp/`** — WeChat mini-program thin client (Taro 4 + React) over the same WS/REST contracts.
- **`packages/core`** — shared core (WS message contract, stores) used by both `web/` and `miniapp/`.
- **`skills/`** — local skills (`SKILL.md`), invoked via `/skill:<name>`.
- **`openspec/specs/`** — the ~90 capability specs that govern this codebase; the WS message contract there is binding.

## How to add an MCP server

No code changes — edit `mcp.json` (copy `mcp.example.json` to create):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "remote-http": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}
```

Restart the server. Tools are exposed as `mcp__<serverName>__<toolName>`.

Full step-by-step guide: [`docs/packaging-extensions.md`](docs/packaging-extensions.md).

## How to add a skill

Create `skills/<name>/SKILL.md`:

```markdown
---
name: my-skill
description: One-line description.
---

# My Skill

Body content, expanded when invoked.
```

Restart and invoke via `/skill:my-skill <args>`. Template: `skills/example-skill/SKILL.md`.

## How to package the desktop app

```bash
npm run predist   # build packaging resources (standalone Node)
npm run dist      # electron-builder → .dmg (mac) / .exe (win)
npm run start:electron  # desktop dev mode
```

Outputs: `dist/Platform-<version>-arm64.dmg` (mac), `Platform Setup <version>.exe` (win x64).

## Building installers / releases

**CI** (`.github/workflows/release.yml`) builds on a 3-entry matrix (`macos-latest` arm64, `macos-latest` x64, `windows-latest` x64):

- **Release:** push a `v*` tag (`git tag v1.0.0 && git push --tags`).
- **On-demand:** Actions → "Run workflow".
- **Signing:** gated on GitHub secrets; unsigned builds still succeed.

### Installers are unsigned — how to open them

Releases currently ship **unsigned** installers (code signing is not configured). Your OS will warn on first launch; the installers are the exact artifacts CI built from this repository's tag:

- **macOS Gatekeeper:** right-click the app → *Open* → *Open* in the dialog; or System Settings → *Privacy & Security* → *Open Anyway*; or remove the quarantine bit before first launch: `xattr -dr com.apple.quarantine /Applications/Platform.app`.
- **Windows SmartScreen:** click *More info* → *Run anyway* in the blue dialog.

Download installers from the [download band on the product page](https://www.finddatatech.cloud/products/base) (official direct link + GitHub Releases mirror), which carries the same guidance.

## DeepSeek Harness (dsh)

Platform runs on **DeepSeek Harness (dsh)**, a subprocess runtime that executes the dsh CLI via stdio JSON-RPC.

- **Core change:** migrated from `@earendil-works/pi-coding-agent SDK` to dsh.
- **Session model:** dsh persists sessions on disk; memory no longer keeps messages (`buildSessionContext()` returns empty), so `chat-history.js` reads from SQLite.
- **MCP integration:** `dsh-mcp-client` plugin auto-allows all declared tools; no manual allowlist needed.
- **Model switching:** dsh locks the model at `initialize`; switching requires restarting the session (`dshBridge.restart`).

More details in [`openspec/specs/model-selection/`](openspec/specs/model-selection/) and [`openspec/specs/dsh-runtime-bridge/`](openspec/specs/dsh-runtime-bridge/).

## License

[MIT](LICENSE) © 2026 FindData Technology.

---

FindData · [Base line (寻数·壹座)](https://www.finddatatech.cloud/products/base) · [www.finddatatech.cloud](https://www.finddatatech.cloud)
