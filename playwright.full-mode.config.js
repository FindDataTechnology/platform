// ── Full-mode tool scope e2e config (full-mode-tool-scope 4.3) ──────────────
//
// A second hermetic cell with FULL_MODE_TOOL_SCOPE=on. The main config's
// webServer env is fixed before tests run, so the flag needs its own server.
// A distinct port + store root keep it independent of the fast suite.

import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

process.env.E2E_PORT = process.env.E2E_PORT || "3110";

const { E2E_PORT, E2E_FACET_PORT, baseURL, prepareTempStoreDirs } = await import("./e2e/helpers.js");

const E2E_FAKE_MCP_PORT = Number(process.env.E2E_FAKE_MCP_PORT) || 3199;
const E2E_CIYUAN_PORT = Number(process.env.E2E_CIYUAN_PORT) || 3197;
const E2E_REGISTRY_URL = process.env.E2E_REGISTRY_URL || "http://127.0.0.1:4599";
const E2E_REGISTRY_TOKEN = process.env.E2E_REGISTRY_TOKEN || "e2e-registry-token";
const E2E_FACET_URL = process.env.E2E_FACET_URL || `http://127.0.0.1:${E2E_FACET_PORT}`;
const E2E_FACET_TOKEN = process.env.E2E_FACET_TOKEN || "e2e-facet-token";

const storeDirs = prepareTempStoreDirs();

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  globalTeardown: "./e2e/teardown.js",
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    {
      name: "full-mode",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /full-mode-tool-scope\.spec\.js/,
    },
  ],
  webServer: {
    command: `node e2e/registry-stub.js & node e2e/facet-stub.js & node e2e/fake-mcp.js & node e2e/ciyuan-stub.js & node e2e/facet-shell-server.mjs & node e2e/dead-llm.js & node e2e/seed-fixtures.js && node server.js`,
    url: `http://127.0.0.1:${E2E_PORT}/api/ready`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(E2E_PORT),
      HOST: "127.0.0.1",
      // The switch under test: full mode derives the installed-pack union.
      FULL_MODE_TOOL_SCOPE: "on",
      LLM_API_KEY: process.env.LLM_API_KEY || "sk-e2e-dummy-key",
      // Same dead-llm contract as the main config: 401 = AUTH = non-retryable,
      // no TRANSPORT backoff ladder. Own port (3188): the main config's stub
      // sits on 3187, and the two suites can run as parallel sessions.
      LLM_BASE_URL: process.env.LLM_BASE_URL || "http://127.0.0.1:3188/v1",
      E2E_DEAD_LLM_PORT: process.env.E2E_DEAD_LLM_PORT || "3188",
      SEARCH_RELAY_URL: process.env.SEARCH_RELAY_URL || "http://127.0.0.1:4598",
      SEARCH_RELAY_TOKEN: process.env.SEARCH_RELAY_TOKEN || "e2e-relay-dummy-token",
      AGENTS_CONFIG_URL: "",
      PACK_USAGE_TOKEN: process.env.PACK_USAGE_TOKEN || "e2e-pack-usage-token",
      CHAT_HISTORY_STORE_DIR: storeDirs.chat,
      DOCUMENTS_STORE_DIR: storeDirs.docs,
      SESSIONS_STORE_DIR: storeDirs.sessions,
      DB_PATH: storeDirs.db,
      PLATFORM_DATA_DIR: storeDirs.root,
      MCP_CONFIG_PATH: path.join(storeDirs.root, "mcp.json"),
      LLM_PROVIDERS_STORE: process.env.LLM_PROVIDERS_STORE || storeDirs.llmProviders,
      LLM_DEFAULT_STORE: process.env.LLM_DEFAULT_STORE || storeDirs.llmDefault,
      DSH_HOME: storeDirs.dshHome,
      MARKET_REGISTRY_URL: process.env.MARKET_REGISTRY_URL || E2E_REGISTRY_URL,
      MARKET_REGISTRY_TOKEN: process.env.MARKET_REGISTRY_TOKEN || E2E_REGISTRY_TOKEN,
      AGENT_SERVING_BACKEND_TOKEN: process.env.AGENT_SERVING_BACKEND_TOKEN || "e2e-a2a-dummy",
      AGENT_SERVING_REGISTRY_URL: process.env.AGENT_SERVING_REGISTRY_URL || E2E_REGISTRY_URL,
      AGENT_SERVING_RUNNER_URL: process.env.AGENT_SERVING_RUNNER_URL || "http://127.0.0.1:8790",
      AGENT_SERVING_PACKS_URL: process.env.AGENT_SERVING_PACKS_URL || `http://127.0.0.1:${E2E_PORT}`,
      MARKET_REGISTRY_TTL_SECS: process.env.MARKET_REGISTRY_TTL_SECS || "300",
      PACK_MARKETPLACE: process.env.PACK_MARKETPLACE || "1",
      E2E_USER_GROUPS: process.env.E2E_USER_GROUPS || "creators",
      FACET_BASE_URL: process.env.FACET_BASE_URL || E2E_FACET_URL,
      FACET_INTERNAL_TOKEN: process.env.FACET_INTERNAL_TOKEN || E2E_FACET_TOKEN,
      E2E_FACET_PORT: String(E2E_FACET_PORT),
      FAKE_MCP_PORT: String(E2E_FAKE_MCP_PORT),
      CIYUAN_API_BASE: `http://127.0.0.1:${E2E_CIYUAN_PORT}`,
      CIYUAN_MINT_GROUP_ID: "3",
      E2E_CIYUAN_PORT: String(E2E_CIYUAN_PORT),
      DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
    },
  },
});
