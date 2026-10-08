#!/usr/bin/env node
// ── Sessionless lanes stay gateway-level (migrate-fd-prod-cells, tasks 3.1–3.2)
//
// Boots the REAL gateway against a pre-seeded shared packs.db and proves the
// corrected architecture (design D4 revision): the anonymous pack skill-md
// route is answered by the gateway from its own registry with ZERO cell
// spawns, an unknown pack fails closed the same way, and the deploy lane is
// identity-gated before anything else happens. CELL_SERVER_ENTRY points at a
// canary stub — if any cell were spawned, its marker file appears and every
// assertion fails.
//
//   node scripts/test-gateway-sessionless.mjs

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackRegistry } from "../gateway/packs.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "sessionless-test-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = netServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The canary cell: if the gateway ever spawns a cell for sessionless traffic,
// this marker appears and the test fails loudly.
async function writeCanaryStub(root) {
  const stub = path.join(root, "canary-cell.mjs");
  const marker = path.join(root, "CELL-WAS-SPAWNED");
  await writeFile(
    stub,
    `import http from "node:http";
import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(marker)}, new Date().toISOString());
http.createServer((req, res) => res.end("canary")).listen(process.env.PORT, "127.0.0.1");
`,
  );
  return { stub, marker };
}

async function startOidcStub() {
  const port = await freePort();
  const server = (await import("node:http")).createServer((req, res) => {
    const base = `http://127.0.0.1:${port}`;
    res.setHeader("content-type", "application/json");
    if (req.url.includes("openid-configuration")) {
      return res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/oidc/auth`,
          token_endpoint: `${base}/oidc/token`,
          jwks_uri: `${base}/oidc/jwks`,
          end_session_endpoint: `${base}/oidc/session/end`,
        }),
      );
    }
    if (req.url.includes("jwks")) return res.end(JSON.stringify({ keys: [] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

async function main() {
  const failures = [];
  const root = await mkdtemp(path.join(tmpdir(), "gw-sessionless-"));
  const dataRoot = path.join(root, "cells");
  await mkdir(dataRoot, { recursive: true });

  // Seed the shared pack registry the way a creator publish would: one pack,
  // one version, one skill body.
  const registry = createPackRegistry({ file: path.join(dataRoot, "packs.db") });
  const published = registry.publish({
    email: "author@sessionless.test",
    manifest: {
      name: "sessionless-probe",
      description: "pack seeded for the sessionless lane test",
      tags: ["test"],
      skills: [{ name: "probe-skill", description: "probe body", content: "# probe body\nline two\n" }],
      agents: [],
      mcpServers: [],
    },
  });
  registry.close();
  if (!published?.id) throw new Error(`seed publish failed: ${JSON.stringify(published)}`);
  const packId = published.id;

  const { stub, marker } = await writeCanaryStub(root);
  const oidc = await startOidcStub();

  const gwPort = await freePort();
  const gw = spawn(process.execPath, [path.join(REPO, "gateway/index.js")], {
    cwd: REPO,
    env: {
      ...process.env,
      GATEWAY_PORT: String(gwPort),
      GATEWAY_HOST: "127.0.0.1",
      CELL_DATA_ROOT: dataRoot,
      CELL_GATEWAY_SECRET: SECRET,
      CELL_IDLE_REAP_SECS: "0",
      CELL_START_TIMEOUT_MS: "15000",
      CELL_SERVER_ENTRY: stub,
      SESSION_SECRET: "sessionless-session-secret",
      LOGTO_ENDPOINT: `http://127.0.0.1:${oidc.port}`,
      LOGTO_APP_ID: "test-app",
      LOGTO_APP_SECRET: "test-secret",
      LOGTO_CLIENT_TYPE: "confidential",
      PAAS_BASE_URL: "",
      AUTH_MODE: "none",
      CLOUD_MODE: "",
      LLM_API_KEY: "",
      PACK_CREATOR_GROUPS: "creators",
      AGENT_SERVING_RUNNER_URL: "http://127.0.0.1:1",
      AGENT_SERVING_PACKS_URL: "http://127.0.0.1:1",
      AGENT_SERVING_BACKEND_TOKEN: "dummy",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  gw.stdout.on("data", (b) => logs.push(`[out] ${b}`));
  gw.stderr.on("data", (b) => logs.push(`[err] ${b}`));

  const base = `http://127.0.0.1:${gwPort}`;
  try {
    let healthy = false;
    for (let i = 0; i < 80 && !healthy; i++) {
      if (gw.exitCode !== null) throw new Error(`gateway exited early:\n${logs.join("")}`);
      try {
        healthy = (await fetch(`${base}/healthz`)).ok;
      } catch { /* not listening yet */ }
      if (i === 79) throw new Error(`gateway never became healthy:\n${logs.join("")}`);
      if (!healthy) await sleep(250);
    }

    const noSpawn = () =>
      !existsSync(marker) || failures.push(`a cell WAS spawned (marker ${marker} exists) — the sessionless lane must cost zero cells`);

    // 3.1 — anonymous pack skill md, served by the gateway from its registry.
    const md = await fetch(`${base}/api/packs/${packId}/versions/1/skills/probe-skill.md`);
    const mdBody = md.status === 200 ? await md.text() : "";
    if (md.status !== 200) failures.push(`anonymous skill md answered ${md.status}, expected 200`);
    if (!mdBody.includes("name: \"probe-skill\"") || !mdBody.includes("# probe body")) {
      failures.push(`skill md body wrong: ${JSON.stringify(mdBody.slice(0, 120))}`);
    }
    noSpawn();

    // 3.1 — unknown pack fails closed, still no cell.
    const ghost = await fetch(`${base}/api/packs/no-such-pack/versions/1/skills/x.md`);
    if (ghost.status !== 404) failures.push(`unknown pack md answered ${ghost.status}, expected 404`);
    noSpawn();

    // 3.2 — the deploy lane is identity-gated before anything runs.
    const deploy = await fetch(`${base}/api/packs/${packId}/versions/1/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (deploy.status !== 401) failures.push(`anonymous deploy answered ${deploy.status}, expected 401`);
    noSpawn();

    console.log(`skill md: HTTP ${md.status}, ${mdBody.length} bytes (frontmatter + body)`);
    console.log(`unknown pack: HTTP ${ghost.status}`);
    console.log(`anonymous deploy: HTTP ${deploy.status}`);
  } finally {
    gw.kill("SIGTERM");
    await sleep(300);
    if (gw.exitCode === null) gw.kill("SIGKILL");
    await oidc.close();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  if (failures.length) {
    console.error(`\n✗ sessionless lanes: ${failures.length} failure(s)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n✓ sessionless lanes: gateway-owned md, closed unknowns, gated deploy, zero cells");
}

main().catch((err) => {
  console.error(`✗ sessionless run failed: ${err.message}`);
  process.exitCode = 1;
});
