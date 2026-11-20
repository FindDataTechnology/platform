#!/usr/bin/env node
// ── Spike: local registry-compatible feed (add-local-fleet-control-plane 1.1) ─
//
// Serves the exact registry read surface agent-runner's client consumes
// (agent-runner/registry.js): GET /api/agents with limit/offset pagination and
// GET /api/skills<path>/content. Purpose: prove the runner needs ZERO code
// changes to take its roster from a local feed — only the URL pointer changes.
//
// Usage:
//   node scripts/spike-local-feed.mjs --port 8795 --agents 2 --seat spike-seat \
//     [--token <bearer>] [--golden <path>] [--extra-foreign <n>]
//
// --extra-foreign adds entries tagged to ANOTHER runner id, to prove the
// sharding filter keeps them off this seat's roster.

import http from "node:http";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};

const PORT = Number(arg("port", "8795"));
const AGENT_COUNT = Number(arg("agents", "2"));
const FOREIGN = Number(arg("extra-foreign", "1"));
const SEAT = arg("seat", "spike-seat");
const TOKEN = arg("token", "");
const GOLDEN = arg("golden", "");
const PACK_ID = arg("pack", "spike-demo");

const SKILL_PATH = `/skills/${PACK_ID}/demo.md`;
const SKILL_BODY = "# Demo skill\n\nSpike fixture body — proves skill-body retrieval over the feed.\n";

function entry(i, { foreign = false } = {}) {
  const agentId = foreign ? `foreign-agent-${i}` : `agent-${i}`;
  return {
    path: `packs/${PACK_ID}/${agentId}`,
    name: foreign ? `Foreign ${i}` : `Spike Agent ${i}`,
    description: "Spike roster entry (local feed fixture)",
    version: "1.0.0",
    supported_protocol: "a2a",
    is_enabled: true,
    skills: [SKILL_PATH],
    tags: ["spike"],
    metadata: {
      packId: PACK_ID,
      packVersion: 1,
      agentId,
      persona: `spike-persona-${i}`,
      skills: [SKILL_PATH],
      // Sharding (add-runner-fleet-sharding D1): tagged entries belong to
      // that runner; the client filters on this exact field.
      runner_id: foreign ? "other-seat" : SEAT,
    },
  };
}

const AGENTS = [
  ...Array.from({ length: AGENT_COUNT }, (_, i) => entry(i + 1)),
  ...Array.from({ length: FOREIGN }, (_, i) => entry(i + 1, { foreign: true })),
];

const log = (m) => console.log(`[spike-feed] ${m}`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  log(`${req.method} ${url.pathname}${url.search}`);

  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing feed credential" }));
    return;
  }

  if (url.pathname === "/api/agents" && req.method === "GET") {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 20));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const page = AGENTS.slice(offset, offset + limit);
    const body = {
      agents: page,
      total_count: AGENTS.length,
      has_next: offset + page.length < AGENTS.length,
    };
    if (GOLDEN) writeFileSync(GOLDEN, JSON.stringify(body, null, 2) + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  if (url.pathname.startsWith("/api/skills/") && url.pathname.endsWith("/content")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: SKILL_BODY }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  log(`listening on 127.0.0.1:${PORT} — ${AGENT_COUNT} seat entries, ${FOREIGN} foreign entries, seat=${SEAT}`);
  log(`serve: AGENT_SERVING_REGISTRY_URL=http://127.0.0.1:${PORT} AGENT_RUNNER_FLEET_ID=${SEAT}`);
});
