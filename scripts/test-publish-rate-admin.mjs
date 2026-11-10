// Admin exemption on the publish rate limit (wire-content-fleet follow-up):
// public authors ride the anti-abuse budget; admin-group maintainers do not.
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";
import express from "express";
import http from "node:http";

function minimalManifest(name) {
  return {
    name,
    description: "d".repeat(10),
    tags: ["t"],
    visibility: "public",
    skills: [],
    mcpServers: [],
    agents: [{ id: "a1", name: "A", persona: "p".repeat(10) }],
  };
}

async function harness({ user, rateMax }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rate-"));
  const registry = createPackRegistry({ file: path.join(dir, "packs.db") });
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: () => user,
    rejectUnauthenticated: (_q, r) => r.status(401).json({ error: "auth" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    rateMax,
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const post = async (base, manifest) => {
  const r = await fetch(base + "/api/packs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifest }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
};

{
  // Public author: cap of 2 → third publish 429.
  const h = await harness({ user: { email: "pub@x", groups: ["creators"] }, rateMax: 2 });
  const p1 = await post(h.base, minimalManifest("M1"));
  const p2 = await post(h.base, minimalManifest("M2"));
  console.log("  first two:", p1.status, p2.status);
  const third = await post(h.base, minimalManifest("M3"));
  check(`public author hits the cap (got ${third.status}: ${JSON.stringify(third.body).slice(0, 60)})`, third.status === 429);
  await h.close();
}
{
  // Admin maintainer: same cap of 2 → third publish still succeeds.
  const h = await harness({ user: { email: "ops@x", groups: ["creators", "admin"] }, rateMax: 2 });
  await post(h.base, minimalManifest("M1"));
  await post(h.base, minimalManifest("M2"));
  const third = await post(h.base, minimalManifest("M3"));
  check("admin exempt from the cap (200/201)", third.status === 200 || third.status === 201);
  await h.close();
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
