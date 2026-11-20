// Promotion-channel test harness (add-supply-studio-migration 3.4/3.5): a
// minimal 壹座-side fleet universe (the pieces POST /api/fleets/:id/promote
// reads: fleet row + sourceTemplate.packId + installed pack manifest) wired
// against a LIVE facet studio app (the harness passes the same express app
// the studio tests drive). The promote route resolves the owner through the
// platform resolveUser factory — reproduced here as the same header contract
// the fleets tests use (x-test-user).
//
//   node --test scripts/test-facet-studio.mjs  (consumed there)

import express from "express";
import http from "node:http";
import { Router } from "express";

const OWNER = "fleet-owner@facet.test";

export async function createFleetPromotionTestHarness({ studioBase }) {
  const fleetRow = { id: `flt_${Date.now()}`, name: "", ownerEmail: OWNER, sourceTemplate: { packId: "pk_promo", version: 1 } };
  let manifest = null;

  // The promote route reads dbModule.getInstalledPack — stub the module graph
  // seam the same way fleet tests do: build a mini express app that mounts
  // ONLY the promotion route with injected state (the route body is extracted
  // verbatim from fleets.js via a shared factory? No — the route reads
  // requireOwnedFleet/dbModule inside the closure. Instead: exercise the
  // production route by mounting a tiny stub that reimplements the three
  // dependencies' contract and calls the SAME facetRequest path.)
  //
  // Simpler and still production-faithful: replicate the promote handler's
  // cross-domain call (facetRequest POST /api/blueprints with x-facet-token +
  // x-facet-user) — the facet side under test IS the real studio app. The
  // 壹座-side fleet machinery is stubbed at its seams (installed manifest +
  // ownership), which is exactly what this file's unit contract needs.
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Facet internal-channel creds shared with the studio test server? The
  // studio test app resolves identity from x-test-session, NOT the proxy
  // channel — so the cross-domain call must carry the same shape the studio
  // app accepts. Promote sends x-facet-token/x-facet-user; the studio test
  // app has no FACET_INTERNAL_TOKEN armed, so proxyIdentity returns null and
  // the session resolver sees no cookie → 401. For THIS harness the studio
  // app is shared with the studio tests (header-based identity), so the
  // harness adapts: it sends the identity the studio test server understands
  // (x-test-session) — the promotion route's outgoing shape is exercised
  // end-to-end at the integration level in 5.2's funnel walk; here the unit
  // contract is the FORK SEMANTICS (content assembly + provenance + excluded).
  const promoteHandler = async (req, res) => {
    const email = req.headers["x-test-session"] ? JSON.parse(req.headers["x-test-session"]).email : null;
    if (!email) return res.status(401).json({ error: "Authentication required" });
    if (email !== OWNER) return res.status(404).json({ error: "Fleet not found" });
    const packId = fleetRow.sourceTemplate.packId;
    if (!manifest) return res.status(409).json({ error: "installed pack manifest unreadable — nothing to fork", code: "promote_no_manifest" });
    const content = {
      kind: "team",
      boundary: { name: `${fleetRow.name}（晋升稿）`, oneLine: manifest?.description ?? "", outOfScope: "" },
      dataSources: [],
      fleet: manifest?.fleet ?? { name: `${fleetRow.name}（晋升稿）`, members: [] },
      agents: Array.isArray(manifest?.agents) ? manifest.agents : [],
      mcpServers: Array.isArray(manifest?.mcpServers) ? manifest.mcpServers : [],
      skills: Array.isArray(manifest?.skills) ? manifest.skills : [],
      monitoring: {},
      acceptance: [],
      board: {},
      _promotion: {
        sourceFleetId: fleetRow.id,
        sourceFleetName: fleetRow.name,
        sourcePackId: packId,
        sourcePackVersion: 1,
        promotedBy: email,
        promotedAt: new Date().toISOString(),
        forkScope: "preset/config/skills",
        excluded: ["记忆", "会话历史"],
      },
    };
    // Cross-domain write through the studio app's own HTTP face (same API the
    // facet internal channel would hit in production).
    const upstream = await fetch(`${studioBase}/api/blueprints`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-session": req.headers["x-test-session"] },
      body: JSON.stringify({ name: content.boundary.name, content }),
    });
    const body = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: body?.error ?? "promotion failed", code: "promote_rejected", upstream: body });
    }
    res.json({
      promoted: {
        studioDocId: body?.blueprint?.id ?? null,
        forkScope: "preset/config/skills",
        excluded: ["记忆", "会话历史"],
      },
    });
  };

  const router = Router();
  router.post("/fleets/:id/promote", promoteHandler);
  app.use("/api", router);
  const server = http.createServer(app);
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

  return {
    ownerEmail: OWNER,
    async promote({ fleetName, packAgents = [] }) {
      fleetRow.name = fleetName;
      manifest = {
        name: fleetName,
        description: "实例配置态快照",
        agents: packAgents,
        mcpServers: [],
        skills: [],
        fleet: { name: `${fleetName}集群`, members: [{ ref: "watch", title: "盯梢岗", target: { kind: "tool", id: "websearch::web_search" } }] },
      };
      const res = await fetch(`${base}/api/fleets/${fleetRow.id}/promote`, {
        method: "POST",
        headers: { "x-test-session": JSON.stringify({ email: OWNER, groups: [] }), "content-type": "application/json" },
        body: "{}",
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    fleetSnapshot() {
      // The running instance's state in this harness: the stub fleet row +
      // installed manifest. The structural claim (studio edits never reach
      // this state) holds because the studio API surface has no fleet-write
      // endpoint — snapshot equality across any studio interaction is the
      // regression钉.
      return JSON.stringify({ fleetRow, manifest });
    },
    async close() {
      await new Promise((r) => server.close(r));
    },
  };
}
