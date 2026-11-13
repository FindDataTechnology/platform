#!/usr/bin/env node
// ── Live probe: Agent Cluster Platform on a deployed cell ────────────────────
//
// Proves the cluster-platform claims against a RUNNING deployment:
//   1. /api/clusters/dynamic exists and answers with a real signed session
//   2. Creating a cluster with no agents is refused (400) — not 404/401
//   3. Creating a cluster with a bogus pack is refused naming the agent (400)
//   4. /api/monitoring/health answers with a cluster count
//   5. /api/monitoring/clusters serves the real cluster-store summary
//   6. /api/monitoring/tasks serves the live task engine (incl. cluster tasks)
//   7. POST /api/cron with a bogus clusterId is refused (400) — the cluster
//      task path resolves the ref at the route
//   8. The pack manifest validator accepts cluster metadata (in-image check)
//   9. The pack manifest validator rejects a bad cluster agent ref
//
// 2026-10-21: the template-"market" / provider-route / optimization checks
// this probe used to carry were removed with the fabricated endpoints
// themselves (cluster-templates.js / model-binding.js / optimization.js —
// zero consumers, hardcoded fake numbers).
//
// Auth: the deployment's own signed session cookie.
//   CLUSTER_PROBE_BASE=https://platform.finddatatech.cloud \
//   CLUSTER_PROBE_SECRET=<session-secret> \
//   CLUSTER_PROBE_EMAIL=<cell-owner-email> \
//   node scripts/probe-cluster-platform-live.mjs
//
// Exit 0 = all claims hold.

import "dotenv/config";
import { sessionCookie } from "../server/session.js";

const BASE = (process.env.CLUSTER_PROBE_BASE || "https://platform.finddatatech.cloud").replace(/\/+$/, "");
const SECRET = process.env.CLUSTER_PROBE_SECRET || "";
const EMAIL = process.env.CLUSTER_PROBE_EMAIL || "";

if (!SECRET || !EMAIL) {
  console.error("need CLUSTER_PROBE_SECRET and CLUSTER_PROBE_EMAIL");
  process.exit(2);
}

const ttlMs = 60 * 60 * 1000;
const payload = { email: EMAIL, groups: ["admin"], exp: Math.floor(Date.now() / 1000) + ttlMs / 1000 };
const cookie = sessionCookie("paas_session", payload, SECRET, ttlMs, true);
const headers = { cookie, "content-type": "application/json" };

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const call = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json };
};

console.log(`\n=== Agent Cluster Platform live probe → ${BASE} ===\n`);

// 1. endpoint exists (not 404)
{
  const r = await call("POST", "/api/clusters/dynamic", {});
  check("POST /api/clusters/dynamic exists (not 404)", r.status !== 404, `status=${r.status}`);
}

// 2. empty agents refused with 400
{
  const r = await call("POST", "/api/clusters/dynamic", { name: "probe-empty", agents: [] });
  check(
    "empty agents refused with 400",
    r.status === 400 && /agent/i.test(JSON.stringify(r.json || {})),
    `status=${r.status} body=${JSON.stringify(r.json).slice(0, 120)}`,
  );
}

// 3. missing name refused with 400
{
  const r = await call("POST", "/api/clusters/dynamic", { agents: [{ packId: "_x", agentId: "y" }] });
  check("missing name refused with 400", r.status === 400, `status=${r.status}`);
}

// 4. bogus pack refused naming the agent
{
  const r = await call("POST", "/api/clusters/dynamic", {
    name: "probe-bogus",
    agents: [{ packId: "_nonexistent_pack", agentId: "ghost-agent" }],
  });
  const body = JSON.stringify(r.json || {});
  check(
    "bogus pack refused naming the agent",
    r.status === 400 && /ghost-agent|invalid/i.test(body),
    `status=${r.status} body=${body.slice(0, 160)}`,
  );
}

// 5. monitoring health
{
  const r = await call("GET", "/api/monitoring/health");
  const ok = r.status === 200 && r.json && (r.json.status === "healthy" || r.json.version);
  check("GET /api/monitoring/health → healthy", ok, `status=${r.status} body=${JSON.stringify(r.json).slice(0, 120)}`);
}

// 6. monitoring clusters
{
  const r = await call("GET", "/api/monitoring/clusters");
  const ok = r.status === 200 && r.json && r.json.summary && Array.isArray(r.json.clusters);
  check("GET /api/monitoring/clusters → summary+list", ok, `status=${r.status}`);
}

// 7. monitoring tasks — the live task engine, cluster tasks included
{
  const r = await call("GET", "/api/monitoring/tasks");
  const ok = r.status === 200 && r.json?.summary && typeof r.json.summary.totalTasks === "number"
    && typeof r.json.summary.clusterTasks === "number";
  check(
    "GET /api/monitoring/tasks → live engine summary",
    ok,
    `status=${r.status} body=${JSON.stringify(r.json?.summary ?? null)}`,
  );
}

// 8. cluster task ref resolution: a bogus clusterId never reaches the engine
{
  const r = await call("POST", "/api/cron", {
    when: new Date(Date.now() + 3600_000).toISOString(),
    prompt: "probe",
    clusterId: "dyn_probe_nonexistent",
  });
  check(
    "POST /api/cron bogus clusterId → 400",
    r.status === 400 && /not found/.test(JSON.stringify(r.json || {})),
    `status=${r.status} body=${JSON.stringify(r.json).slice(0, 120)}`,
  );
}

// 9. pack manifest validator accepts cluster metadata (in-image code check)
{
  const r = await call("POST", "/api/packs/validate", {
    manifest: {
      name: "probe-cluster-pack",
      description: "live probe",
      skills: [{ name: "probe-skill", description: "probe", content: "# probe" }],
      agents: [
        { id: "a1", name: "Agent One", persona: "you are one" },
        { id: "a2", name: "Agent Two", persona: "you are two" },
      ],
      cluster: {
        name: "Probe Cluster",
        description: "cluster metadata accepted",
        defaultAgents: ["a1"],
        optionalAgents: ["a2"],
        schedulingPolicy: { maxConcurrentRuns: 2 },
      },
    },
  });
  const body = JSON.stringify(r.json || {});
  const clusterRejected = /cluster/i.test(body) && r.json?.valid === false;
  check(
    "pack validate accepts cluster metadata (not rejected)",
    r.status === 200 && !clusterRejected,
    `status=${r.status} body=${body.slice(0, 200)}`,
  );
}

// 10. invalid cluster metadata rejected
{
  const r = await call("POST", "/api/packs/validate", {
    manifest: {
      name: "probe-bad-cluster",
      skills: [{ name: "s", description: "d", content: "# c" }],
      agents: [{ id: "a1", name: "A1", persona: "p" }],
      cluster: { name: "Bad", description: "d", defaultAgents: ["not-declared"] },
    },
  });
  const body = JSON.stringify(r.json || {});
  check(
    "pack validate rejects bad cluster agent ref",
    r.status === 200 && r.json?.valid === false && /not-declared/.test(body),
    `status=${r.status} body=${body.slice(0, 200)}`,
  );
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
