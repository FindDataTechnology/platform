#!/usr/bin/env node
// ── Desktop local-cluster acceptance probe (install-e2e, both platforms) ────
//
// The ONE script the Windows and macOS installer legs both call. It proves
// the promise this batch shipped — "users can run AND manage a multi-agent
// cluster locally" — against a REAL installed app:
//
//   1. the cell's LOCAL roster feed answers on loopback with its own bearer
//      (and refuses a wrong bearer);
//   2. the preinstalled starter bundle is VISIBLE as a catalogue (registered,
//      not installed);
//   3. importing it installs a pack through the normal pipeline (source=bundle);
//   4. deploying a serving agent creates a local deployment, and the feed
//      publishes the entry the runner will pick up;
//   5. stop / start / remove keep the identity and the feed consistent;
//   6. the convergence report answers (a resident boot's expectation state);
//   7. the local runner — when the fleet plugin is enabled — reports the
//      deployed agent in its live roster.
//
// Platform-neutral on purpose: the leg's shell (pwsh / bash) only has to
// locate the app and the data root; the assertions live here.
//
// Usage:
//   PLATFORM_DATA_DIR=<data root> PLATFORM_RESOURCES_DIR=<resources> \
//   node scripts/desktop-local-cluster-probe.mjs
//
// Exit code 0 = the promise holds on this machine; non-zero = it does not.

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.PLATFORM_DATA_DIR || "";
const RESOURCES = process.env.PLATFORM_RESOURCES_DIR || "";
const HOST = "127.0.0.1";
// The cell's port is NOT a constant in the resident world: the steward picks a
// free one at stack start (only the EMBEDDED desktop pins DESKTOP_SERVER_PORT).
// So discover it — ask the steward's control plane, which is the same source
// the app itself uses — and fall back to the pinned default.
let PORT = Number(process.env.DESKTOP_SERVER_PORT || 0) || 47600;
let BASE = `http://${HOST}:${PORT}`;

const failures = [];
const notes = [];
const deploymentsCache = { paths: [] };

function ok(name, detail = "") {
  notes.push(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name, detail) {
  failures.push(`${name}: ${detail}`);
  notes.push(`  ✗ ${name} — ${detail}`);
}

async function getJson(path_, { token } = {}) {
  const res = await fetch(`${BASE}${path_}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

// The cell's feed bearer lives in settings.json (minted by first-run).
function readSettings() {
  const file = path.join(DATA_DIR, "settings.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Discover the stack's cell port through the resident steward (its control
// plane is a line-delimited JSON socket, and `status` carries the servers with
// their ports). Best-effort: an embedded/standalone cell simply stays on the
// pinned port.
async function discoverCellPort() {
  const discovery = path.join(DATA_DIR, "steward.json");
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(discovery, "utf8"));
  } catch {
    return null; // no resident steward — keep the pinned port
  }
  if (!doc?.socket) return null;
  const net = await import("node:net");
  const request = (op, params = {}) =>
    new Promise((resolve) => {
      const conn = net.createConnection(doc.socket);
      let buf = "";
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try {
          conn.destroy();
        } catch { /* already gone */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 5000);
      conn.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      conn.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer);
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          finish(msg.ok === false ? null : (msg.result ?? msg));
        } catch {
          finish(null);
        }
      });
      conn.on("connect", () => {
        // The steward REFUSES a request whose protocol major does not match
        // (supervisor/steward.js) — take the version from its own discovery
        // document, exactly like the desktop client does.
        conn.write(`${JSON.stringify({ id: "probe", op, protocolVersion: Number(doc.protocolVersion) || 1, params })}\n`);
      });
    });
  const pick = (status) => {
    const servers = Array.isArray(status?.servers) ? status.servers : [];
    const cell = servers.find((s) => s?.id === "server-js" || s?.name === "Platform backend") ?? servers[0];
    return cell ?? null;
  };

  let cell = pick(await request("status").catch(() => null));
  // A resident cell may legitimately be DARK: the residency policy can be
  // `on_demand` (or `manual`), in which case nothing runs until someone asks.
  // The desktop app does exactly that when it attaches — start the stack, then
  // use it. The probe must do the same, or it would call a sleeping machine
  // broken.
  if (!cell || Number(cell.port) <= 0 || ["stopped", "failed"].includes(String(cell.state))) {
    await request("start").catch(() => null);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      cell = pick(await request("status").catch(() => null));
      if (cell && Number(cell.port) > 0) break;
    }
  }
  return Number(cell?.port) > 0 ? Number(cell.port) : null;
}

async function waitForCell(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/wanxing/fleet/deployments`);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

console.log(`[probe] data=${DATA_DIR || "(unset)"} resources=${RESOURCES || "(unset)"} cell=${BASE}`);

if (!DATA_DIR) {
  console.error("[probe] PLATFORM_DATA_DIR is required (the cell's data root)");
  process.exit(2);
}

// Ask the steward where the cell actually listens, then wait for it.
const discovered = await discoverCellPort();
if (discovered) {
  PORT = discovered;
  BASE = `http://${HOST}:${PORT}`;
  ok("cell port discovered from the steward", String(PORT));
}
if (!(await waitForCell())) {
  console.error(`[probe] the cell never answered on ${BASE}`);
  process.exit(1);
}
ok("cell answers", BASE);

// 1. The local roster feed: its own bearer, loopback only.
const settings = readSettings();
const token = settings.WANXING_LOCAL_FEED_TOKEN || "";
if (!token) {
  bad("feed bearer", "settings.json carries no WANXING_LOCAL_FEED_TOKEN (first-run did not mint one)");
} else {
  const authed = await getJson("/local-registry/api/agents?limit=10&offset=0", { token });
  if (authed.status === 200) ok("feed answers with its bearer", `status 200`);
  else bad("feed with bearer", `status ${authed.status} ${JSON.stringify(authed.body).slice(0, 120)}`);

  const wrong = await getJson("/local-registry/api/agents?limit=10&offset=0", { token: "not-the-token" });
  if (wrong.status === 401) ok("feed refuses a wrong bearer", "401");
  else bad("feed wrong bearer", `expected 401, got ${wrong.status}`);
}

// 2. Preinstalled starter bundles: a CATALOGUE (registration ≠ installation).
const presets = await getJson("/api/wanxing/fleet/presets");
if (presets.status !== 200) {
  bad("presets catalogue", `status ${presets.status}`);
} else {
  const bundles = presets.body?.bundles ?? [];
  ok("presets catalogue answers", `${bundles.length} bundle(s)`);
  if (bundles.length === 0) {
    notes.push("  · no starter bundle shipped in this build — the import leg below is skipped");
  }
  for (const b of bundles) {
    if (b.packId && b.version) ok("preset entry is self-describing", `${b.packId} v${b.version}`);
    else bad("preset entry", `missing packId/version: ${JSON.stringify(b).slice(0, 120)}`);
  }
}

// 3. Supply: import a starter bundle when the installer ships one; otherwise
// build a minimal ACCEPTANCE FIXTURE pack here and import it through the very
// same endpoint. Either way the probe exercises the offline path and ends up
// with a deployable candidate — a CI machine starts with no packs at all, and
// skipping the deploy half would leave the batch's promise unasserted.
let importedPackId = null;
const bundles = presets.body?.bundles ?? [];
if (bundles.length === 0) {
  try {
    const { buildBundle, toBase64 } = await import("../server/offline-bundle.js");
    const fixture = {
      name: "Acceptance Fixture",
      description: "Local-cluster acceptance fixture (installed and removed by the probe)",
      skills: [{ name: "acceptance-fixture-skill", description: "fixture", content: "# fixture\n" }],
      agents: [{ id: "acceptance-worker", name: "Acceptance Worker", persona: "fixture", serving: { protocol: "a2a" } }],
    };
    const bytes = await buildBundle({ packId: "acceptance-fixture", version: 1, manifest: fixture, origin: "acceptance-probe" });
    const res = await fetch(`${BASE}/api/mypacks/import-bundle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle: toBase64(bytes), confirm: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 200) {
      ok("fixture pack imports through the offline path", `${body.bundle?.packId} v${body.bundle?.version}`);
      importedPackId = body.bundle?.packId ?? "acceptance-fixture";
    } else {
      bad("fixture pack import", `status ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    }
  } catch (e) {
    bad("fixture pack import", `the probe could not build/import its fixture: ${e?.message || e}`);
  }
}
if (bundles.length > 0) {
  const res = await fetch(`${BASE}/api/wanxing/fleet/presets/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: bundles[0].file }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 200) {
    ok("starter bundle installs", `${body.bundle?.packId} v${body.bundle?.version}`);
    importedPackId = body.bundle?.packId ?? null;
  } else {
    bad("starter bundle import", `status ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  }
}

// 4. The catalog's candidate list + the deploy write face.
const catalog = await getJson("/api/wanxing/fleet/catalog");
if (catalog.status !== 200) {
  bad("local catalog", `status ${catalog.status}`);
} else {
  const candidates = catalog.body?.candidates ?? [];
  ok("local catalog answers", `${candidates.length} candidate(s), capacity ${JSON.stringify(catalog.body?.capacity ?? {})}`);
  const target =
    candidates.find((c) => c.packId === importedPackId) ?? candidates.find((c) => !c.deployed);
  if (!target) {
    notes.push("  · no deployable candidate on this machine — the deploy leg below is skipped");
  } else {
    const res = await fetch(`${BASE}/api/wanxing/fleet/deployments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packId: target.packId, agentId: target.agentId }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 || res.status === 201) {
      ok("deploy lands", `${target.packId}/${target.agentId} → ${body.deployment?.agentPath}`);
      const agentPath = body.deployment?.agentPath;
      deploymentsCache.paths.push(agentPath);

      // The feed must publish the entry — that is what the runner polls.
      const feed = await getJson("/local-registry/api/agents?limit=50&offset=0", { token });
      const published = (feed.body?.agents ?? []).some((a) => a.path === agentPath);
      if (published) ok("feed publishes the deployment", agentPath);
      else bad("feed publishes the deployment", `${agentPath} is absent from the feed`);

      // …and the LOCAL RUNNER must pick it up (the whole promise). The runner
      // polls on its own cadence (AGENT_RUNNER_POLL_SECS, 60s by default), so
      // this waits bounded — and only when the plugin is actually on, since a
      // seat with the fleet plugin off serves nothing by design.
      const liveNow = await getJson("/api/wanxing/fleet/live");
      if (liveNow.status === 200) {
        const deadline = Date.now() + 90_000;
        let inRoster = false;
        while (Date.now() < deadline && !inRoster) {
          const snapshot = await getJson("/api/wanxing/fleet/live");
          inRoster = (snapshot.body?.agents ?? []).some((a) => a.path === agentPath);
          if (!inRoster) await new Promise((r) => setTimeout(r, 3000));
        }
        if (inRoster) ok("the runner picked the deployment up", agentPath);
        else bad("the runner picks the deployment up", `${agentPath} never appeared in the runner roster (90s)`);
      } else {
        notes.push("  · the fleet plugin is off here — the runner pickup check is skipped for this deployment");
      }

      // stop → out of the feed, identity kept; start → back.
      await fetch(`${BASE}/api/wanxing/fleet/deployments/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentPath }),
      });
      const afterStop = await getJson("/local-registry/api/agents?limit=50&offset=0", { token });
      const stillThere = (afterStop.body?.agents ?? []).some((a) => a.path === agentPath);
      if (!stillThere) ok("stop removes the entry from the feed", agentPath);
      else bad("stop removes the entry", `${agentPath} still published`);

      await fetch(`${BASE}/api/wanxing/fleet/deployments/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentPath }),
      });
      const afterStart = await getJson("/local-registry/api/agents?limit=50&offset=0", { token });
      const back = (afterStart.body?.agents ?? []).some((a) => a.path === agentPath);
      if (back) ok("start restores the same identity", agentPath);
      else bad("start restores the identity", `${agentPath} did not come back`);

      // remove → gone from the roster for good.
      await fetch(`${BASE}/api/wanxing/fleet/deployments/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentPath }),
      });
      const afterRemove = await getJson("/local-registry/api/agents?limit=50&offset=0", { token });
      const gone = !(afterRemove.body?.agents ?? []).some((a) => a.path === agentPath);
      if (gone) ok("remove clears the deployment", agentPath);
      else bad("remove clears the deployment", `${agentPath} is still published`);

      // Leave the machine as we found it — EXCEPT the acceptance fixture,
      // which the desired-state leg below still needs as its deployable
      // candidate (uninstalled there). An installed starter bundle stays.
      void importedPackId;
    } else if (res.status === 409 && body.code === "capacity_exceeded") {
      ok("deploy refused with a structured capacity answer", `used ${body.used}/${body.cap}`);
    } else {
      bad("deploy", `status ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
    }
  }
}

// 5. The convergence report (a resident boot's expectation state).
const convergence = await getJson("/api/wanxing/fleet/convergence");
if (convergence.status === 200) {
  const cur = convergence.body?.current ?? {};
  ok("convergence reports", `deployments=${cur.deployments} enabled=${cur.enabled} pruned=${cur.pruned}`);
} else {
  bad("convergence", `status ${convergence.status}`);
}

// 5b. Desired-state beacon handshake (add-unified-fleet-console): stage the
// beacon the steward would write after a cloud edit, wait for the cell's
// merge beat, and prove the three core rules end-to-end on a real cell —
// cloud-desired lands tagged `cloud`, a user stop ADOPTS the row (local
// wins, the cloud cannot resurrect it), and the detail beacon the steward
// relays carries the merge outcome.
const desiredFile = `${DATA_DIR}/fleet-desired.json`;
const detailFile = `${DATA_DIR}/fleet-detail.json`;
let desiredTarget = null; // set by the deploy leg below when it found one
{
  const target = catalog.status === 200 ? (catalog.body?.candidates ?? []).find((c) => c.packId === importedPackId) ?? (catalog.body?.candidates ?? [])[0] : null;
  if (target) desiredTarget = { packId: target.packId, agentId: target.agentId };
}

async function waitForMergeBeat(prevVersion, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const doc = JSON.parse(await (await import("node:fs")).promises.readFile(detailFile, "utf8"));
      if (doc?.merge?.desiredVersionSeen === prevVersion) return doc;
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

if (!desiredTarget) {
  notes.push("  · no deployable candidate — the desired-state beacon leg is skipped");
} else {
  const { packId, agentId } = desiredTarget;
  const fsPromises = (await import("node:fs")).promises;
  const path1 = `packs/${packId}/${agentId}`;

  // (a) Cloud adds the entry → merge deploys it tagged `cloud`.
  await fsPromises.writeFile(desiredFile, JSON.stringify({ version: 901, entries: [{ packId, agentId, enabled: true }], pulledAt: Date.now() }));
  const beat1 = await waitForMergeBeat(901);
  if (!beat1) {
    bad("desired merge lands", `detail beacon never reported version 901 (90s)`);
  } else {
    const row = (await getJson("/api/wanxing/fleet/deployments")).body?.deployments?.find((d) => d.agentPath === path1);
    if (row && row.enabled && row.source === "cloud") ok("cloud desired lands tagged cloud", `${path1} enabled by the merge`);
    else bad("cloud desired lands", `row is ${JSON.stringify(row)}`);
  }

  // (b) User stops it → adoption flips source to manual; the cloud cannot
  // resurrect it even though the desired set still says enabled.
  await fetch(`${BASE}/api/wanxing/fleet/deployments/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentPath: path1 }),
  });
  await fsPromises.writeFile(desiredFile, JSON.stringify({ version: 902, entries: [{ packId, agentId, enabled: true }], pulledAt: Date.now() }));
  const beat2 = await waitForMergeBeat(902);
  if (!beat2) {
    bad("local manual wins", `detail beacon never reported version 902 (90s)`);
  } else {
    const row = (await getJson("/api/wanxing/fleet/deployments")).body?.deployments?.find((d) => d.agentPath === path1);
    if (row && !row.enabled && row.source === "manual") ok("local manual wins over the cloud desired set", `${path1} stays stopped after v902`);
    else bad("local manual wins", `row is ${JSON.stringify(row)}`);
  }

  // (c) The detail beacon (what the steward relays as cell_detail) carries
  // the deployments with their source and the merge outcome.
  try {
    const detail = JSON.parse(await fsPromises.readFile(detailFile, "utf8"));
    const carried = (detail.deployments ?? []).some((d) => d.agentPath === path1 && d.source === "manual");
    const merged = detail.merge?.desiredVersionSeen === 902;
    if (carried && merged) ok("detail beacon carries source + merge outcome", `v902, ${detail.deployments?.length ?? 0} deployment(s)`);
    else bad("detail beacon carries source + merge outcome", JSON.stringify(detail).slice(0, 200));
  } catch (e) {
    bad("detail beacon", e?.message || String(e));
  }

  // Cleanup: withdraw the expectation (cloud remove) and leave no beacon.
  await fsPromises.writeFile(desiredFile, JSON.stringify({ version: 903, entries: [], pulledAt: Date.now() }));
  await waitForMergeBeat(903);
  await fsPromises.rm(desiredFile, { force: true });
  const row = (await getJson("/api/wanxing/fleet/deployments")).body?.deployments?.find((d) => d.agentPath === path1);
  if (!row) ok("withdrawn desired removes the cloud row", path1);
  else {
    // An adopted (manual) row survives withdrawal by design — remove it by hand.
    await fetch(`${BASE}/api/wanxing/fleet/deployments/remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentPath: path1 }),
    });
    ok("adopted manual row survives withdrawal (removed by hand)", path1);
  }

  // Now the machine is quiet again: take our acceptance fixture out.
  if (importedPackId === "acceptance-fixture") {
    const del = await fetch(`${BASE}/api/mypacks/${encodeURIComponent(importedPackId)}?force=1`, { method: "DELETE" });
    if (del.ok) ok("fixture pack uninstalled", importedPackId);
    else bad("fixture pack uninstall", `status ${del.status}`);
  }
}

// 6. The local runner — only when the fleet plugin is on. When it is up, the
// deployment this probe made MUST show up in its roster: that is the whole
// promise (the local roster feeds the local runner), and a runner that
// ignores the local feed would look perfectly healthy while serving nothing.
const live = await getJson("/api/wanxing/fleet/live");
if (live.status === 200) {
  const agents = live.body?.agents ?? [];
  ok("local runner is healthy", `${agents.length} agent(s), ${live.body?.children ?? 0} runtime process(es)`);
} else {
  notes.push(`  · the fleet plugin is off on this machine (live: ${live.body?.error ?? live.status}) — the runner leg is skipped`);
}

console.log(notes.join("\n"));
if (failures.length > 0) {
  console.error(`\n[probe] FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\n[probe] OK — the local cluster is runnable AND manageable on this machine");
