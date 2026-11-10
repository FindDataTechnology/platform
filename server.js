import 'dotenv/config';
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import multer from "multer";
import compression from "compression";
import * as chatHistory from "./chat-history.js";
import * as documents from "./documents.js";
import * as resources from "./resources.js";
import * as db from "./db.js";
import * as trace from "./server/trace.js";
import { startUsagePruneTimer } from "./server/usage-telemetry.js";
import * as bots from "./server/bots.js";
import { attachCronRunner } from "./server/cron-runner.js";
import * as migrate from "./migrate.js";
import * as cron from "./cron.js";
import * as extensionStore from "./extension-store.js";
import * as catalog from "./catalog.js";
import { initRegistryBridge, stopRegistryBridge } from "./registry-bridge.js";
import { resolveBundleSafe } from "./bundle-manifest.js";
import { createAppContext } from "./server/context.js";
import { registerAuth, normalizeAuthPath } from "./server/auth.js";
import { createLogtoAuth } from "./server/logto-auth.js";
import { resolveSessionSecret } from "./server/session.js";
import { createMpAuth } from "./gateway/mp-auth.js";
import { createAppAuth } from "./gateway/app-auth.js";
import { createMpBindings } from "./gateway/mp-bindings.js";
import { storeDir } from "./paths.js";
import { cellMemoryConfig, memberTokenFor } from "@finddatatechnology/yongyi-client";
import { registerDocumentRoutes } from "./server/routes/documents.js";
import { registerMiscRoutes, registerStaticAndFallback } from "./server/routes/misc.js";
import { registerLlmRoutes } from "./server/routes/llm.js";
import { registerExtensionRoutes } from "./server/routes/extensions.js";
import { registerChatHistoryRoutes } from "./server/routes/chat-history.js";
import { registerTraceRoutes } from "./server/routes/trace.js";
import { registerUserBindingRoutes } from "./server/routes/user-bindings.js";
import { registerCronRoutes } from "./server/routes/cron.js";
import { registerTaskRoutes } from "./server/routes/tasks.js";
import { registerWanxingFleetRoutes } from "./server/routes/wanxing-fleet.js";
import { convergeLocalCluster, createLocalAgentFeed, LOCAL_FEED_BASE } from "./server/local-agent-feed.js";
import { registerDelegationRoutes } from "./server/routes/delegation.js";
import { registerFleetArchitectRoutes } from "./server/fleet-architect.js";
import { attachDelegationAggregator } from "./server/delegation-aggregator.js";
import { attachWorkerPool } from "./server/worker-slots.js";
import { attachMcBridge } from "./server/mc-bridge.js";
import { registerMpRoutes } from "./server/routes/mp.js";
import { registerAppRoutes } from "./server/routes/app.js";
import { createCellReportDoor, createDesiredFleetDoor } from "./gateway/cell-report.js";
import { createFleetMachinesStore } from "./gateway/fleet-machines-store.js";
import { registerFleetMachineRoutes } from "./gateway/fleet-machines-routes.js";
import { startDesiredMergeLoop } from "./server/fleet-desired-merge.js";
import { registerRegistryRoutes } from "./server/routes/registry.js";
import { registerConnectorRoutes } from "./server/routes/connector.js";
import { registerConnectorBindingRoutes } from "./server/routes/connector-bindings.js";
import { registerFacetMarketRoutes } from "./server/routes/facet-market.js";
import { registerLineCredentialRoutes } from "./server/routes/line-credentials.js";
import { registerChatwootCredentialRoutes } from "./server/routes/chatwoot-credentials.js";
import { registerDeskEmbedRoutes } from "./server/routes/desk-embed.js";
import { registerPaperTradingRoutes } from "./server/routes/paper-trading.js";
import { registerCiyuanAccountRoutes } from "./server/routes/ciyuan-account.js";
import { registerVoiceRoutes } from "./server/routes/voice.js";
import { registerPackUsageRoutes } from "./server/routes/pack-usage.js";
import { registerFileRoutes } from "./server/routes/files.js";
import { registerResourceRoutes } from "./server/routes/resources.js";
import { registerMemoryRoutes } from "./server/routes/memory.js";
import { registerBotRoutes, WEBHOOK_PREFIX } from "./server/routes/bots.js";
import { registerBotRelayRoutes, RELAY_PREFIX } from "./server/routes/bot-relay.js";
import { createClusterRoutes, startAutoTerminationJob } from "./server/routes/clusters.js";
import { createFleetRoutes, resolveFleetTarget } from "./server/routes/fleets.js";
import { registerPackAuthorRoutes } from "./server/pack-author.js";
import { createSkillEvolutionRoutes } from "./server/skill-evolution-routes.js";
import { createPersonaEvolutionRoutes } from "./server/persona-evolution-routes.js";
import { getFleetDatabase } from "./server/routes/fleets-db.js";
import { reconcileAllFleets, deriveMemberStatus } from "./server/fleet-reconcile.js";
import { buildFleetContext } from "./server/fleet-context.js";
import { derivedReportFromTask, fleetIdentityFor, fleetModelFor } from "./server/fleet-reports.js";
import { renderChatFleetContext } from "./server/fleet-chat-context.js";
import { recordTurnEvent } from "./server/fleet-events.js";
import { setEffortDeclarations } from "./server/fleet-model.js";
import { createFleetTurnLedger } from "./server/fleet-runs.js";
import { fleetMemoryFor, createFleetMemoryCapture, createHealthFlipTracker } from "@finddatatechnology/yongyi-client";
import { igniteFleetEdges } from "./server/fleet-handoffs.js";
import { triggerFleetEventWake } from "./server/fleet-event-wake.js";
import { readSignalPolicy, revalidateMandate, recordDisposition } from "./server/fleet-turn-mandate.js";
import * as engine from "./task-engine.js";
import { renderDecisionSegment } from "./server/fleet-decisions.js";
import { runDueDeputyDigests } from "./server/fleet-delegation-digest.js";
import { runDueDigests } from "./server/fleet-digest.js";
import { memoryRefClientFor } from "./server/memory-refs.js";
import { rosterPresetId } from "./dsh-profile.js";
import * as lineTokenRenewal from "./server/line-token-renewal.js";
import * as lineCredentialsLib from "./line-credentials.js";
import { createCredentialDelivery } from "./server/dsh-mcp-delivery.js";
import { buildLaneLookup } from "./server/llm-lane.js";
import * as turnPricing from "./server/turn-pricing.js";
import { createMonitoringRoutes } from "./server/routes/monitoring.js";
import { createAdminRoutes } from "./server/routes/admin.js";
import { registerExternalServiceRoutes } from "./server/routes/external-services.js";
import { registerPackRoutes as registerCellPackRoutes } from "./server/routes/packs.js";
import { registerBindingMintRoutes } from "./server/routes/binding-mint.js";
import { createTrialExecRoutes } from "./server/routes/trial-exec.js";
import { registerOverlayRoutes } from "./server/routes/overlay.js";
import { registerCustomPresetRoutes } from "./server/routes/custom-presets.js";
import { registerPluginSupplyRoutes } from "./server/routes/plugin-supply.js";
import { createPackRegistry, registerPackRoutes as registerMarketPackRoutes } from "./gateway/packs.js";
import { attachDshEvents } from "./server/dsh-events.js";
import { attachRuntimeBindings } from "./server/runtime-bindings.js";
import { attachAgentSession, resolveBootWorkspace } from "./server/agent-session.js";
import { attachTurnDispatch } from "./server/turn-dispatch.js";
import { attachWebSocket } from "./server/ws.js";
import { matrixGate } from "./lib/dsh-matrix-verify.js";
import { registerActionsRoutes } from "./server/routes/actions.js";
import { startActionExpiryJob } from "./lib/action-expiry.js";
import { recordRejection, prune, summarizeRejections } from "./lib/report-rejection-log.js";
import { registerBoardRoutes } from "./server/routes/boards.js";
// ERP 纵向 REST 服务面同源代理（add-erp-supply-chain-gateway-proxy）：
// 客户端 X-ERP-* 一律剥离、服务端按会话注入、无会话 401（fail-closed）。
import { ERP_PROXY_PREFIX, registerErpProxyRoutes } from "./server/routes/erp-proxy.js";

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "localhost";
const MCP_CONFIG_PATH = path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");

// ── Optional forward-auth (AUTH_MODE=forward_auth) ───────────────────────────
// Identity = proxy-injected X-Forwarded-Email / X-Forwarded-Groups headers
// (Caddy forward_auth → oauth2-proxy → Logto). TRUST BOUNDARY: enabling this
// asserts the server is reachable ONLY through the forward-auth proxy — bind
// to localhost / firewall it, otherwise these headers are attacker-controlled.

// ── Custom provider config (Volces / 火山引擎) ────────────────────────────────

// Volces (火山引擎) chat provider is optional: an unset LLM_API_KEY means the
// provider is not registered and the server starts with no chat provider (chat
// non-functional, logged) — the project's graceful-degrade convention.
// The document library no longer consumes any LLM provider config (local
// extraction only); LLM_API_KEY here feeds chat exclusively.

// Default chat model. When set, the dsh session starts on this model id;
// otherwise the first declared profile model is used. See initDshAgent().

// LiteLLM proxy removed — dsh-llm manages LLM natively via settings.yaml +
// .credentials.yaml hot-reload (no child process, no management-UI reverse
// proxy). The dsh LLM profile (dsh-profile.js writeLlmProfile, loaded from .env
// by dotenv/config above) now writes only the Volces route; chat falls back to
// the Volces gateway (when LLM_API_KEY is set) or starts with no chat provider
// (logged, graceful degrade).

// ── Bundle manifest (packaged component selection + pre-installed extensions) ─
// Resolved once at startup. In the packaged app platform.bundle.json sits next
// to this file (Resources/app/); in dev it is the repo root. resolveBundleSafe
// never throws — a corrupt manifest falls back to all-components defaults.
const bundle = resolveBundleSafe();

const app = express();
const server = http.createServer(app);
// noServer + manual handleUpgrade so WS upgrades pass the same forward-auth
// gate as HTTP requests (missing identity ⇒ handshake rejected with 401).
//
// permessage-deflate: the transcript first frame is a JSON blob dominated by
// collapsed tool payloads (a 50-turn window measured 1.0–1.35 MB, of which
// 99.2% is `blocks` the UI renders folded). Compression is negotiated by the
// browser natively and relayed opaquely by the gateway's byte pipe, so the
// payload shrinks on the wire with no protocol or client change. The
// threshold skips small frames (no zlib context is created for them);
// no-context-takeover bounds per-connection memory.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold: 1024,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
  },
});

// Shared application context: config + services + agent-session state.
// Every handler below reads/writes through ctx (see server/context.js).
const ctx = createAppContext({
  PORT,
  HOST,
  AUTH_MODE: process.env.AUTH_MODE || "none",
  SSO_ENABLED: process.env.SSO_ENABLED === "true",
  // Hosted-cell mode. Set by the cloud gateway's spawner, never by a human:
  // it turns on the active identity-trust gate in server/auth.js (see
  // CLOUD_MODE / CELL_GATEWAY_SECRET in .env.example).
  CLOUD_MODE: process.env.CLOUD_MODE === "1" || process.env.CLOUD_MODE === "true",
  CELL_GATEWAY_SECRET: process.env.CELL_GATEWAY_SECRET || "",
  // Accountless demo sandbox (openspec: mp-demo-sandbox): a dedicated
  // deployment-wide mode — every connection is demo-capped, uploads are
  // rejected and chat sessions are wiped periodically. Never set on the
  // account deployment.
  DEMO_SANDBOX: process.env.DEMO_SANDBOX === "true",
  DEMO_SANDBOX_WIPE_SECS: Number(process.env.DEMO_SANDBOX_WIPE_SECS || 7200),
  AUTH_LOGIN_PATH: normalizeAuthPath(process.env.AUTH_LOGIN_PATH, "/oauth2/start"),
  AUTH_LOGOUT_PATH: normalizeAuthPath(process.env.AUTH_LOGOUT_PATH, "/oauth2/sign_out"),
  PAAS_BASE_URL: process.env.PAAS_BASE_URL || "",
  LOGTO_ENDPOINT: process.env.LOGTO_ENDPOINT || "",
  LOGTO_APP_ID: process.env.LOGTO_APP_ID || "",
  LOGTO_APP_SECRET: process.env.LOGTO_APP_SECRET || "",
  LOGTO_CLIENT_TYPE: process.env.LOGTO_CLIENT_TYPE || "confidential",
  LOGTO_END_SESSION: process.env.LOGTO_END_SESSION || "false",
  SESSION_TTL_HRS: process.env.SESSION_TTL_HRS || "24",
  resolveSessionSecret: () => resolveSessionSecret({ env: process.env }),
  LLM_API_KEY: process.env.LLM_API_KEY?.trim(),
  LLM_BASE_URL: process.env.LLM_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3",
  DEFAULT_MODEL: process.env.DEFAULT_MODEL || "",
  bundle,
});
ctx.app = app;
ctx.server = server;
ctx.wss = wss;
ctx.upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Document collection: JSON bodies for text/url submissions; multipart file
// uploads are kept in memory (LlamaIndex readers read the buffer directly).
// Bot webhooks are excluded: they need the RAW request bytes (WeCom/WeChat send
// XML, and every platform signs the body exactly as sent), so they mount their
// own express.raw parser. Consuming the stream here would leave them with an
// empty body and break signature verification.
// The bot relay is excluded for a different reason: its bearer token must be
// verified before the payload is parsed, so it mounts its own JSON parser
// inside the route, behind that check.
// Pack surfaces (add-packaged-skills) get the raised parser: the in-process
// market's publish route, creator drafts carrying skill packages, and the
// install endpoint's rolling-window body-manifest shape all legitimately
// exceed the default 100kb.
const jsonBodyParser = express.json();
const packJsonBodyParser = express.json({ limit: "24mb" });
const PACK_BODY_PREFIXES = ["/api/packs", "/api/pack-drafts", "/api/mypacks"];
app.use((req, res, next) => {
  if (req.path.startsWith(WEBHOOK_PREFIX) || req.path.startsWith(RELAY_PREFIX)) return next();
  // ERP 代理转发的是「原始请求」：body 若先被 json parser 吃掉，代理只能拿到
  // 重新序列化的对象（丢字节、丢重复键）。故该前缀跳过解析，由 erp-proxy.js
  // 自己读原始流（add-erp-supply-chain-gateway-proxy）。
  if (req.path.startsWith(ERP_PROXY_PREFIX)) return next();
  const parser = PACK_BODY_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"))
    ? packJsonBodyParser
    : jsonBodyParser;
  parser(req, res, next);
});
// HTTP compression for static assets + API JSON (the entry chunk ships ~600KB
// raw). Must mount before express.static (registered in routes/misc.js).
app.use(compression());

// Forward-auth/Logto HTTP gate + ctx.requireAdmin (WS upgrade gate below).
// Mini-program identity (openspec: miniprogram-auth) — the same bind-code
// path the gateway serves, shared modules imported verbatim. Inert until
// MP_APPID/MP_SECRET/MP_TOKEN_SECRET are set: login endpoints report
// not-configured and Bearer tokens never verify, so browser flows are
// unchanged. Bindings persist in this deployment's data dir, same file
// format as the gateway's <CELL_DATA_ROOT>/mp-bindings.json.
ctx.mpBindings = createMpBindings({ file: path.join(storeDir("data"), "mp-bindings.json") });
await ctx.mpBindings.load();
ctx.mpAuth = createMpAuth({
  appid: process.env.MP_APPID || "",
  mpSecret: process.env.MP_SECRET || "",
  tokenSecret: process.env.MP_TOKEN_SECRET || "",
  ttlHours: Number(process.env.MP_TOKEN_TTL_HOURS || 12),
  codeUrl: process.env.MP_JS_CODE_URL || "https://api.weixin.qq.com/sns/jscode2session",
  bindings: ctx.mpBindings,
  // Demo mode stays gateway-only even if MP_DEMO_MODE leaks into this env: a
  // single-process deployment has ONE shared runtime, so an anonymous demo
  // identity would land in the owner's data (openspec: mp-demo-mode —
  // self-hosted deployments never serve anonymous WeChat users).
  demoMode: false,
});
// App device pairing (openspec: add-device-pairing-auth) — the universal
// client's identity path, same shared module as the gateway. Shares the
// binding store, bind-code pool and token secret with the mini program; an
// app Bearer token verifies exactly like an MP token. Inert until
// MP_TOKEN_SECRET is set.
ctx.appAuth = createAppAuth({
  tokenSecret: process.env.MP_TOKEN_SECRET || "",
  ttlHours: Number(process.env.MP_TOKEN_TTL_HOURS || 12),
  bindings: ctx.mpBindings,
});
ctx.logtoAuth = await createLogtoAuth(ctx);
ctx.logtoAuth?.register(app);
registerAuth(ctx);

// Route registration. Order is semantic: app /api routes first, then the
// static SPA + deep-link fallback and /external/:appId.
registerDocumentRoutes(ctx);
// ERP 代理必须早于静态 SPA 兜底（registerMiscRoutes 里挂 express.static +
// 深链 fallback）：否则 GET /erp/... 会被前端 fallback 抢走返回 index.html。
// 它自带会话闸（无会话 401），不依赖全局闸对 /erp 的判断。
registerErpProxyRoutes(ctx);
registerMiscRoutes(ctx);
// Credential-owner door for deployment bindings (fix-deploy-binding-mint-process):
// registered before the SPA fallback like every other /api family. In the split
// topology the gateway forwards here; single-process deployments never see it.
registerBindingMintRoutes(app);
registerLlmRoutes(ctx);
registerExtensionRoutes(ctx);
registerChatHistoryRoutes(ctx);
registerTraceRoutes(ctx);
registerUserBindingRoutes(ctx);
// Cron REST bridge (loopback MCP child; clients use the WS cron_* messages).
registerCronRoutes(ctx);
// Action gate routes (add-line-boards-and-action-gate): propose/approve/reject/query.
registerActionsRoutes(ctx);
// Action expiry sweeper (24h fail-closed, broadcast action_expired).
startActionExpiryJob(ctx);
// Board routes (add-line-boards-and-action-gate): GET /api/boards/:line.
registerBoardRoutes(ctx);
// Task stats lane (unify-wanxing-management-plane): read-only counts for the
// gateway's fleet relay; standard cell auth, no loopback exemption.
registerTaskRoutes(ctx);
// Desktop fleet console lane (add-desktop-fleet-console): local runner live
// snapshot + public registry catalog, both proxied behind standard cell auth.
registerWanxingFleetRoutes(ctx);
// Local roster feed (add-local-fleet-control-plane): registry-shaped entries
// composed from this machine's deployments × installed packs, so the LOCAL
// agent-runner polls its roster from loopback instead of the public registry.
// Own Bearer (WANXING_LOCAL_FEED_TOKEN); mounted outside /api so the session
// gate never sees it (see AUTH_EXEMPT_PREFIXES).
ctx.app.use(
  LOCAL_FEED_BASE,
  createLocalAgentFeed({ env: ctx.env ?? process.env, runnerId: process.env.WANXING_PLUGIN_RUNNER_ID ?? null }),
);
// Convergence on boot (add-desktop-residency-hardening 4.x): the cell is what
// the resident steward starts, so a login / wake / post-update restart lands
// here — and the local cluster is put back on its declared state (orphan
// deployments pruned, the expectation re-derived) before the runner polls it.
convergeLocalCluster({ env: ctx.env ?? process.env });
// Desired-state merge + detail beacon (add-unified-fleet-console): the cell's
// single-writer merge of the steward's desired beacon, plus the detail beacon
// the steward relays as cell_detail. Degrade-open; no-op without a data dir.
startDesiredMergeLoop({ env: ctx.env ?? process.env });
// Delegation REST bridge (loopback delegation MCP child; manual-trigger tasks).
registerDelegationRoutes(ctx);
registerFleetArchitectRoutes(ctx);
// Mini-program identity endpoints (bindcode mint / login / login-bindcode /
// unbind) — mounted with the other /api routes, before the static SPA fallback.
registerMpRoutes(ctx);
// App device-pairing endpoints (pair / challenge / login / devices / revoke).
registerAppRoutes(ctx);
// Steward doors + machines console (add-unified-fleet-console): single-process
// deployments mount the same shared doors the gateway serves — reporting
// (presence/manifest/detail) and the self-scoped desired-state pull — plus the
// web machines routes. The store rides the same JSON-file convention as
// mp-bindings.json in this deployment's data dir.
{
  ctx.fleetMachinesStore = createFleetMachinesStore({ file: path.join(storeDir("data"), "fleet-machines.json") });
  await ctx.fleetMachinesStore.load();
  const cellReportDoor = createCellReportDoor({ appAuth: ctx.appAuth, machines: ctx.fleetMachinesStore });
  app.post("/api/gateway/cell-report", (req, res) => void cellReportDoor.handle(req, res));
  const desiredFleetDoor = createDesiredFleetDoor({ appAuth: ctx.appAuth, machines: ctx.fleetMachinesStore });
  app.get("/api/gateway/desired-fleet", (req, res) => void desiredFleetDoor.handle(req, res));
  registerFleetMachineRoutes({
    app,
    appAuth: ctx.appAuth,
    machines: ctx.fleetMachinesStore,
    callerEmail: (req) =>
      req.user?.email ??
      ctx.appAuth.accountFromToken(String(req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : "")?.email ??
      // Auth-off (desktop / standalone) has no req.user: the requester IS the
      // machine owner — the same convention requireAdmin and the market routes
      // above already use. Without it the whole machines surface 401s on every
      // desktop install, which is this console's primary consumer.
      (ctx.authEnabled ? null : ctx.cellUserEmail || "owner@local"),
    isAdmin: (req) => (ctx.authEnabled ? (ctx.isAdminUser ? ctx.isAdminUser(req.user ?? {}) : false) : true),
  });
}
registerRegistryRoutes(ctx);
registerPackUsageRoutes(ctx);
// 萬星 connector PAT (connector-credentials) — same route family as the
// registry credential endpoints.
registerConnectorRoutes(ctx);
// Connector BINDINGS (add-connector-bindings): the per-binding status face, the
// declarative one-dialog grant, the progressive grant-off-a-rejection, revoke.
registerConnectorBindingRoutes(ctx);
// Dynamic cluster management (agent-cluster-platform): REST API for creating,
// managing, and operating dynamic agent clusters assembled from pack agents.
createClusterRoutes(app, ctx);
// Agent fleets (agent-fleet-core): fleet/post CRUD + materialization
// reconcile over the task engine. Same auth semantics as clusters.
createFleetRoutes(app, ctx);
// Blueprint studio routes RETIRED (add-supply-studio-migration 4.6, W2): the
// creation surface moved to the facet host (facet/studio.js mounts the same
// modules there). 壹座 keeps only the promotion channel (fleets /promote) and
// the fleet-detail source chip; the blueprint-author bridge retired with the
// endpoints (the pack-author bridge is unmounted separately per d5784e8e).
registerPackAuthorRoutes(app, ctx);
// Skill self-evolution (add-skill-self-evolution): the propose face for the
// in-cell MCP child (loopback bridge) + the owner's evaluate/promote/reject
// REST face. Candidates live outside custom_skills; promotion is the only
// bridge and it is human-only.
createSkillEvolutionRoutes(app, ctx);
// Persona self-evolution (add-persona-self-evolution): the role-bucket twin —
// persona_amend lands candidates; promotion SPLITS (preset materializes, pack
// persona forks); sessions never hot-touch (D4).
createPersonaEvolutionRoutes(app, ctx);
// Cluster monitoring (agent-cluster-platform). The Phase 4/5/8/10 siblings
// this shipped with (model-binding provider routes, the hardcoded template
// "marketplace", the optimization endpoints with fabricated cache metrics)
// were removed 2026-10-21: zero consumers, fabricated data — the cluster
// market is pack cluster metadata (catalog.js), model binding is the deploy
// form's modelOverrides (gateway/packs.js).
createMonitoringRoutes(app);
// The rejection counter lives on ctx (it is written by the report lane); the
// monitoring route reads it through app.locals so the route module needs no
// import cycle back into server.js.
app.locals.reportRejectionStats = () => ctx.reportRejectionStats();
// Admin dashboard (agent-cluster-platform Phase 8)
createAdminRoutes(app);
// 谦面市场设备凭据 (facet-market-credentials, C1.1-B) — same family again:
// pair-by-bind-code, silent relogin, injection via credentialRef.
registerFacetMarketRoutes(ctx);
// 各线操作 MCP 凭据 (line-credentials): wire-customer / lex (browser silent
// mint ID tokens) + wanxing-caller (pasted sk-) — same family.
registerLineCredentialRoutes(ctx);
// 商家 Chatwoot BYOK 凭据（add-crm-desk-pack-embed）：粘贴 token(+嵌入用登录对)。
registerChatwootCredentialRoutes(ctx);
// CRM 客服台嵌入反代（add-crm-desk-pack-embed 6.x）：go 铸发 + 同源代理。
registerDeskEmbedRoutes(ctx);
// 词元账号 (ciyuan-account-lane): zero-paste bind — server-side 词元 login →
// key mint → stored key; serves the cell model lane + the wanxing-caller ref.
registerCiyuanAccountRoutes(ctx);
// 语音车道 (voice-lane): ASR/TTS forwarded to the 词元 audio lane over the
// fixed OpenAI audio protocol; the key follows the model lane (user's bound
// 词元 key first, deployment key second) and never reaches the browser.
registerVoiceRoutes(ctx);
// 柏讯模拟交易 token (paper-trading-credentials) — fourth in the same family:
// paste an fdt_ token, advisory liveness probe, injection via credentialRef.
registerPaperTradingRoutes(ctx);
// The relay must register BEFORE the bots routes: POST /api/bots/relay/send
// would otherwise match POST /api/bots/:id/send with id = "relay", and the
// admin-gated handler there would answer a machine caller.
registerBotRelayRoutes(ctx);
registerBotRoutes(ctx);
// Preview drawer file serving — mounted with the other /api routes, BEFORE the
// static SPA fallback, so the catch-all cannot shadow /api/files.
registerFileRoutes(ctx);
// Resource library (charts + saved files) — same placement rule as /api/files.
registerResourceRoutes(ctx);
// 记忆读面（add-unified-memory-and-outputs 3.3/4.1）：owner 面板 + 部署者视角。
registerMemoryRoutes(ctx);
// Pack marketplace cell side (drafts + subscribe/upgrade/uninstall) — a plain
// /api route family, before the static fallback.
registerCellPackRoutes(ctx);
// Trial-exec service channel (add-supply-studio-migration 5.3): the run-domain
// half of the cross-domain trial lane — facet's Studio trial route forwards
// here over the shared internal credential (x-facet-token); the report returns
// in one body and the doc of record stays on the facet side (D1).
createTrialExecRoutes(app);
// Focus overlay (add-focus-overlay): the 资源微调 panel's GET/PUT — same
// placement rule as the pack routes.
registerOverlayRoutes(ctx);
// Custom presets (add-custom-presets): the 自建预设 roster CRUD — same
// placement rule; rides the serialized runtime-mutation path like packs.
registerCustomPresetRoutes(ctx);
// 素材市场 · 插件页签 (unify-material-market: dsh-plugin-supply MODIFIED,
// plugin-supply-request ADDED): the curated catalogue read plus the 申请供应
// request row. The catalogue is operator-authored data; the roster comes from
// the live dsh inventory. A request writes one JSON row and never installs,
// downloads, or executes a plugin package — supply stays build-time only.
registerPluginSupplyRoutes(ctx);
// Pack marketplace MARKET plane (add-pack-marketplace): browse/publish/
// subscribe records. In the multi-cell gateway topology gateway/index.js
// serves these; a single-process deployment (fd-prod) has no gateway process,
// so the same module mounts here behind the feature flag — the mp-auth reuse
// pattern (gateway module imported verbatim). The auth gate above has already
// resolved req.user or answered 401 by the time these routes run; with auth
// off the requester is the machine owner (same semantics as requireAdmin and
// market visibility).
let packRegistry = null;
if (process.env.PACK_MARKETPLACE === "1") {
  packRegistry = createPackRegistry({ file: path.join(storeDir("data"), "packs.db") });
  // Late-binding seam for the cell routes registered above (they only capture
  // `ctx`): the uninstall route needs the deployment registry to know whether
  // this cell still holds a deployment of the pack before it revokes the
  // deployment's connector tokens (add-deployment-binding-grant 2.3).
  ctx.getPackRegistry = () => packRegistry;
  registerMarketPackRoutes(app, {
    registry: packRegistry,
    resolveUser: (req) =>
      req.user ??
      (ctx.authEnabled
        ? null
        : // E2E_USER_GROUPS is a test seam (agent-service-config e2e): the
          // auth-off machine owner can carry groups so creator-gated real
          // routes (publish) are reachable. Empty by default — production
          // identity never comes from here.
          { email: ctx.cellUserEmail || "owner@local", groups: String(process.env.E2E_USER_GROUPS || "").split(",").map((s) => s.trim()).filter(Boolean) }),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "Authentication required" }),
    creatorGroups: (process.env.PACK_CREATOR_GROUPS || "creators")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  // Manifest source for the cell-side install fetch when NO facet is
  // configured (pack-install-server-side-manifest): the market plane is
  // mounted in THIS process, so the install route resolves the version
  // through the registry's own visibility read — the same function the
  // /api/packs/:id/versions/:version route above serves. `admin: false` is
  // deliberate: this mount registers no admin group (the route above has the
  // same posture), so the fetch admits exactly who the listing admits. With
  // FACET_BASE_URL set (gateway topology) the install fetch goes to facet
  // over the shared proxy channel instead, and this injection stays unused.
  ctx.localPackMarket = {
    getVersion: (packId, version, viewer) =>
      packRegistry.getVersionVisible(packId, version, viewer, { admin: false }),
    // Latest-version lookup for server-driven installs (intent-onboarding): the
    // provisioning action names a pack from the recipe, not a version. Composed
    // from the same registry primitives the market detail route uses, so
    // visibility (private ⇒ owner/admin only) answers identically.
    getLatest: (packId, viewer) => {
      const row = packRegistry.packRowPublic?.(packId);
      if (!row) return null;
      const subscriber = Boolean(viewer?.email && packRegistry.subscription?.(viewer.email, packId));
      const visible = packRegistry.visibleTo?.(
        { visibility: row.visibility, author_email: row.author_email },
        viewer,
        { admin: false },
      );
      if (!visible && !subscriber) return null;
      const detail = packRegistry.get?.(packId, { includeUnlisted: subscriber });
      if (!detail?.version || !detail?.manifest) return null;
      return { version: detail.version, manifest: detail.manifest, pricing: detail.pricing ?? null };
    },
    // 装前闸权益投影的本地证词源（add-market-revenue-share）：与远端
    // /api/packs/:id 的 purchased 同一个 store，只经 fetchMarketDetail 读。
    market: packRegistry.market ?? null,
    // sub2api 余额周期快照读（add-owner-cross-line-view 1.2）：聚合面按 email
    // 读最新快照——同一 registry 单元（同一 packs.db），单一真源零复制。
    billingSnapshots: (email, opts) => packRegistry.billingSnapshots(email, opts),
    // Name lookup for curated recipe references (intent-onboarding): the
    // recipe names a pack by its authored display name because ids are minted
    // randomly per deployment. Goes through the registry's own listing, so the
    // viewer's visibility rules (private ⇒ owner only) answer exactly as the
    // market surface does.
    findByName: (name, viewer) => {
      const listed = packRegistry.list?.({ search: String(name), pageSize: 50, viewer })?.packs ?? [];
      return listed.filter((p) => p?.name === name).map((p) => ({ id: p.id, name: p.name }));
    },
  };
}
registerStaticAndFallback(ctx);
registerExternalServiceRoutes(ctx);

// dsh → WS event translation (attaches ctx.handleDshEvent + ctx.finishTurn).
attachDshEvents(ctx);
attachRuntimeBindings(ctx);
// Agent-session state machine (model/agent switching, session ops, commands).
attachAgentSession(ctx);
// Web-prompt arbiter (concurrent-chat-sessions): one open turn in the shared
// child at a time, queued otherwise. Must attach before the WS layer, which
// routes every prompt through ctx.dispatchTurn.
attachTurnDispatch(ctx);
// WebSocket upgrade gate + connection handler.
attachWebSocket(ctx);

// Dynamic cluster auto-termination (agent-cluster-platform)
startAutoTerminationJob(ctx);

// Demo sandbox only (openspec: mp-demo-sandbox): periodically wipe the shared
// conversation state so visitors never see each other's sessions. The timer
// never interrupts a streaming turn (wipeSandboxSessions skips while busy).
if (ctx.DEMO_SANDBOX) {
  const { wipeSandboxSessions } = await import("./server/sandbox.js");
  const everyMs = Math.max(60, ctx.DEMO_SANDBOX_WIPE_SECS) * 1000;
  const wipe = () =>
    wipeSandboxSessions({
      isStreaming: () => ctx.isStreaming,
      listSessions: () => chatHistory.listSessions(),
      deleteSession: (id) => chatHistory.deleteSession(id),
      startNewSession: () => ctx.startNewSession(),
      currentSessionId: () => chatHistory.currentSessionId(),
    })
      .then((r) => {
        if (r.wiped) console.log(`[sandbox] wiped ${r.wiped} session(s)${r.failed ? ` (${r.failed} failed)` : ""}`);
      })
      .catch((e) => console.warn(`[sandbox] session wipe failed: ${e.message}`));
  setInterval(wipe, everyMs).unref();
}

// ── Agent session ────────────────────────────────────────────────────────────

// Seed startup MCP configs into the extensions DB so the UI "Installed" tab
// shows them. INSERT OR IGNORE preserves user edits. Origins: mcp.json entries
// stay "user" (operator config); manifest mcpServers entries are pre-installed
// by the package ("bundled"). Manifest entries take
// locked/permissions from the permissions map ("mcp:<name>" → { allow, deny,
// locked }). Seeding lives here (not in bootstrap/first-run.js) because
// better-sqlite3 only loads under the Node that runs server.js — the Electron
// main process has a different ABI.
// ponytail: shared by the dsh bridge + extension REST routes (design D4 —
// host-side config sources unchanged); writeMcpPatch reads the DB but does not
// seed it, so the seeding must happen here before the patch is written.
function seedStartupMcpConfigs(mcpJsonServers) {
  if (!db.isDbReady()) return;
  for (const [name, config] of Object.entries(mcpJsonServers)) {
    extensionStore.seedMcpServer({ name, config, enabled: true });
  }
  // One program, one row (2026-11-09): the deployment baseline and the packaged
  // bundle name the actions bridge differently — `actions` in mcp.json,
  // `actions-mcp` in platform.bundle.json — and seeding keys on NAME, so a
  // hosted cell got both. Each dsh then spawned the script twice (~80Mi each),
  // the roster offered `propose_action` under two servers, and the bundle copy
  // carried no ACTIONS_MCP_PROPOSER_EMAIL: its proposals were stored with
  // proposer_email NULL, which the owner check (`userEmail === proposer`) can
  // never approve — a dead end. Skip a bundled entry whose program is already
  // seeded under another ENABLED name; an admin-disabled twin does not block it,
  // otherwise disabling `actions` would leave no path at all.
  const seededRows = extensionStore.listMcpServers();
  for (const [name, entry] of Object.entries(ctx.bundle.mcpServers)) {
    const { enabled = true, ...config } = entry;
    const twin = enabled ? extensionStore.findSameProgram(seededRows, config, { excludeName: name }) : null;
    if (twin) {
      // Skipping the seed is not enough: cells that predate this fix ALREADY
      // carry the duplicate row, and it is the row that spawns the second
      // process. Remove it — but only when the bundle owns it, so a row the
      // operator added by hand is never deleted on their behalf.
      const duplicate = extensionStore.getMcpServer(name);
      if (duplicate?.origin === "bundled") {
        extensionStore.removeMcpServer(name);
        const at = seededRows.findIndex((r) => r.name === name);
        if (at >= 0) seededRows.splice(at, 1);
        console.log(`[mcp] removed duplicate bundled "${name}" (same program as "${twin}")`);
      } else {
        console.log(`[mcp] bundled "${name}" is the same program as "${twin}"; skipping the duplicate`);
      }
      continue;
    }
    // The bundle owns its rows' config (command/args/envRefs drift across
    // releases); seeding alone is skip-if-exists, so a changed bundle would
    // leave a stale row shadowing it forever. Sync bundled-origin configs on
    // startup while preserving the admin's enable/disable choice.
    const existing = extensionStore.getMcpServer(name);
    if (existing?.origin === "bundled" && JSON.stringify(existing.config) !== JSON.stringify(config)) {
      extensionStore.updateMcpServer(name, { config });
    }
    extensionStore.seedMcpServer({
      name,
      config,
      enabled,
      origin: "bundled",
      ...ctx.splitPolicy(ctx.bundle.permissions[`mcp:${name}`]),
    });
    // Keep the view current: a later bundle entry must not re-seed the same
    // program under a third name.
    seededRows.push({ name, config, enabled });
  }
}

// ── dsh runtime path ──────────────────────────────────────────────────────────
// Spawns the dsh subprocess via dsh-bridge.js and presents a minimal session
// shim to the WS handler/cron so the rest of server.js is runtime-agnostic.
// Task 2 fills handleDshEvent with the full dsh→WS event-translation map; for
// now it only emits `done` on turn completion (the 1.5 round-trip placeholder).
async function initDshAgent() {
  const { DshBridge } = await import("./dsh-bridge.js");
  const { writeLlmProfile, writeMcpPatch, writeSkillsPatch, writePresetsPatch, writePermissionsPatch, writeToolSearchPatch, writeChartBindPatch, writeUserQuestionsPatch, writePluginSupplyPatch, writeSaveLibraryPatch, ensureCredentialsStore, ensureDshHome, buildScrubbedEnv, knownPresetIds, DEFAULT_AGENT_PRESET, readPatchAuthorizations, authorizationHeadersChanged } = await import("./dsh-profile.js");

  // Scaffold $DSH_HOME if it is fresh — a hosted cell's per-user home always
  // is, and dsh refuses to boot a profile that was never materialized.
  ensureDshHome();

  // Hosted cells only: the spawner passes the cell's user, whose saved bindings
  // ARE this runtime's configuration. Empty in dev/desktop, where the shared
  // runtime keeps its global default and its overlay-apply path.
  const cellEmail = ctx.CLOUD_MODE ? String(process.env.CELL_USER_EMAIL || "") : "";
  const cellUser = cellEmail && db.isDbReady() ? cellEmail : "";

  // Write the dsh llm-adapter profile BEFORE spawning dsh so the runtime
  // loads the Volces routes at initialize. The generator's declared
  // list IS the dsh model list (no stock listModels RPC); server.js sources
  // the selector from it (Task 3.3). Empty list = dormant (Task 3.6).
  const { providers, models } = await writeLlmProfile();
  ctx.dshModels = models;
  // Lane lookup for the model-lane breaker (fix-fleet-turn-attribution D2):
  // model id → the provider route that serves it → the lane fingerprint. The
  // breaker keys on THIS, so per-agent providers (already expressible in the
  // profile) each get their own circuit with zero semantic change.
  ctx.llmLaneForModel = buildLaneLookup(providers, models);
  // Effort declarations for the resolver (add-agent-config-dims): model id →
  // the levels it accepts. Kept out of fleet-model.js's own imports so that
  // module stays dependency-free and unit-testable.
  setEffortDeclarations(
    Object.fromEntries(models.filter((m) => m.reasoningEfforts?.length).map((m) => [m.id, m.reasoningEfforts])),
  );

  // Seed the dsh-credentials-local store from process.env (design D3) and build
  // a scrubbed child env so the file is the winning key-resolution layer.
  try { await ensureCredentialsStore({ cellOwnerEmail: cellEmail || null }); } catch (e) { console.warn(`[dsh] credentials store init failed: ${e?.message || e}`); }
  const dshChildEnv = buildScrubbedEnv();

  // Seed startup MCP configs into the extensions DB so the UI "Installed" tab
  // shows them (source=startup). writeMcpPatch reads mcp.json directly for the
  // runtime patch but does NOT seed the DB — seeding is UI-only (Task 4.1).
  let dshMcpJson = {};
  try { dshMcpJson = JSON.parse(await readFile(MCP_CONFIG_PATH, "utf8")).mcpServers || {}; } catch {}
  seedStartupMcpConfigs(dshMcpJson);

  // The selected agent mode is a persisted user preference (agent.preset);
  // `standard` until a DB row exists. Validate it BEFORE the child spawns AND
  // before any patch is written: dsh resolves a session's preset at creation
  // (and a vertical-pack agent IS one of these presets), so a stale id — a
  // pack that left the catalog, a preset someone deleted — would fail every
  // new session. The patch writers also derive the resource scope from this
  // preset (add-pack-agent-scoping): a pack persona composes focused with no
  // user action, so a crash-stale full patch cannot survive a restart. A
  // correction is persisted so the picker agrees with the runtime.
  const persistedPreset = ctx.db.getPreference("agent.preset") || DEFAULT_AGENT_PRESET;
  const knownPresets = knownPresetIds();
  ctx.currentPreset = knownPresets.has(persistedPreset)
    ? persistedPreset
    : knownPresets.has(DEFAULT_AGENT_PRESET)
      ? DEFAULT_AGENT_PRESET
      : [...knownPresets][0] || DEFAULT_AGENT_PRESET;
  if (ctx.currentPreset !== persistedPreset) {
    ctx.db.setPreference("agent.preset", ctx.currentPreset);
    console.warn(`[dsh] persisted agent preset '${persistedPreset}' is not available; using '${ctx.currentPreset}'`);
  }
  // A pack agent selection is a preset choice, so the switcher's agent label
  // follows the preset across restarts instead of resetting to `local`.
  ctx.currentAgentId = ctx.catalogAgentForPreset?.(ctx.currentPreset) ?? "local";

  // Write the dsh-mcp-client patch overlay (one loader entry per MCP server
  // from mcp.json + DB). The bridge passes it via --patch;
  // null = no servers configured, flag omitted (Task 4.1/4.2).
  // In a cell the user's saved MCP availability is THE availability (there is
  // no shared runtime for it to be an overlay on), so it is folded into the
  // boot patch rather than left to apply on some later request.
  const cellMcpOverlay = cellUser ? db.getUserMcpBindings(cellUser) : null;
  // Role filtering for the boot patch: the owner's latest observed groups
  // (per-request identity leaves no boot-time state; the snapshot persists
  // it). Missing snapshot (first boot) ⇒ null ⇒ no filtering.
  const cellOwnerGroups = cellUser ? (await import("./server/owner-groups.js")).readOwnerGroups()?.groups ?? null : null;
  // The owner the profile is generated FOR: a cell's single user, or nobody
  // (auth off / shared runtime), where the registry-credential lookup falls
  // back to the machine owner key.
  ctx.runtimeOwnerEmail = cellUser || null;
  ctx.runtimeOwnerGroups = cellOwnerGroups;
  // The effective availability the runtime composes with (truthful for the
  // preset-switch patch rewrite, which reproduces the boot profile).
  ctx.runtimeMcpOverlay = cellMcpOverlay || {};
  // Boot workspace (fix-agent-workspace): AGENT_WORKSPACE pin > persisted
  // current > process.cwd(). fd-prod's /app is root-owned and unwritable —
  // without a pin or a persisted switch every boot lands there and produced
  // files become unservable (/api/files and the resource save both key off
  // the runtime cwd). Rejections log loudly with the fallback actually used.
  const bootWorkspace = await resolveBootWorkspace({
    env: process.env,
    getPreference: db.isDbReady() ? (k) => db.getPreference(k) : null,
  });
  for (const r of bootWorkspace.rejected) console.warn(`[workspace] ${r}; falling back`);
  console.log(`[workspace] boot workspace: ${bootWorkspace.path} (source=${bootWorkspace.source})`);

  let mcpPatchPath = await writeMcpPatch({ mcpOverlay: cellMcpOverlay, userGroups: cellOwnerGroups, ownerEmail: ctx.runtimeOwnerEmail, agentPreset: ctx.currentPreset, workspace: bootWorkspace.path, enrichmentEnabled: db.getPreference("tool.description.enrichment") !== "false" });

  // Shared MCP satellites (share-mcp-satellites-per-cell 2.1): with a worker
  // pool this cell runs MORE than one dsh runtime, and every runtime used to
  // spawn its own copy of the cell's satellites (13 children, ≈450Mi calibrated
  // each). Start ONE host for the shareable servers, then re-write the patch so
  // each dsh generation attaches by url. TASK_WORKER_MAX=0 skips this entirely —
  // that is both the byte-identical path and the rollback face.
  try {
    const { startCellSatelliteHost } = await import("./server/mcp-satellite-wiring.js");
    const started = await startCellSatelliteHost({
      patchPath: mcpPatchPath,
      poolSize: process.env.TASK_WORKER_MAX,
      cellEmail: process.env.CELL_USER_EMAIL || ctx.runtimeOwnerEmail || null,
    });
    if (started.host && started.url) {
      process.env.MCP_SATELLITE_HOST_URL = started.url;
      ctx.mcpSatelliteHost = started.host;
      mcpPatchPath = await writeMcpPatch({ mcpOverlay: cellMcpOverlay, userGroups: cellOwnerGroups, ownerEmail: ctx.runtimeOwnerEmail, agentPreset: ctx.currentPreset, workspace: bootWorkspace.path, enrichmentEnabled: db.getPreference("tool.description.enrichment") !== "false" });
    } else {
      console.log(`[satellite-host] not sharing satellite processes (${started.reason})`);
    }
  } catch (err) {
    // Fail-open: the patch keeps its stdio entries, exactly the pre-change shape.
    console.error(`[satellite-host] wiring failed, keeping per-dsh satellites: ${err?.message || err}`);
  }

  // Write the skill-filesystem config override (customSkillDirs). The dir
  // list is the resource scope (add-pack-agent-scoping): the writer derives
  // it from the selected preset — focused lists the skills/ baseline plus the
  // pack root; full lists the user root plus every pack root. The
  // materialization dir is rebuilt from the DB first (design D2): DB skills
  // become <name>/SKILL.md files dsh-skill-filesystem Chokidar-watches, so
  // they hot-reload at runtime on CRUD (no restart). Pack rows land in their
  // per-pack root, which also migrates pre-scoping flat installs on this
  // boot (the DB is the durable store — no user action).
  try {
    const { rebuildFromDb, writeSkill } = await import("./skill-materialize.js");
    if (db.isDbReady()) {
      const { failures } = rebuildFromDb(extensionStore.listCustomSkills);
      // Reconciliation pass: retry rows that failed the first write once,
      // then drop still-dirty rows from the materialized set (the DB remains
      // the durable store; the next CRUD or restart re-attempts them).
      if (failures.length) {
        const rows = extensionStore.listCustomSkills().filter((s) => failures.includes(s.name));
        const stillDirty = [];
        for (const s of rows) {
          try { if (!writeSkill(s)) stillDirty.push(s.name); }
          catch (e) { stillDirty.push(s.name); console.warn(`[skills] retry failed for "${s.name}": ${e.message}`); }
        }
        if (stillDirty.length) console.warn(`[skills] materialization still dirty after retry: ${stillDirty.join(", ")}`);
      }
    }
  } catch (e) {
    console.warn(`[skills] materialization dir unavailable: ${e?.message || e}`);
  }
  const skillsPatchPath = await writeSkillsPatch({ agentPreset: ctx.currentPreset });

  // Write the preset-roster patch overlay (agent-presets roster + preset
  // bridge plugin). Null = unresolvable shipped preset root; the bridge then
  // spawns without the overlay and the picker stays empty (graceful degrade).
  const presetsPatchPath = await writePresetsPatch();
  // The permission-mode overlay swaps the bridge row to the subclass that
  // also serves permissions/list + permissions/set (add-permission-mode-
  // selector). Static; always written — an absent permission service inside
  // the child degrades to an empty roster (picker hidden, chat unaffected).
  const permissionsPatchPath = await writePermissionsPatch();
  // The tool-search overlay adds one read-only `tool_search` row
  // (add-tool-discovery-layer). Static; always written — its absence merely
  // removes the search tool, never breaks the runtime.
  const toolSearchPatchPath = writeToolSearchPatch();
  // The chart-bind overlay adds the read-only `chart_bind` row
  // (add-chart-data-binding). Static and always written — its absence merely
  // removes the declared channel, never the runtime.
  const chartBindPatchPath = writeChartBindPatch();
  // The user-questions overlay swaps the server row to the subclass that also
  // registers the ctx.userQuestions provider (add-user-questions, ADR-0012).
  // Static; always written — without it ask_user_question errors NO_PROVIDER.
  const userQuestionsPatchPath = writeUserQuestionsPatch();
  // The save-library overlay adds the `save_to_library` row
  // (add-save-to-library-tool). Static and always written — its absence merely
  // removes the model's explicit save channel, never the runtime.
  const saveLibraryPatchPath = writeSaveLibraryPatch();
  // The plugin-supply overlay swaps the server row to the subclass that also
  // serves plugins/list + plugins/set_enabled over the profile's pluginManager
  // service (add-dsh-plugin-supply). Static; always written — an absent service
  // degrades to an empty roster inside the bridge (Plugins section renders
  // "no bundles supplied", chat unaffected).
  const pluginSupplyPatchPath = writePluginSupplyPatch();

  // Default model: in a cell the user's saved binding wins (it IS this
  // runtime's configuration); otherwise the persisted Models-page pointer,
  // else DEFAULT_MODEL env if declared, else the first declared model.
  let provider = "deepseek-official";
  let model = "deepseek-v4-flash";
  if (ctx.dshModels.length) {
    const llmProviders = await import("./llm-providers.js");
    const saved = llmProviders.getDefault();
    const bound = cellUser ? db.getUserModelBinding(cellUser) : null;
    const boundModel = bound && ctx.dshModels.find((m) => m.id === bound.id && m.provider === bound.provider);
    let pick =
      boundModel ||
      (saved.modelId && ctx.dshModels.find((m) => m.id === saved.modelId)) ||
      (ctx.DEFAULT_MODEL && ctx.dshModels.find((m) => m.id === ctx.DEFAULT_MODEL)) ||
      ctx.dshModels[0];
    // Default-lane guard (add-editable-llm-route, design D5): probe the
    // resolved default before the bridge bakes it into initialize — a dark
    // lane here is the 2026-10-01 outage class (every new session fails its
    // first turn after the re-anchor). Cell bindings are personal choices and
    // stay unguarded in v1 (the open question in the design); every other
    // resolution source passes through. Bounded 10s; inconclusive probes keep
    // the configured default.
    if (!boundModel) {
      try {
        const { guardDefaultLane } = await import("./server/llm-guard.js");
        const guardOutcome = await guardDefaultLane(
          {
            dshModels: ctx.dshModels,
            defaultModel: { id: pick.id, provider: pick.provider, name: pick.name },
            broadcast: () => {},
          },
          { reason: "boot" }
        );
        if (guardOutcome.action === "fell_back") {
          pick = ctx.dshModels.find((m) => m.id === guardOutcome.to) || pick;
        }
      } catch (err) {
        console.warn(`[llm-guard] boot probe skipped: ${err.message}`);
      }
    }
    provider = pick.provider;
    model = pick.id;
    if (boundModel) console.log(`[dsh] cell binding: starting on ${provider}/${model}`);
    // Restore the persisted thinking level, but only if this model still
    // declares it (writeLlmProfile already projected it into settings.yaml).
    const savedEffort = ctx.db.getPreference(`llm.effort.${provider}`) || null;
    ctx.currentEffort = savedEffort && (pick.reasoningEfforts || []).includes(savedEffort) ? savedEffort : null;
  } else {
    console.warn("[dsh] no LLM keys configured; chat non-functional (static + REST still served)");
  }

  ctx.dshSessionId = "platform-" + randomUUID();
  ctx.dshBridge = new DshBridge({
    provider,
    model,
    // Boot-restored thinking depth (add-agent-config-dims): the initialize
    // handshake is the only channel a no-model/set runtime has for it.
    effort: ctx.currentEffort ?? null,
    cwd: bootWorkspace.path,
    onEvent: ctx.handleDshEvent,
    mcpPatchPath,
    skillsPatchPath,
    presetsPatchPath,
    permissionsPatchPath,
    toolSearchPatchPath,
    chartBindPatchPath,
    userQuestionsPatchPath,
    pluginSupplyPatchPath,
    saveLibraryPatchPath,
    agentPreset: ctx.currentPreset,
    env: dshChildEnv,
  });
  // Worker-slot spawn inputs (worker-pool): workers are this exact construction
  // with a different agentPreset and a worker-local event pump (design D1).
  ctx.workerSpawnParams = {
    provider,
    model,
    cwd: bootWorkspace.path,
    mcpPatchPath,
    skillsPatchPath,
    presetsPatchPath,
    permissionsPatchPath,
    toolSearchPatchPath,
    chartBindPatchPath,
    userQuestionsPatchPath,
    pluginSupplyPatchPath,
    saveLibraryPatchPath,
    env: dshChildEnv,
  };
  await ctx.dshBridge.start();
  // Warm the preset roster cache so the ready sync can answer list_presets
  // without a second bridge round-trip (best-effort: empty roster on failure).
  await ctx.getAgentPresets();
  // Same for the permission roster — the connect-time current_permission push
  // needs nothing, but the first list_permissions answer is then immediate.
  ctx.getPermissionPresets().catch(() => {});
  // MCP live-reload (design D1): the REST routes mutate the DB then call this to
  // rewrite mcp.patch.yml in place — cordis-plugin-include/hmr watches that file
  // (confirmed by source inspection; see design Open Question 1) and hot-swaps
  // dsh-mcp-client (disconnect/reconnect the affected server, no process restart).
  // Single-flight mutex + debounce serialize overlapping mutations; restart() is
  // the documented fallback (PLATFORM_MCP_HOTSWAP=0, or hot-swap never settles).
  const hotswapEnabled = process.env.PLATFORM_MCP_HOTSWAP !== "0";
  const HOTSWAP_SETTLE_MS = Number(process.env.PLATFORM_MCP_HOTSWAP_SETTLE_MS || 800);
  // Deterministic credential delivery (add-line-credential-renewal D5, hardened
  // after the fleet-cell incident 2026-10-24 13:46): a renewed credential
  // landing mid-turn must not abort the streaming round, and a restart that
  // collides with one already in flight must RETRY — the incident lost the
  // delivery to a swallowed "dsh restart already in progress" and the child
  // served an expired token until the platform restarted. The controller owns
  // the decision (now / defer to the turn boundary / force past a cap) and
  // logs every branch; the drain hook is exposed for turn boundaries.
  const credentialDelivery = createCredentialDelivery({
    // Shared-child busy (fix-fleet-round-discipline D1): the web live turn
    // alone missed every collector-registered turn on the same child — a
    // credential landing mid-patrol judged the runtime idle and the restart
    // killed the round (production 2026-10-24: 3 of the 9 fleet-round losses).
    // cron/delegation turns register on taskTurnRegistry, bot-relay on
    // sessionCollectors; worker slots run their own bridges and stay out on
    // purpose. maxDeferredMs ≥ the shared child's longest round budget
    // (10min default) — a legal round must never be force-interrupted (D2).
    isStreaming: () =>
      Boolean(ctx.isStreaming) ||
      (ctx.taskTurnRegistry?.size ?? 0) > 0 ||
      (ctx.sessionCollectors?.size ?? 0) > 0 ||
      // Worker slots count too (ledger E28/E30, live 2026-11-09/10): they were
      // left out on purpose because they own their bridges — but the CREDENTIAL
      // restart rebuilds the shared child, and a worker turn that has claimed a
      // slot or is mid-prompt dies with it. Measured: `spawned worker-1 for
      // persona hotel-watch-scout` then `credential change: runtime child
      // restarted` 6s later, and the row still said ok. A busy pool must defer
      // the restart to the turn boundary exactly like the serial lanes do.
      (ctx.workerPool?.poolStats?.()?.busy ?? 0) > 0,
    restart: ({ mcpPatchPath }) => ctx.dshBridge.restart({ mcpPatchPath }),
    maxDeferredMs: 15 * 60 * 1000,
  });
  ctx.drainDeferredCredentialRestart = () => credentialDelivery.drainIfIdle();
  ctx.dshUpdateMcp = (mcpOverlay, userGroups = null, ownerEmail = undefined) => {
    const update = async () => {
      // ownerEmail undefined = "keep whoever the runtime last served" (global
      // routes that do not act for a specific identity); explicit null = the
      // machine owner (auth off).
      if (ownerEmail !== undefined) ctx.runtimeOwnerEmail = ownerEmail;
      // Credential delivery (add-line-credential-renewal D5): snapshot the
      // Authorization headers the running child was spawned against BEFORE the
      // rewrite — the post-write diff separates "credential VALUE changed"
      // (restart: HMR does not deliver header-value changes, production
      // 2026-10-24) from "server SET changed" (HMR keeps working as before).
      const prevPatchPath = ctx.dshBridge?.getMcpPatch?.() ?? null;
      const prevAuth = prevPatchPath ? readPatchAuthorizations(prevPatchPath) : null;
      // The scope filter rides inside the writer keyed off the live preset,
      // so CRUD while focused (add/disable a server, a pack upgrade adding an
      // MCP ref) rewrites the patch focused — the focus survives every
      // mutation without extra bookkeeping (add-pack-agent-scoping D1).
      const patchPath = await writeMcpPatch({ mcpOverlay, userGroups, ownerEmail: ctx.runtimeOwnerEmail, agentPreset: ctx.currentPreset, workspace: ctx.dshBridge?.getCwd?.() ?? null, enrichmentEnabled: db.getPreference("tool.description.enrichment") !== "false" });
      const credentialChanged = Boolean(
        prevAuth && patchPath && authorizationHeadersChanged(prevAuth, readPatchAuthorizations(patchPath)),
      );
      // HMR only reaches the child if it was spawned WITH this --patch (cordis
      // watches the file it loaded). A child booted before the first MCP server
      // existed has no mcp patch on its command line — rewriting the file does
      // nothing it can see, so that case must fall through to the restart path.
      if (hotswapEnabled && patchPath && !credentialChanged && ctx.dshBridge.getMcpPatch() === patchPath) {
        // The patch file was rewritten atomically (temp+rename inside
        // writeMcpPatch); cordis' Chokidar watcher fires refresh() → dsh-mcp-client
        // hot-swaps. No RPC confirms the swap, so settle on a fixed delay — dsh's
        // own debounce is ~100ms; the server-side settle covers reconnect + initial
        // tools/list. ponytail: no confirmation signal exists in the dsh SDK
        // protocol; a settle delay is the simplest bound that lets "applying…" clear.
        await new Promise((r) => setTimeout(r, HOTSWAP_SETTLE_MS));
        return;
      }
      if (patchPath !== undefined) {
        if (credentialChanged) {
          // Credential VALUE changed: the delivery controller decides — restart
          // now when idle, defer to the turn boundary when a round is streaming
          // (with a hard cap so a wedged stream cannot hold the credential
          // hostage). Never a bare fire-and-forget restart.
          await credentialDelivery.onCredentialChange(patchPath);
          return;
        }
        // Snapshot-incomparable fallback (fix-wire-install-gate D2): no
        // previous patch to diff against (first patch on a child booted
        // before any server existed — e.g. the user's FIRST credential row)
        // means the diff could not rule a credential change out. Deliver
        // through the controller like every credential-shaped change: a bare
        // restart here collides with an in-flight restart and the collision
        // is swallowed by reapplyProfile's catch — production 2026-10-24,
        // twice, fixed only by a platform restart.
        if (!prevAuth) {
          await credentialDelivery.onCredentialChange(patchPath);
          return;
        }
        // Fallback: hot-swap disabled or no servers (empty patch). Restart re-spawns
        // the child with the new --patch; dsh persists sessions by id so the
        // conversation resumes from disk. Serialized behind mcpChain, so concurrent
        // mutations can't overlap-corrupt the restart. fix-fleet-round-discipline
        // D3: even this non-credential-shaped restart rides the delivery
        // controller — a bare restart here would interrupt an in-flight turn on
        // the shared child exactly like a credential one would.
        await credentialDelivery.onCredentialChange(patchPath, { label: "profile fallback" });
      }
    };
    // Profile application already owns the mutation lock. Running directly here
    // avoids queuing an MCP update behind itself while preserving one chain for
    // ordinary global and personal mutations.
    if (ctx.runtimeApplying?.()) return update();
    const run = ctx.runtimeMutationChain.then(update);
    ctx.runtimeMutationChain = run.then(() => {}, () => {});
    return run;
  };
  // ── Line credential renewal (add-line-credential-renewal D2/D3 wiring) ─────
  // The module owns the refresh grant; this is the only wiring point. Every
  // renewed credential re-applies the effective profile for its owner — the
  // Authorization diff above turns that into a deterministic restart (idle) or
  // a deferred one (mid-turn), so the next round runs on the fresh token with
  // no platform restart and no HMR trust anywhere in the unattended path.
  const reapplyRenewedCredential = (email) =>
    ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, ctx.runtimeOwnerGroups ?? null, email);
  ctx.renewLineCredentialsForTurn = () =>
    lineTokenRenewal.renewDueCredentials({
      email: ctx.cellUserEmail || ctx.runtimeOwnerEmail || null,
      onRenewed: reapplyRenewedCredential,
    });
  lineCredentialsLib.setRefreshAttempt((opts) =>
    lineTokenRenewal.renewLineCredential({ ...opts, onRenewed: reapplyRenewedCredential }).then((r) => r.renewed),
  );
  lineTokenRenewal.startRenewalSweep({ onRenewed: reapplyRenewedCredential });
  // Skills-patch rewrite for pack install/uninstall (add-pack-agent-scoping):
  // a NEW or REMOVED pack root changes the watched-dir set (full mode lists
  // every pack root), and dir-set changes through the skills patch are
  // unverified dsh HMR behavior — so the rewrite rides a restart while the
  // runtime is idle (the same contract syncCatalogAgentPresets applies). A
  // focused runtime re-derives and keeps its own pack's root. Content changes
  // inside an already-listed root (an upgrade) stay on plain Chokidar
  // hot-reload; the idempotent rewrite costs nothing extra.
  ctx.dshUpdateSkills = async () => {
    const run = async () => {
      await writeSkillsPatch({ agentPreset: ctx.currentPreset });
      // fix-fleet-round-discipline D3: the skills restart rides the delivery
      // controller too — the old `!ctx.isStreaming` gate missed collector-
      // registered turns the same way the MCP paths did (a pack install
      // during a patrol round killed it). patchPath stays undefined so the
      // restart keeps the child's existing MCP patch (restart's contract:
      // only a non-undefined mcpPatchPath overwrites the stored one).
      if (ctx.dshBridge?.isReady?.()) {
        await credentialDelivery.onCredentialChange(undefined, { label: "skills patch" });
      }
    };
    if (ctx.runtimeApplying?.()) return run();
    if (ctx.runExclusiveRuntimeMutation) return ctx.runExclusiveRuntimeMutation(run);
    return run();
  };
  // Session shim: dsh prompt resolves immediately with the message id; the
  // turn plays out as notifications. isStreaming is set here synchronously
  // (host-side streaming guard) so a concurrent prompt observes it.
  // model.id mirrors the broadcast shape (unprefixed id) so current_model on
  // connect matches what the selector sends (Task 3.4).
  // ponytail: dsh has no SessionManager; expose the minimum shape chat-history
  // needs (getSessionId/currentSessionId + no-op buildSessionContext) so the
  // sidebar reflects the live dsh session as current. recordMessage still
  // mirrors to SQLite; getSessionFile returns null (no JSONL under dsh).
  const dshSm = {
    getSessionId: () => ctx.dshSessionId,
    getSessionFile: () => null,
    buildSessionContext: () => ({ messages: [] }),
    newSession: () => { ctx.dshSessionId = "platform-" + randomUUID(); },
    setSessionId: (id) => { ctx.dshSessionId = id; },
    setSessionFile: () => {},
  };
chatHistory.setSessionManager(dshSm);
chatHistory.setDshBridge(ctx.dshBridge);
// Delete guard extension (concurrent-chat-sessions D7): a session with a turn
// in flight ANYWHERE, or a queued prompt, is undeletable — not just the
// session the global pointer happens to name.
chatHistory.setActivityProbe((id) => ({
  streaming: ctx.isStreamingFor?.(id) === true,
  queued: ctx.isQueuedFor?.(id) === true,
}));
  // Session rows record the preset selected when their first message lands,
  // so a resumed session's header label names the mode it started under.
  chatHistory.setPresetSource(() => ctx.currentPreset);
  // …and the runtime workspace they ran in, so the sidebar groups sessions
  // by workspace. Stamped once per session; later switches never re-group.
  chatHistory.setWorkspaceSource(() => ctx.listWorkspaces?.().current ?? null);
  ctx.session = {
    // `sid` is explicit (concurrent-chat-sessions D6): the dispatcher's run
    // closure resolves the target BEFORE any await, so a session switch while
    // doc refs expand can never re-attribute the turn to another session.
    prompt: async (text, sid = chatHistory.currentSessionId()) => {
      ctx.setStreaming(sid, true);
      const messageId = await ctx.dshBridge.prompt(sid, [{ type: "text", text }]);
      // Trace: the durable message id keys this turn's trace rows.
      ctx.turnStateFor(sid).currentTurnId = messageId;
      trace.bindTurn(messageId);
    },
    model: { id: model, provider },
    sessionManager: dshSm,
  };
  ctx.defaultModel = { id: model, provider, name: model };
  ctx.runtimeModel = { id: model, provider, name: model };
  // The boot-selected default (user binding → Models-page pointer →
  // DEFAULT_MODEL → first declared model, dark-lane guarded) is the stable
  // tail of the fleet post-model resolution chain (add-fleet-post-model).
  // Kept separately because defaultModel/runtimeModel are overwritten by every
  // runtime switch — the chain's "cell default" must not ride that drift.
  ctx.bootModel = { id: model, provider };
  console.log(`[dsh] runtime ready (provider=${provider} model=${model})`);
}



// ── dsh install-matrix boot gate (add-dsh-matrix-lock, ADR-0007) ─────────────
// Runs BEFORE the port binds: a deployment whose installed dsh tree deviates
// from the frozen matrix (dsh-matrix/package-lock.json) fails AT STARTUP with
// a package-level diff, instead of mid-session with ERR_MODULE_NOT_FOUND. No
// install root present (dev machines, e2e scratch homes) skips silently;
// DSH_MATRIX_OVERRIDE=1 boots anyway with the report kept in the log.
{
  const matrixLock = process.env.DSH_MATRIX_LOCK
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dsh-matrix/package-lock.json");
  const matrixRoot = process.env.DSH_MATRIX_INSTALL_ROOT || "/opt/dsh";
  const gate = matrixGate({ lockPath: matrixLock, installRoot: matrixRoot });
  if (gate.action === "fail") {
    console.error(gate.diff.report);
    console.error(`[dsh-matrix] refusing to start — installed tree deviates from the frozen matrix (DSH_MATRIX_OVERRIDE=1 to force)`);
    process.exit(1);
  } else if (gate.action === "override") {
    console.warn(`[dsh-matrix] DSH_MATRIX_OVERRIDE is set — booting despite deviations:`);
    console.warn(gate.diff.report);
  } else if (gate.action === "skip") {
    console.log(`[dsh-matrix] no install root at ${matrixRoot} — skipping dsh tree verification`);
  } else {
    console.log(`[dsh-matrix] install tree matches frozen matrix (${matrixRoot})`);
  }
}

// ── Start (listen-first) ─────────────────────────────────────────────────────
// The port listens IMMEDIATELY: static assets, /api/ready and non-agent
// endpoints answer while background init proceeds. Agent-dependent features
// (WS chat commands, /api/llm/*) answer an explicit initializing error until
// ctx.ready.dsh flips, then connected clients get the ready sync payload.
//
// BOOT INVARIANTS (deliberate ordering — see optimize-hot-paths design D1):
//   1. initChatHistory resolves the sessions store dir BEFORE initDshAgent
//      (the session shim reads it).
//   2. db.initDb opens BEFORE documents.initStore AND BEFORE
//      runLegacyMigrations.
//   3. documents.initStore and initDshAgent run CONCURRENTLY after (2) —
//      they share no state — but BOTH complete BEFORE migrate.
//   4. documents.initStore's restart reconciliation still runs BEFORE
//      migrate's legacy import (same relative order as the sequential boot).
//   5. migrate, catalog.initCatalog and cron.initCron run concurrently after
//      the dsh agent is ready (none can be prompted before then).
server.listen(PORT, HOST, () => {
  console.log(`Platform listening at http://${HOST}:${PORT} (agent init in background)`);
});

await chatHistory.initChatHistory();
// Open the SQLite project database (chat, documents, index, preferences) before
// feature init. Degrades gracefully: if it cannot open, dbReady stays false and
// the server continues (chat in-memory, documents disabled).
await db.initDb();

// Documents (local-extraction library) and the dsh agent both depend only on
// the db being open — run them concurrently.
const documentsInit = (async () => {
  if (!db.isDbReady()) return;
  await documents.initStore({ broadcast: ctx.broadcast });
})();
// Degrade, don't die: a failed agent init (e.g. the dsh binary missing in a
// packaged install) must not take down the listen-first server — static,
// auth, REST, and documents keep serving, and the status panel shows the
// runtime as not-ready with the init error (win-install-smoke 2026-10-08:
// `await Promise.all` used to crash the whole process on spawn dsh ENOENT).
// dshReadyOk gates the readiness flip below: the catch swallows the error so
// boot continues, but /api/ready must stay 503 for a degraded agent — an
// unconditional flip reported a dead runtime as ready (the deploy probes and
// win-install-smoke Phase B both key off that 200).
let dshReadyOk = false;
const dshInit = initDshAgent()
  .then(() => { dshReadyOk = true; })
  .catch((err) => {
    ctx.dshInitError = err?.message || String(err);
    // The stack is the whole diagnosis for init crashes (a TDZ like
    // "Cannot access 'bootWorkspace' before initialization" is a module-order
    // fault whose fix lives at the throwing frame) — the message alone left a
    // CI-only failure unfixable from logs (nonweb acceptance, 2026-10-28).
    console.error(`[dsh] agent init failed — server continues without the agent runtime: ${ctx.dshInitError}\n${err?.stack || "(no stack)"}`);
  });
await Promise.all([documentsInit, dshInit]);
await trace.initTrace();
startUsagePruneTimer();

// Agent is live: flip readiness and sync any client that connected mid-boot.
// Only flipped when initDshAgent resolved — a degraded agent stays 503 and
// the chat surfaces report the runtime as unavailable.
if (dshReadyOk) {
  ctx.ready.dsh = true;
  ctx.onDshReady?.();
}

// Chat-platform bots. Starts after the bridge so a polled message never
// arrives before there is an agent to answer it; inert with no bots configured.
bots.initBots(ctx);

// Zhiyu IM bridge (add-zhiyu-im-bridge): bound bots route their group
// messages into rooms through the gateway; the outbound polled lane replays
// room answers back into IM, restarting cursor-safe. Inert off by default.
{
  const { createZhiyuImBridge } = await import("./server/zhiyu-im-bridge.js");
  const { registerZhiyuImBridgeRoutes } = await import("./server/routes/zhiyu-im-bridge.js");
  ctx.zhiyuImBridge = createZhiyuImBridge({ db: ctx.db });
  ctx.zhiyuImBridge.startOutbounds();
  registerZhiyuImBridgeRoutes(ctx);
}

// Cron turn executor: mounted before cron.initCron loads jobs, so a restored
// job that comes due immediately finds its runner attached.
attachCronRunner(ctx);

// Readiness retry ladder (2026-11-08): the runner re-enqueues a fleet round
// whose runtime was not ready (cold child, or a credential restart in flight)
// instead of recording `skipped` and losing the patrol. Wired here because it
// is the one place holding both the runner's ctx and the cron engine.
ctx.reenqueueFleetTurn = (id, delayMs) => cron.reenqueueJob(id, delayMs);

// Fleet post identity (enable-wire-content-fleet D2): the runner asks which
// post a persona is on duty for and prefixes its turn with the one-line
// identity. Same attribution the report lane uses; a persona holding no post,
// or several (ambiguous), yields null so the turn runs unchanged. Cluster
// posts are out of scope — the fan-out picks the member after this seam runs.
ctx.resolveFleetIdentity = (presetId, { turn } = {}) => fleetIdentityFor(getFleetDatabase(), presetId, { rosterPresetId, turn });

// Direct member identity for a preset, off the RUNNING task record
// (trim-mcp-injection-per-post 2.2). A cron fire carries `sourceTag`
// { fleetId, memberId } — authoritative, no scanning. The preset→member scan
// above returns null unless attribution is a unique "preset" match, and that
// is exactly why the member-patch branch (and the per-post MCP trimming inside
// it) never ran for fleet cron fires: the cell logged "injection surface: 34
// MCP server(s)" with no trim line and no member-* profile dir at all.
// Only `running`/`queued` records count, so a finished fire cannot leave a
// stale identity for the next chat turn on the same persona.
ctx.memberIdentityForPreset = (presetId) => {
  if (!presetId) return null;
  try {
    for (const rec of engine.allRecords()) {
      if (rec?.preset !== presetId) continue;
      if (rec.state !== "running" && rec.state !== "queued") continue;
      const tag = rec.sourceTag;
      if (tag?.fleetId && tag?.memberId) {
        return { fleetId: tag.fleetId, memberId: tag.memberId };
      }
    }
  } catch { /* identity is best-effort; the scan fallback still runs */ }
  return null;
};

// Chat-lane team context (fix-external-team-chat-lane B1): a visitor chatting
// with a fleet persona gets the TRIMMED team roster (identity + members +
// dispatchable targets) so the persona can name its teammates and dispatch to
// them by title. Same server-side attribution as the identity above — no
// attribution ⇒ null ⇒ the prompt stays byte-identical.
ctx.resolveFleetChatContext = (presetId) => {
  try {
    return renderChatFleetContext(getFleetDatabase(), presetId, { rosterPresetId });
  } catch (err) {
    console.warn("[fleets] chat fleet context render failed:", err.message);
    return null;
  }
};

// Fleet post model (add-fleet-post-model D3): the persona turn path asks for
// this post's resolution plan (chain candidates + notices) right before the
// model normalization switch. Same attribution seam as the identity above;
// roster comes from the live model list, the chain tail from the boot default.
ctx.resolveFleetModel = async (presetId) => {
  try {
    let roster = null;
    if (typeof ctx.getAvailableModels === "function") {
      const models = await ctx.getAvailableModels();
      roster = Array.isArray(models) ? models.map((m) => m.id) : null;
    }
    return fleetModelFor(getFleetDatabase(), presetId, {
      rosterPresetId,
      roster,
      cellDefault: ctx.bootModel?.id ?? null,
      // 预算门注记（add-model-surface-budget-gate 2.3）：链上每跳问一次
      // daily/monthly 窗口；引擎关=probe 缺席=零注记（degrade-open）。
      budgetProbe: ctx.modelBudget ? (model) => ctx.modelBudget.checkBudget(model) : null,
    });
  } catch (e) {
    console.warn(`[fleets] post model resolution failed: ${e?.message || e}`);
    return null;
  }
};

// Fallback notices bridge (add-fleet-post-model D7): a persona turn records
// its selection-time fallback facts under the memberId; a report filed during
// that same turn picks them up as blockers (one-shot). Turns serialize on the
// shared runtime, so one entry per member is turn-accurate; a member that
// never reports leaves its notices in the log only — by design.
const fleetModelNotices = new Map();
ctx.recordFleetModelNotices = (memberId, notices) => {
  if (!memberId) return;
  if (Array.isArray(notices) && notices.length) fleetModelNotices.set(memberId, notices);
  else fleetModelNotices.delete(memberId);
};
ctx.takeFleetModelNotices = (memberId) => {
  const notices = fleetModelNotices.get(memberId) ?? [];
  fleetModelNotices.delete(memberId);
  return notices;
};

// Attribution fact bridge (fix-parked-preset-attribution D3): the report bridge
// resolves WHICH post a call belongs to, and the turn's event row is written
// AFTER it (at the turn's end). Stash the decision under the memberId so the
// recorder can land it as `detail.attribution` — one-shot, same discipline as
// the model notices above. Turns serialize on the shared runtime, so one entry
// per member is turn-accurate; a turn that filed no report leaves nothing.
const fleetAttributionFacts = new Map();
ctx.recordFleetAttribution = (memberId, fact) => {
  if (!memberId || !fact) return;
  fleetAttributionFacts.set(memberId, fact);
};
ctx.takeFleetAttribution = (memberId) => {
  const fact = fleetAttributionFacts.get(memberId) ?? null;
  fleetAttributionFacts.delete(memberId);
  return fact;
};

// Report-rejection bridge (fix-fleet-report-delivery 1.1): when the flood gate
// refuses a report, all the caller ever saw was a 429 in a tool result — the
// turn row said nothing, so the ledger read "this post produced no report"
// while the truth was "the server refused it". Live 2026-11-09 that mixed-up
// reading cost a full forensic detour (the post's honest three-slot payload was
// rejected whole and the empty row looked like a model failure). Same one-shot
// discipline as the attribution fact above: stash at refusal, land on the turn
// row when it ends.
const fleetReportRejections = new Map();
// Rolling window for the operator face (3.1/3.2): the stash above is one-shot
// per turn and vanishes when the turn row is written, so it cannot answer "is
// this post being refused repeatedly?" — that needs a window.
const fleetReportRejectionLog = [];
ctx.recordReportRejection = (memberId, fact) => {
  if (!memberId || !fact) return;
  fleetReportRejections.set(memberId, fact);
  try {
    recordRejection(fleetReportRejectionLog, { memberId, at: Date.now() });
  } catch { /* the count must never fail the refusal path */ }
};
// The stash is keyed by whatever identity the refusal path actually had:
//   • a FLOOD refusal happens after attribution succeeded ⇒ the member id;
//   • an ATTRIBUTION refusal happens BEFORE a member exists ⇒ the live preset.
// The recorder reads `job.sourceTag.memberId` (or the fleet origin) at turn end,
// which is the member id — so a preset-keyed refusal would never be taken and
// the whole point (making the refusal visible) would be lost. Hence take() tries
// the member id first, then the preset, and clears whichever it found.
ctx.takeReportRejection = (memberId, presetId = null) => {
  for (const key of [memberId, presetId]) {
    if (!key) continue;
    const fact = fleetReportRejections.get(key);
    if (fact) {
      fleetReportRejections.delete(key);
      return fact;
    }
  }
  return null;
};
// Read-side: prune on read as well as on write, so a post that stopped being
// refused ages out without a sweeper.
ctx.reportRejectionStats = ({ windowMs, now = Date.now() } = {}) => {
  try {
    prune(fleetReportRejectionLog, windowMs ? { now, windowMs } : { now });
    return summarizeRejections(fleetReportRejectionLog, windowMs ? { now, windowMs } : { now });
  } catch {
    return { total: 0, byMember: {} };
  }
};

// Run ledger (agent-fleet-runs): the execution instance behind the cockpit's
// live canvas and replay timeline. begin/end/settle are called from the
// cron-runner seam; dispatch (routes/fleets.js) and the handoff trigger below
// read it to stamp chain positions on the tasks they ignite. Hourly sweep ages
// closed headers and over-floor turn rows out (dual-condition retention).
ctx.fleetTurnLedger = createFleetTurnLedger({
  db: getFleetDatabase(),
  broadcast: (msg) => ctx.broadcast(msg),
  engineRecords: () => engine.allRecords(),
  trace,
  rosterPresetId,
  // Interrupted-beat catch-up (add-rollout-gap-durability): a cron run the
  // pod roll killed consumed its cadence beat — the decision (same tolerance
  // rule as the boot downtime pass, same engine fire path) lives in one place
  // on the cron module.
  onInterruptedRun: ({ fleetId, memberId }) => cron.makeUpInterruptedBeat({ fleetId, memberId }),
});

// Fleet working memory (add-zhiyu-team-memory 刀A): turn facts captured as
// L0/L1 pages into the owner's `f/<fleetId>` memory project over fd-memory's
// platform-seam — the SAME lane cluster shared memory uses. Degrade open
// everywhere: a capture failure is a counter, never a failed turn; an
// unavailable memory face is a missing fleetContext section, never a
// placeholder.
{
  const healthFlip = createHealthFlipTracker();
  let memoryClient = null;
  let memoryClientTried = false;
  const memoryFor = async () => {
    if (!memoryClientTried) {
      memoryClientTried = true;
      memoryClient = await fleetMemoryFor(process.env, ctx.cellUserEmail ?? null);
    }
    return memoryClient;
  };
  ctx.fleetMemoryCapture = createFleetMemoryCapture({ memory: { async writeFact(f) { const m = await memoryFor(); if (!m) throw new Error("fleet memory off"); await m.writeFact(f); }, async writeSharedPage(f) { const m = await memoryFor(); if (!m) throw new Error("fleet memory off"); await m.writeSharedPage(f); } } });
  // Fire-and-forget: the seam caller never awaits memory.
  ctx.captureFleetFact = (fleetId, memberId, kind, title, body) => {
    void ctx.fleetMemoryCapture?.capture(fleetId, memberId, kind, title, body)?.catch?.(() => {});
  };
  // Turn settle capture (the seam every member turn passes through): turn
  // outcome + health flips. Wrapped around recordFleetTurnEvent below.
  ctx.captureFleetTurnFact = (job, outcome, meta) => {
    try {
      const fleetId = job?.sourceTag?.fleetId ?? job?.origin?.fleet?.fleetId ?? null;
      const memberId = job?.sourceTag?.memberId ?? job?.origin?.fleet?.memberId ?? null;
      if (!fleetId || !memberId) return;
      // fix-fleet-memory-turn-title O10: the executors return { ok, ... } —
      // there is no `status` field on the outcome (shapeTurnOutcome is the one
      // that derives it). Reading `outcome?.status` here made every captured
      // turn page a "回合失败", including the successes (production: 9 pages,
      // 0 成功, while the ledger held 6 ok rows). Derive the same way the
      // recorder does, from `ok`/`skipped`.
      const status = outcome?.skipped === true ? "skipped" : outcome?.ok === true ? "ok" : "failed";
      // Turn fact anchor (add-fleet-memory-anchors D1): one header line binding
      // the memory page to the ledger row — "每一页记忆都知道自己是谁花的钱
      // 买的". Absent pieces stay blank (honest absence, never a 0).
      const m = outcome?.metering ?? {};
      const usage = outcome?.usage ?? {};
      const input = Number.isFinite(usage.input) ? usage.input : null;
      const output = Number.isFinite(usage.output) ? usage.output : null;
      const cached = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null;
      const write = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : null;
      const billed = input != null ? input + (cached ?? 0) + (write ?? 0) : null;
      const anchor = `${[
        `[turn`,
        `turn_id=${meta?.ledgerTurn?.turnId ?? "-"}`,
        `run_id=${meta?.ledgerTurn?.runId ?? "-"}`,
        `carrier=${m.carrier ?? "-"}`,
        `model=${meta?.model ?? "-"}`,
        `tokens=${input ?? "-"}/${output ?? "-"}/${billed ?? "-"}`,
        `status=${status}`,
      ].join(" ")}]`;
      ctx.captureFleetFact(fleetId, memberId, "turn", `回合${status === "ok" ? "成功" : "失败"}`, `${anchor}\n${String(outcome?.text ?? outcome?.error ?? "").slice(0, 400)}`);
      if (healthFlip(fleetId, memberId, status)) {
        ctx.captureFleetFact(fleetId, memberId, "health", `状态迁移 → ${status}`, `岗位 ${memberId} 的执行状态从 ${status === "ok" ? "失败" : "成功"}迁回。`);
      }
    } catch { /* capture never surfaces into the turn path */ }
  };
  // The fleetContext memory section: the member ladder (add-member-knowledge-
  // profile) — own ∪ shared ∪ legacy f/ under one budget, gated by the
  // member's knowledge scope; null = section absent (degrade open).
  // Merge lever (optimize-yongyi-read-surfaces 6.3): when on, the SDK asks the
  // memory service for own+shared in ONE request instead of two — one root
  // read, one vector decode, one budget. Off by default and inert on an older
  // client: `mergeOwnShared` is simply ignored by a client that predates it, so
  // flipping this env var can never change behavior until the newer client is
  // installed. Keeping the lever off is also the rollback: the three-segment
  // path stays the default and stays tested.
  const mergeOwnShared = String(process.env.FD_MEMORY_DIGEST_MERGE_OWN_SHARED ?? "") === "1";
  ctx.fleetMemoryDigest = async (fleetId, memberTitle, memberId = null, scope = "own+shared") => {
    const m = await memoryFor();
    if (!m) return null;
    if (scope === "off") return null;
    const out = await m.readDigest(fleetId, memberId ?? memberTitle ?? "", memberTitle ?? "", {
      budget: 1200,
      scope,
      ...(mergeOwnShared ? { mergeOwnShared: true } : {}),
    });
    return typeof out?.block === "string" && out.block.trim() ? out.block : null;
  };
}
// Settle backstop (agent-fleet-runs): the seam settles after each TURN, but a
// chained task can die at the ENGINE layer without ever entering the turn seam
// (schedule-side block, pre-execution failure) — its run's header would leak
// open forever. Every engine-terminal task carrying a chain re-runs settle;
// idempotent, and a no-op while anything of that run is genuinely in flight.
engine.addOnFinished((t) => {
  try {
    ctx.fleetTurnLedger?.settle(t?.origin?.fleet?.chain?.runId ?? null, { excludeTaskId: t?.id ?? null });
  } catch { /* the engine hook must never throw into the lifecycle */ }
});
// Run-ledger hygiene: prune ages closed headers and over-floor turn rows out;
// reclaimOrphanRuns closes headers whose turn never wrote a row (a pod roll
// mid-turn leaves one, and no future engine event can ever settle it —
// add-cockpit-run-reclaim). Both run at boot and hourly: boot catches what the
// previous process leaked, since the leak predates this process's listeners.
const sweepRuns = () => {
  try {
    const swept = getFleetDatabase().pruneRuns();
    if (swept.orphans) console.warn(`[fleet-runs] reclaimed ${swept.orphans} orphan open run(s)`);
    // Leaked headers: a turn whose row landed but whose settle never ran
    // (the settle backstop is in-memory; a pod roll in between leaves the
    // header open forever). The ledger knows whether a run is still working.
    const settled = ctx.fleetTurnLedger?.sweepOpenRuns?.() ?? 0;
    if (settled) console.warn(`[fleet-runs] settled ${settled} leaked open run header(s)`);
  } catch (e) {
    console.warn(`[fleet-runs] sweep failed: ${e?.message || e}`);
  }
};
sweepRuns();
setInterval(sweepRuns, 60 * 60 * 1000).unref();

// Turn result events (add-fleet-turn-events D1/D2): the cron-runner seam calls
// this after every member turn; recordTurnEvent resolves attribution
// (sourceTag → origin.fleet → persona scan) and appends the event, returning
// null for non-fleet turns. When the seam opened a ledger handle for the turn
// the ledger's end() writes the row instead (same recorder underneath, plus
// turnId/runId/chain/trace key and the fleet_turn_ended broadcast). Degrade
// open here too — the warn is the whole blast radius.
ctx.recordFleetTurnEvent = (job, outcome, meta) => {
  try {
    ctx.captureFleetTurnFact?.(job, outcome, meta);
    // Attribution fact (fix-parked-preset-attribution D3): a report filed
    // during this turn stashed HOW it was attributed; land it on the turn row
    // as detail.attribution so "which post did this call belong to" is readable
    // from the ledger instead of inferred from logs. Keyed by memberId (turns
    // serialize on the shared runtime ⇒ one entry per member is turn-accurate);
    // a turn that filed no report leaves the detail byte-for-byte unchanged.
    const memberId = job?.sourceTag?.memberId ?? job?.origin?.fleet?.memberId ?? null;
    const attributionFact = memberId ? ctx.takeFleetAttribution?.(memberId) ?? null : null;
    // Report rejection rides the same row (fix-fleet-report-delivery 1.1): a
    // refused report is a fact ABOUT this turn, and the ledger must carry it —
    // otherwise "no report landed" and "the server dropped it" look identical.
    // The preset is passed as the fallback key: an ATTRIBUTION refusal has no
    // member id to stash under (see takeReportRejection), and without this the
    // 2026-11-10 bet-post refusals stayed invisible.
    const reportRejection = ctx.takeReportRejection?.(memberId, job?.preset ?? null) ?? null;
    const detailFacts = {
      ...(attributionFact ? { attribution: attributionFact } : {}),
      ...(reportRejection ? { reportRejected: reportRejection } : {}),
    };
    const shapedOutcome = Object.keys(detailFacts).length
      ? {
          ...outcome,
          detail: {
            ...(outcome?.detail && typeof outcome.detail === "object" ? outcome.detail : {}),
            ...detailFacts,
          },
        }
      : outcome;
    if (meta?.ledgerTurn) return ctx.fleetTurnLedger.end(job, meta.ledgerTurn, shapedOutcome, meta);
    return recordTurnEvent(getFleetDatabase(), job, shapedOutcome, { ...meta, rosterPresetId });
  } catch (e) {
    console.warn(`[fleets] turn event record failed: ${e?.message || e}`);
    return null;
  }
};

// Event wake (add-fleet-event-wake): bots.js calls this after its inbound
// guards; optional-chained there, so its absence degrades to nothing.
ctx.triggerFleetEventWake = (botId, meta) => {
  try {
    return triggerFleetEventWake({ db: getFleetDatabase(), engine, roster: rosterPresetId }, botId, meta);
  } catch (e) {
    console.warn(`[fleets] event wake failed for bot ${botId}: ${e?.message || e}`);
    return [];
  }
};

// Handoff edges (agent-fleet-orchestration D4): the turn seam calls this
// after the outcome event. Upstream completion — ok or failed, both honestly
// relayed — creates one manual turn per declared outgoing edge, depth read
// from the chain position in origin.fleet. Over-bound hops create nothing
// but leave an honest event row. Cluster posts have no manual lane: skipped,
// their next cadence/delegation turn carries the work.
ctx.triggerFleetHandoffs = async (job, out, ledgerTurn = null) => {
  // Real seam extracted to server/fleet-handoffs.js (importable by tests —
  // the in-stub mirror missed the fanout-only early-return for years).
  try {
    return igniteFleetEdges({
      db: getFleetDatabase(),
      engine,
      job,
      out,
      ledgerTurn,
      rosterPresetId,
      chainFor: (edgeKind) => ctx.fleetTurnLedger?.chainFor?.(ledgerTurn, edgeKind) ?? null,
    });
  } catch (e) {
    console.warn(`[fleets] handoff trigger failed: ${e?.message || e}`);
    return null;
  }
};

// One-time import of legacy file stores (documents-store/, sessions-store/,
// chat-history-store/) into the SQLite database. Runs only on a fresh database;
// idempotent; never deletes the legacy stores. migrate.js reads both legacy
// chat formats directly with stdlib fs (no SDK dependency).
// catalog.initCatalog resolves on the LOCAL catalog (cloud + registry merge
// async); cron reads its jobs file and starts timers. The registry bridge
// resolves immediately (its first fetch runs in the background, TTL keeps the
// snapshot warm); disabled entirely without MARKET_REGISTRY_URL/REGISTRY_URL.
// Fleet patrol-context inputs (agent-fleet-report-lane): the renderer needs
// the fleet's on-duty overview; statuses are derived read-time, same as the
// routes' read face.
const fleetDb = getFleetDatabase();
function deriveFleetStatuses(fleetId) {
  const fleet = fleetDb.getFleet(fleetId);
  if (!fleet) return new Map();
  const tasks = new Map(
    cron.listJobs().filter((j) => j?.sourceTag?.fleetId === fleetId).map((j) => [j.sourceTag.memberId, j]),
  );
  const out = new Map();
  for (const m of fleetDb.listMembers(fleetId)) {
    out.set(
      m.id,
      deriveMemberStatus({
        member: m,
        fleet,
        task: tasks.get(m.id) ?? null,
        targetAlive: resolveFleetTarget(m).alive,
        latestReport: fleetDb.latestReportFor(m.id),
      }).status,
    );
  }
  return out;
}

initRegistryBridge({ broadcast: ctx.broadcast });
await Promise.all([
  migrate.runLegacyMigrations(),
  catalog.initCatalog({
    broadcast: ctx.broadcast,
    // The catalog's chat agents are served locally through generated persona
    // presets; a changed catalog regenerates them and restarts the idle child so
    // its roster lists the packs that arrived (or dropped) with it.
    onChange: () => {
      void ctx.syncCatalogAgentPresets?.();
      // A catalog change can kill a fleet post's incumbent (persona gone) or
      // revive one — converge every fleet's materialized tasks so a vacant
      // post stops firing. Gated on engine readiness: this hook can fire
      // during boot while initCron (same Promise.all) is still loading.
      if (cron.isEngineInitialized()) {
        // One catalog snapshot for the whole converge pass: the pass resolves
        // one target per member, and resolving against the live catalog
        // re-merges it per member (~30ms each → ~1.8s of blocked event loop
        // for a 60-member account, which delays every other request in the
        // cell). One view for the pass keeps every post on the same snapshot.
        const view = catalog.mergedView();
        void reconcileAllFleets({
          db: getFleetDatabase(),
          cronApi: cron,
          resolveTarget: (member) => resolveFleetTarget(member, view),
          rosterPresetId,
        }).catch((e) => console.warn(`[fleets] catalog-change reconcile failed: ${e.message}`));
      }
    },
  }),
  cron.initCron({
    broadcast: ctx.broadcast,
    // The runner (server/cron-runner.js) executes one bound-session turn:
    // wait-for-idle, preset switch, collector-prompted exchange, persistence.
    runJobTurn: (job, opts) => ctx.runCronJobTurn(job, opts),
    isBusy: () => ctx.isStreaming,
    // Worker-pool occupancy for the fleet stats snapshot; a closure because the
    // pool attaches after this init (unify-wanxing-management-plane).
    workerStats: () => ctx.workerPool?.poolStats(),
    // Fleet patrol context (agent-fleet-report-lane D6): render the
    // {{fleetContext}} segment at fire time for fleet-tagged tasks; cron.js
    // substitutes it into that fire's prompt. Throws or empty segments fail
    // the fire explicitly — never a silent empty-context patrol. The decision
    // digest (agent-fleet-decision-lane) rides the same segment slot: this
    // post's undelivered resolutions, their own block, absent when empty.
    // Workspace hygiene fact (fix-fleet-workspace-hygiene): one readdir per
    // call, cached for a minute — the patrol tail quotes it so a post can see
    // what its round-file habit already cost. Read-only, bounded, never throws.
    workspaceHygiene: (() => {
      let cached = { at: 0, value: null };
      return () => {
        const now = Date.now();
        if (now - cached.at < 60_000) return cached.value;
        try {
          const fsMod = require("node:fs");
          const p = require("node:path");
          const root = ctx.dshBridge?.getCwd?.() || process.cwd();
          let files = 0;
          let bytes = 0;
          let ownFiles = 0;
          for (const entry of fsMod.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            files += 1;
            try { bytes += fsMod.statSync(p.join(root, entry.name)).size; } catch { /* raced */ }
            if (/^(DUTYLOG|BOARD-ENTRY|TICKET-DISPATCH|CHECKPOINT|BRIEF)-/i.test(entry.name)) ownFiles += 1;
          }
          cached = { at: now, value: { files, bytes, ownFiles } };
        } catch {
          cached = { at: now, value: null }; // unreadable workspace → no line
        }
        return cached.value;
      };
    })(),
    renderFleetContext: (sourceTag, task, opts) =>
      buildFleetContext(sourceTag, task, {
        // add-fleet-edge-context D2: "patrol" (cadence template) vs "edge"
        // (dispatch/接棒/扇出/唤醒). Same fleet view; edge drops the patrol
        // discipline tail and never consumes the decision-delivery channel.
        mode: opts?.mode === "edge" ? "edge" : "patrol",
        db: getFleetDatabase(),
        deriveStatuses: deriveFleetStatuses,
        decisionDigest: (fleetId, memberId) => {
          const items = getFleetDatabase().listDecisions({ fleetId, pendingDeliveryFor: memberId });
          return renderDecisionSegment(items);
        },
        // Fleet working memory (add-zhiyu-team-memory 刀A): the seam is
        // member-relevant by title; null = absent.
        memoryDigest: ctx.fleetMemoryDigest,
        // Knowledge documents (add-member-knowledge-profile): the member's
        // bound library collections, searched server-side — rendered AFTER
        // memory in the same ladder; absent provider = no document segment.
        docDigest: ctx.fleetDocDigest ?? null,
        // Knowledge profile (same change): the member's effective profile —
        // memory off/scope/budget and the collection binding in one lookup;
        // absent = platform defaults.
        knowledgeProfile: ctx.fleetKnowledgeProfile ?? null,
        // Workspace hygiene fact for the patrol tail (fix-fleet-workspace-hygiene).
        workspaceHygiene: () => ctx.workspaceHygiene?.() ?? null,
      }),
  }),
]);
// Delegation aggregator: hooks the engine AFTER initCron (init clears hook
// subscribers) — finished manual fan-outs inject the summary turn back into
// the initiating session; rearm covers groups a restart left pending.
attachDelegationAggregator(ctx).rearm();
// ── Knowledge profile + document digest providers (add-member-knowledge-
// profile) ────────────────────────────────────────────────────────────────────
// The member's EFFECTIVE profile = cell default (cell_settings) ⊕ fleet
// override (fleets.knowledge_profile), normalized by the pure module. Any
// failure degrades to platform defaults — the profile must never block a
// firing. The document digest searches the member's bound collections
// server-side (the same library DB the library MCP child serves, imported
// directly — same process, one DB). Degrade open: a search failure is an
// absent segment, never an error into the turn.
{
  const { effectiveProfile, normalizeKnowledgeProfile } = await import("./server/knowledge-profile.js");
  const { searchLibrary } = await import("./documents-search.js");
  ctx.fleetKnowledgeProfile = (fleetId, _memberId) => {
    try {
      const fdb = getFleetDatabase();
      const cellDefault = normalizeKnowledgeProfile(fdb.getCellKnowledgeProfile?.() ?? null);
      const override = normalizeKnowledgeProfile(fdb.getFleetKnowledgeProfileRaw?.(fleetId) ?? null);
      if (!cellDefault.ok || !override.ok) return null;
      return effectiveProfile(cellDefault.profile, override.profile);
    } catch {
      return null;
    }
  };
  ctx.fleetDocDigest = (fleetId, memberId, memberTitle) => {
    try {
      const kp = ctx.fleetKnowledgeProfile(fleetId, memberId);
      const collections = (kp?.collections ?? []).map((r) => r.slice("library:".length));
      if (!collections.length) return null;
      const q = String(memberTitle ?? "").trim();
      if (!q) return null;
      const lines = [];
      for (const colId of collections.slice(0, 5)) {
        const hits = searchLibrary(q, { collectionId: colId, limit: 2 });
        for (const h of hits) lines.push(`- 《${h.name}》${h.loc ? `（${h.loc}）` : ""}：${String(h.snippet ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
      }
      return lines.length ? `### 资料库命中 / Library hits\n${lines.slice(0, 6).join("\n")}` : null;
    } catch {
      return null;
    }
  };
  // Per-member MCP patch composition (add-member-knowledge-profile): a fleet
  // member persona running on a WORKER SLOT (pinned to that persona for its
  // life) gets a private mcp patch — the fd-memory row swaps the owner person
  // token for the member's deployment token (d/<fleetId>/<memberId>, the
  // member IS the identity), and the library row is stamped with the member's
  // bound collections (the same LIBRARY_COLLECTIONS env the tool server
  // enforces; absent = whole-account view, unchanged). The persona is NOT a
  // fleet member (or identity resolution fails) → null, shared patch, zero
  // behavior change. Cache per persona: the token belongs to the role.
  let memberPatchCache = new Map();
  // The live-effect counterpart (fleet routes PUT /knowledge-profile calls
  // this): a profile write invalidates the per-persona patches so the next
  // member turn recomposes with the new token/collection set. Token identity
  // is role-bound, so the fd-memory mint cache on disk stays — only the
  // composed patch (collections/env/header) is rebuilt.
  ctx.invalidateMemberPatchCache = () => {
    memberPatchCache = new Map();
  };
  ctx.composeMemberMcpPatch = async (personaPreset) => {
    if (!personaPreset || memberPatchCache.has(personaPreset)) return memberPatchCache.get(personaPreset) ?? null;
    let out = null;
    try {
      // The cron path already KNOWS the member: `sourceTag` carries
      // { fleetId, memberId } straight off the task record. Preferring it over
      // the preset→member scan matters because that scan returns null whenever
      // attribution is not a unique "preset" match — which is why this whole
      // branch (and therefore per-post MCP trimming) never ran for fleet cron
      // fires. Falls back to the scan for the chat lane, where no task exists.
      const taskIdentity = ctx.memberIdentityForPreset?.(personaPreset) ?? null;
      const identity = taskIdentity ?? ctx.resolveFleetIdentity?.(personaPreset) ?? null;
      if (identity?.fleetId && identity?.memberId) {
        const cfg = cellMemoryConfig(process.env);
        const owner = ctx.runtimeOwnerEmail ?? null;
        if (cfg && owner) {
          const kp = ctx.fleetKnowledgeProfile?.(identity.fleetId, identity.memberId) ?? null;
          const memOn = kp?.memory?.enabled ?? true;
          const token = memOn ? await memberTokenFor(cfg, { packId: identity.fleetId, memberId: identity.memberId, ownerEmail: owner }) : null;
          const collections = (kp?.collections ?? []).map((r) => r.slice("library:".length));
          const { writeMemberMcpPatch, faceForPresetFromPacks } = await import("./dsh-profile.js");
          // Per-post server trimming (trim-mcp-injection-per-post 2.2): resolve
          // the preset's declared MCP face from the installed packs and hand it
          // in. Without this the writer's safety valve keeps all 34 servers —
          // live 2026-11-10 the cell logged "injection surface: 34 MCP
          // server(s)" with no trim, because this call site passed nothing.
          let faceForPreset = null;
          try {
            const db = await import("./db.js");
            if (db.isDbReady()) {
              const packs = db.listInstalledPacks();
              faceForPreset = (preset) => faceForPresetFromPacks(packs, preset);
            }
          } catch (e) {
            console.warn(`[member-patch] face derivation failed for ${personaPreset} (keeping full composition): ${e?.message || e}`);
            faceForPreset = null;
          }
          out = await writeMemberMcpPatch({
            personaPreset,
            memoryToken: token,
            libraryCollections: collections,
            ownerEmail: owner,
            userGroups: null,
            agentPreset: personaPreset,
            faceForPreset,
          });
        }
      }
    } catch (e) {
      console.warn(`[member-patch] compose failed for ${personaPreset} (fail-open): ${e?.message || e}`);
      out = null;
    }
    memberPatchCache.set(personaPreset, out);
    return out;
  };
}
// Fleet report + decision lanes (agent-fleet-report-lane D4,
// agent-fleet-decision-lane 2.2): a finished a2a fleet fire cannot self-report
// (the remote agent cannot call this cell's tools) — its outcome becomes a
// derived, honestly-badged execution-summary report row. And a DONE fleet turn
// (cadence fire or execute-now manual task) delivers this post's resolved
// decisions — idempotent, capped per turn, oldest resolution first. Failed
// turns deliver nothing (the context never reached the model). Registered
// after initCron for the same reason as the aggregator; the engine is imported
// dynamically here because server.js otherwise stays runtime-agnostic behind
// cron.js.
{
  const engine = await import("./task-engine.js");
  const fleetLanesDb = getFleetDatabase();
  engine.addOnFinished((task) => {
    try {
      const derived = derivedReportFromTask(task);
      if (derived) fleetLanesDb.appendReport(derived);
    } catch (e) {
      console.warn(`[fleets] derived report failed for ${task?.id}: ${e.message}`);
    }
    try {
      if (task?.state === "done") {
        const memberId = task.sourceTag?.memberId ?? task.origin?.fleet?.memberId ?? null;
        if (memberId) {
          fleetLanesDb.markDelivered(memberId, { sessionId: task.sessionId ?? null });
        }
      }
    } catch (e) {
      console.warn(`[fleets] decision delivery marking failed for ${task?.id}: ${e.message}`);
    }
  });
  // Fleet-policy expiry backstop (lazy sweeps run on every queue read; this
  // hourly pass covers fleets nobody is reading).
  // Deputy digest (add-deputy-decision-delegate D7 周期侧): the per-ruling
  // mirror already lands a page at ruling time; this pass folds a window of
  // them into one owner-memory summary at the policy's cadence. Same hourly
  // tick as the expiry backstop — the cadence gate itself is daily/weekly,
  // so an hourly check is pure granularity (last-run lives in cell_settings,
  // so a restart neither double-sends nor loses a period).
  //
  // ⚠️ 只能 setInterval 是不够的：cell 是按需启动的，一个频繁滚版的 cell
  // 可能活不过一个 60 分钟的间隔——日摘要会永远轮不到（2026-10-29 生产实证：
  // pod 一天滚了 7 次，tick 一次没跑）。所以先跑一次再挂表。
  //
  // 报数 digest（fleet-owner-iteration）同理接在这里：`startDigestRunner` 写了
  // 却从来没有被任何地方调用——订阅入口在 OwnerBoardStrip 上是活的，点了却
  // 永远收不到东西。两个 digest 共用同一 tick，语义一致（时点事实源都在库里）。
  const runFleetDigestPass = () => {
    void runDueDeputyDigests({
      db: fleetLanesDb,
      memoryClientFor: (ownerEmail) => memoryRefClientFor(process.env, ownerEmail),
    }).catch((e) => console.warn(`[deputy-digest] tick failed: ${e?.message || e}`));
    void runDueDigests({ db: fleetLanesDb, chatHistory }).catch((e) =>
      console.warn(`[fleet-digest] tick failed: ${e?.message || e}`),
    );
  };
  runFleetDigestPass();
  setInterval(() => {
    try {
      for (const fleet of fleetLanesDb.listFleets()) {
        fleetLanesDb.expireOpenDecisions(fleet.id);
      }
    } catch (e) {
      console.warn(`[fleets] expiry sweep failed: ${e.message}`);
    }
    runFleetDigestPass();
  }, 60 * 60 * 1000).unref();
}
// Worker pool (TASK_WORKER_MAX; 0 = inert, exactly today's serial semantics).
// Attached after the engine so the slot dispatcher registers against the
// initialized engine; ctx.workerPool feeds the aggregator's drain gate.
ctx.workerPool = attachWorkerPool(ctx);
// Mandate revalidation gate (add-turn-mandate-lane): a mandate-carrying
// event-wake task re-executing revalidates against the CURRENT signal-source
// policy. ok+stampChanged → an honest disposition row (the resumed turn
// writes its own O1 row); refusal → the resume is refused and the row says
// why. Fail-open catch: a broken gate must not wedge re-runs.
engine.setMandateGate((task) => {
  try {
    const mandate = task.origin?.mandate;
    const botId = task.origin?.event?.botId;
    if (!mandate || !botId) return { ok: true };
    const policy = readSignalPolicy(botId);
    const verdict = revalidateMandate(mandate, policy);
    if (verdict.ok && verdict.stampChanged) {
      recordDisposition(botId, {
        fate: "admitted",
        reason: "revalidated_stamp_drift",
        taskId: task.id,
        sender: mandate.trigger?.sender ?? null,
        policyVersion: mandate.policyVersion,
      });
    }
    if (!verdict.ok) {
      recordDisposition(botId, {
        fate: "filtered",
        reason: `revalidate_${verdict.reason}`,
        taskId: task.id,
        sender: mandate.trigger?.sender ?? null,
        policyVersion: mandate.policyVersion,
      });
    }
    return verdict;
  } catch (e) {
    console.warn(`[fleets] mandate revalidation failed open for ${task?.id}: ${e?.message || e}`);
    return { ok: true };
  }
});
// Fleet fairness (split-meta-team-queue-capacity D3): the engine must not own
// the question "which fleets are internal meta teams" — that list changes as
// teams come and go, and hard-coding names in the queue would rot. The fleet
// record is the authority here; the resolver below reads it, and a broken read
// degrades to "normal fleet" (never throws, never blocks dispatch).
//
// Source of truth: a fleet is meta when its own record says so. Until the UI
// grows that field, `FLEET_META_IDS` (comma-separated fleet ids) is the
// bootstrap — explicitly configuration, not code.
engine.setMetaFleetResolver((fleetId) => {
  if (!fleetId) return false;
  const configured = String(process.env.FLEET_META_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (configured.includes(fleetId)) return true;
  try {
    const fleet = getFleetDatabase().getFleet(fleetId);
    return fleet?.internal === true || fleet?.meta === true;
  } catch {
    return false;
  }
});

// Inbound disposition seam for bots.js guard drops (size/rate) — fire-and-
// forget, failure never touches the chat path.
ctx.recordSignalDisposition = (botId, entry) => {
  try {
    recordDisposition(botId, entry);
  } catch { /* observation only */ }
};
// MC console bridge (mission-control-bridge): opt-in via env, outbound-only,
// never boot-blocking. Inert without MC_BRIDGE=1 + MC_URL + MC_API_KEY.
ctx.mcBridge = attachMcBridge(ctx);

// Resource library: inject the WS broadcast and run the one-time chart seeding
// pass. Deliberately AFTER runLegacyMigrations — on a fresh database the legacy
// import lands messages that must be seeded too, and the seeding marker is
// one-shot, so seeding before the import would skip them forever.
await resources.initStore({ broadcast: ctx.broadcast });
// Chart data bindings (add-chart-data-binding): the per-binding refresh timers,
// the freshness gate, the failure backoff and the retention sweeper. Started
// after the library because it schedules only bindings that resource references
// exist for, and after the dsh bridge because a refresh uses the same
// per-user credential the runtime's MCP entries carry.
const chartRefresh = await import("./chart-refresh.js");
await chartRefresh.initChartRefresh({
  broadcast: ctx.broadcast,
  ownerEmail: () => ctx.runtimeOwnerEmail ?? null,
});
// Turn pricing warm-up (add-turn-pricing): pre-pull the deployment's model
// roster from the 词元 admin door so the first turns already price; the timer
// keeps the cache fresh (10min) and the miss-fill covers newly seen models.
// Degraded without SUB2API_ADMIN_KEY — pricing stays empty, columns honest NULL.
try {
  const pricing = turnPricing.attachTurnPricing({ modelsProvider: async () => (ctx.dshModels ?? []).map((m) => m.id) });
  ctx.turnPricingWarmup = pricing.warmup;
  pricing.warmup.then((r) => {
    if (r?.ok) console.log(`[turn-pricing] warmed: ${r.cached} model(s) priced`);
    else console.log(`[turn-pricing] degraded: ${r?.reason ?? "unavailable"}`);
  }).catch(() => {});
} catch (e) {
  console.warn(`[turn-pricing] attach failed (degrade open): ${e?.message || e}`);
}
// Fleet cost weekly digest (add-fleet-memory-anchors 补丁4): one 成本周报 page
// per active fleet per ISO week into `f/` — the metering axis feeding the
// memory axis (L2 distiller fuel). Degrade open everywhere.
try {
  const { attachFleetCostDigest } = await import("./server/fleet-cost-digest.js");
  attachFleetCostDigest({
    fleetsDb: getFleetDatabase(),
    captureFact: (fleetId, memberId, kind, title, body) => {
      try { ctx.captureFleetFact?.(fleetId, memberId === "fleet" ? null : memberId, kind, title, body); } catch { /* degrade */ }
    },
    listActiveFleets: () => getFleetDatabase().listFleets().filter((f) => f.state === "active"),
  });
} catch (e) {
  console.warn(`[fleet-cost-digest] attach failed (degrade open): ${e?.message || e}`);
}
// Model-surface budget gate (add-model-surface-budget-gate 4.1)：引擎挂 ctx
// （walk 注记 probe + 结算缝消费都读它），reset 定时器管 UTC 日/月界翻页与
// 01:00 UTC 日报。MODEL_BUDGET_ENABLED 未开=引擎照挂（probe 恒 allowed、
// consume 空转），开销是一次 60s tick 的日界比较——开关语义留在引擎内，
// 接线无分支。degrade-open：建引擎失败只留 warn，平台照常起。
try {
  const { createBudgetEngine, budgetConfigFromEnv, attachModelBudgetReset } = await import("./server/model-budget.js");
  ctx.modelBudget = createBudgetEngine({ db: getFleetDatabase(), config: budgetConfigFromEnv(process.env) });
  attachModelBudgetReset({
    engine: ctx.modelBudget,
    captureFact: (report, hot) => {
      try {
        ctx.captureFleetFact?.("fleet", null, "budget", `模型预算日报`, `exhausted=${JSON.stringify(report.exhaustedEvents)} hot=[${hot.map((x) => `${x.model}/${x.tier}/${((x.utilization ?? 0) * 100).toFixed(0)}%`).join(", ")}]`);
      } catch { /* degrade */ }
    },
  });
  if (ctx.modelBudget.config.enabled) {
    console.log(`[model-budget] enabled: single=${ctx.modelBudget.config.single} daily=${ctx.modelBudget.config.daily} monthly=${ctx.modelBudget.config.monthly}`);
  }
} catch (e) {
  console.warn(`[model-budget] attach failed (degrade open): ${e?.message || e}`);
  ctx.modelBudget = null;
}
console.log("Platform fully initialized");

// ── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  cron.shutdown();
  ctx.workerPool?.shutdown();
  bots.stopAll();
  catalog.stopCatalog();
  stopRegistryBridge();
  packRegistry?.close();
  await trace.shutdownTrace();
  try {
    await ctx.dshBridge?.shutdown();
  } catch (err) {
    console.error("[shutdown] dsh bridge failed:", err.message);
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The satellite host owns child processes; they must not outlive the cell.
process.on("exit", () => { try { void ctx.mcpSatelliteHost?.stop?.(); } catch { /* best-effort */ } });
