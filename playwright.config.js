import path from "node:path";
import os from "node:os";
import { defineConfig, devices } from "@playwright/test";
import { E2E_FACET_PORT, E2E_PORT, baseURL, prepareTempStoreDirs } from "./e2e/helpers.js";

// Live service testing: target the deployed k3s NodePort. The live project has
// NO webServer - it connects to an already-running external URL. Read-only checks
// (no chat history writes, no document uploads, no LLM tokens spent) except the
// opt-in @live-smoke chat-turn gated behind LIVE_SMOKE=1.
//
// Playwright's root-level `webServer` applies to ALL projects, so the live
// scripts set PW_LIVE=1 to skip both the local-server launch and the temp-store
// dir setup (the live suite touches neither).
const PW_LIVE = process.env.PW_LIVE === "1";
// The hermetic registry stand-in (e2e/registry-stub.js) and its service token:
// the fast/smoke projects' server talks to this instead of the live registry.
// The fake open-data MCP's port (chart data binding e2e).
const E2E_FAKE_MCP_PORT = Number(process.env.E2E_FAKE_MCP_PORT) || 3199;
const E2E_CIYUAN_PORT = Number(process.env.E2E_CIYUAN_PORT) || 3197;
const E2E_REGISTRY_URL = process.env.E2E_REGISTRY_URL || "http://127.0.0.1:4599";
const E2E_REGISTRY_TOKEN = process.env.E2E_REGISTRY_TOKEN || "e2e-registry-token";
// The hermetic facet stand-in (e2e/facet-stub.js): the cell's install endpoint
// fetches pack manifests server-side over the facet channel, so the suite
// needs a facet that answers GET /api/packs/:id/versions/:version under the
// same internal credential + forwarded identity the live service expects.
// Port/URL come from e2e/helpers.js — the specs talk to the stub too, and the
// two sides must not drift.
const E2E_FACET_URL = process.env.E2E_FACET_URL || `http://127.0.0.1:${E2E_FACET_PORT}`;
const E2E_FACET_TOKEN = process.env.E2E_FACET_TOKEN || "e2e-facet-token";
const LIVE_SERVICE_URL = process.env.LIVE_SERVICE_URL || "http://23.144.68.246:30950";

// Create throwaway store directories before the server boots so the suite never
// touches the project's real chat-history-store/ or documents-store/. Skipped for
// the live project (no local server, no temp dirs).
const storeDirs = PW_LIVE ? null : prepareTempStoreDirs();

export default defineConfig({
  testDir: "./e2e",
  // The server hosts ONE shared agent session, so tests must run sequentially.
  workers: 1,
  fullyParallel: false,
  // CI-only flake retries: the shared-runtime suite has order/load-sensitive
  // specs (agent-serving's first fetch, model-switch restart timing) that
  // pass solo; deterministic failures still surface after the retries.
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  timeout: 60_000,
  // The live suite doesn't create temp dirs and needs no fixtures; the fast
  // suite seeds gitignored data files (agents.json / mcp.json) when absent.
  ...(PW_LIVE ? {} : { globalTeardown: "./e2e/teardown.js" }),
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  // fast: deterministic, no-LLM tests (default). smoke: the real chat-turn test
  // that makes one LLM call. `npm run test:e2e` runs fast; `test:e2e:smoke`
  // runs both. live: read-only tests against the deployed k3s NodePort (no
  // webServer, no temp store dirs).
  projects: [
    {
      name: "fast",
      use: {
        ...devices["Desktop Chrome"],
        // voice-lane: a fake microphone (a real audio track, so MediaRecorder
        // produces bytes without a device or a permission prompt) and no
        // autoplay gate (so the 朗读 player's play() resolves headlessly).
        launchOptions: {
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
        },
      },
      // Exclude @smoke (real LLM call) AND @live (deployed-service tests that
      // belong only to the `live` project - they would otherwise run against
      // the local 127.0.0.1 server and assert the wrong things).
      grepInvert: /@smoke|@live/,
      // full-mode-tool-scope owns a SECOND hermetic cell: its own config
      // (playwright.full-mode.config.js) boots port 3110 with
      // FULL_MODE_TOOL_SCOPE=on, which is exactly the flag this project leaves
      // OFF (documented default; the rollback lever). Collected here, every one
      // of its union assertions runs against a server that never composes the
      // union, so it failed for a reason no assertion of ours could express —
      // it looked like a product regression for weeks. Run it with
      //   E2E_PORT=3110 npx playwright test --config=playwright.full-mode.config.js
      testIgnore: /full-mode-tool-scope\.spec\.js/,
    },
    {
      name: "smoke",
      use: { ...devices["Desktop Chrome"] },
      grep: /@smoke/,
    },
    // Live project - targets deployed k3s NodePort at http://23.144.68.246:30950
    // (overridable via LIVE_SERVICE_URL env). Runs only `@live` tagged tests,
    // NEVER spawns a local server (PW_LIVE=1 skips the root webServer), NEVER
    // creates temp store dirs. `--proxy-server=direct://` forces direct
    // connections because the dev machine has a macOS system HTTP proxy
    // (127.0.0.1:7892) that 502s the deployed LAN IP and breaks the WebSocket
    // upgrade; the local fast/smoke projects are unaffected (they hit 127.0.0.1,
    // which is in the system proxy bypass list).
    {
      name: "live",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: LIVE_SERVICE_URL,
        launchOptions: { args: ["--proxy-server=direct://"] },
      },
      grep: /@live/,
    },
  ],
  // The local-server webServer is only defined for the non-live projects.
  ...(PW_LIVE
    ? {}
    : {
        webServer: {
          // The registry stub runs in the background of this same command
          // (same process group, so Playwright's teardown kills it): the market
          // then carries registry entries and the connect popup can mint
          // against a hermetic stand-in instead of the live registry.
          command: `node e2e/registry-stub.js & node e2e/facet-stub.js & node e2e/fake-mcp.js & node e2e/ciyuan-stub.js & node e2e/facet-shell-server.mjs & node e2e/dead-llm.js & node e2e/seed-fixtures.js && node server.js`,
          // The server listens FIRST and initializes the agent in the
          // background (listen-first boot) — readiness must gate on the
          // agent, not the port, or tests would race a half-booted server.
          //
          // NOTE — this probe watches the 壹座 server only. The facet shell
          // (E2E_FACET_SHELL_PORT, default 3209) is a SEPARATE process that
          // rebuilds facet/web BEFORE it listens (~20s cold), so on a fresh
          // worktree or cold cache the first facet-shell tests can open 3209
          // before anything is bound and fail with ERR_CONNECTION_REFUSED —
          // the code is fine, the harness is early. Prebuild, then skip the
          // in-server build:
          //   (cd facet/web && npm run build)
          //   FACET_SHELL_SKIP_BUILD=1 npx playwright test e2e/facet-shell.spec.js
          // A fresh worktree also lacks the gitignored app bundle, so 壹座
          // pages (e.g. market-card-relation) need `npm run web:build:e2e`.
          url: `http://127.0.0.1:${E2E_PORT}/api/ready`,
          // server.js listens only after dsh init completes; a cold first
          // spawn (fresh profile composition, e.g. on a CI runner) can
          // exceed 60s.
          timeout: 180_000,
          reuseExistingServer: false,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PORT: String(E2E_PORT),
            HOST: "127.0.0.1",
            // Hermetic-mode defaults: only fill gaps — dotenv keeps real .env values.
            // LLM_BASE_URL points at the dead-llm stub (401 → AUTH → non-retryable):
            // turns fail in one roundtrip instead of burning the TRANSPORT retry
            // ladder a closed port triggers (24-36s, the dead-LLM flake family).
            LLM_API_KEY: process.env.LLM_API_KEY || "sk-e2e-dummy-key",
            LLM_BASE_URL: process.env.LLM_BASE_URL || "http://127.0.0.1:3187/v1",
            E2E_DEAD_LLM_PORT: process.env.E2E_DEAD_LLM_PORT || "3187",
            // Relay pair for the bundled websearch MCP: dummy values prove the
            // envRefs forwarding (dsh's subprocess scrub would strip a
            // TOKEN-shaped ambient name; the patch entry must carry it
            // explicitly). Nothing calls the relay in the fast suite.
            SEARCH_RELAY_URL: process.env.SEARCH_RELAY_URL || "http://127.0.0.1:4598",
            SEARCH_RELAY_TOKEN: process.env.SEARCH_RELAY_TOKEN || "e2e-relay-dummy-token",
            AGENTS_CONFIG_URL: "",
            // Ops credential for the pack-usage aggregate read (add-pack-usage-telemetry
            // e2e): the fast suite asserts the endpoint against the local server.
            PACK_USAGE_TOKEN: process.env.PACK_USAGE_TOKEN || "e2e-pack-usage-token",
            CHAT_HISTORY_STORE_DIR: storeDirs.chat,
            DOCUMENTS_STORE_DIR: storeDirs.docs,
            SESSIONS_STORE_DIR: storeDirs.sessions,
            DB_PATH: storeDirs.db,
            // Root for stores that have no specific override — notably
            // uploads/, which attachment preview now writes the original into.
            // Without this the suite drops uploaded files in the repo root.
            PLATFORM_DATA_DIR: storeDirs.root,
            MCP_CONFIG_PATH: path.join(storeDirs.root, "mcp.json"),
            // Hermetic by default (no user providers, no saved default). A
            // smoke run that needs a REAL model — the smoke project makes live
            // calls — exports these two pointing at the repo's stores, which
            // brings the user-provider routes and their keys with them.
            LLM_PROVIDERS_STORE: process.env.LLM_PROVIDERS_STORE || storeDirs.llmProviders,
            LLM_DEFAULT_STORE: process.env.LLM_DEFAULT_STORE || storeDirs.llmDefault,
            // dsh's own home (profile composition, settings.yaml, credentials,
            // persisted session logs) defaults to the developer's real ~/.dsh.
            // Point it at the throwaway store so a run cannot rewrite the live
            // settings.yaml — whose baseURL this env deliberately fakes — or
            // leave session logs whose ids collide with real ones. The installed
            // dsh tree still resolves from the real home via DSH_SHARED_HOME.
            DSH_HOME: storeDirs.dshHome,
            // Registry source: the stub above, so registry-origin entries,
            // credential injection and the silent-SSO mint are all reachable
            // without a network dependency.
            MARKET_REGISTRY_URL: process.env.MARKET_REGISTRY_URL || E2E_REGISTRY_URL,
            MARKET_REGISTRY_TOKEN: process.env.MARKET_REGISTRY_TOKEN || E2E_REGISTRY_TOKEN,
            // a2a client branch (add-a2a-agent-serving): dummy values satisfy
            // the server-side credential presence checks; the A2A stub in
            // agent-serving.spec.js accepts any bearer.
            AGENT_SERVING_BACKEND_TOKEN: process.env.AGENT_SERVING_BACKEND_TOKEN || "e2e-a2a-dummy",
            // Serving deploy/config plane (agent-service-config): the packs
            // deploy + service-config routes need a registry (the stub above),
            // a runner base (never contacted by the config path — the runner
            // itself is out of the fast lane), and a public packs origin.
            AGENT_SERVING_REGISTRY_URL: process.env.AGENT_SERVING_REGISTRY_URL || E2E_REGISTRY_URL,
            AGENT_SERVING_RUNNER_URL: process.env.AGENT_SERVING_RUNNER_URL || "http://127.0.0.1:8790",
            AGENT_SERVING_PACKS_URL: process.env.AGENT_SERVING_PACKS_URL || `http://127.0.0.1:${E2E_PORT}`,
            MARKET_REGISTRY_TTL_SECS: process.env.MARKET_REGISTRY_TTL_SECS || "300",
            // Pack marketplace surfaces (add-pack-marketplace): the gateway
            // plane (/api/packs...) is route-mocked per spec; this flag turns
            // the packs Settings section on for the specs that exercise it.
            PACK_MARKETPLACE: process.env.PACK_MARKETPLACE || "1",
            // The auth-off machine owner's groups (agent-service-config e2e):
            // lets the real publish route pass its creator gate. Other specs
            // mock the gateway plane and never observe the difference.
            E2E_USER_GROUPS: process.env.E2E_USER_GROUPS || "creators",
            // Pack manifests are fetched SERVER-side from the market
            // (pack-install-server-side-manifest): the stub above is the
            // facet the cell's install fetch addresses. Its data route only
            // answers under this internal credential, mirroring facet.
            FACET_BASE_URL: process.env.FACET_BASE_URL || E2E_FACET_URL,
            FACET_INTERNAL_TOKEN: process.env.FACET_INTERNAL_TOKEN || E2E_FACET_TOKEN,
            E2E_FACET_PORT: String(E2E_FACET_PORT),
            // The chart-data-binding fake upstream: a streamable-http MCP whose
            // scenarios (data, failures, gate stats) a spec drives over its
            // control route. Fixed port so the seeded extension config can name
            // it; the specs that use it install the server themselves.
            FAKE_MCP_PORT: String(E2E_FAKE_MCP_PORT),
            // The 词元 account binding (ciyuan-account-lane) logs in and mints
            // server-side against this fake gateway; specs flip its scenarios
            // over POST /__mode. Group 3 mirrors production's deployment key.
            CIYUAN_API_BASE: `http://127.0.0.1:${E2E_CIYUAN_PORT}`,
            CIYUAN_MINT_GROUP_ID: "3",
            E2E_CIYUAN_PORT: String(E2E_CIYUAN_PORT),
            DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
          },
        },
      }),
});
