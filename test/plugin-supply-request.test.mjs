// unify-material-market — 申请供应 流水 (plugin-supply-request) route contract.
//
// Pins the four behaviors the spec makes load-bearing:
//   · one row per first ask, duplicate asks reuse it untouched;
//   · an already-supplied plugin is refused (409) and writes NOTHING;
//   · the read path derives "supplied" from the live roster — no hand edit;
//   · the catalogue read reports exactly the three supply states.
//
// Every case runs against a real express app on an ephemeral port with a temp
// JSON store, so the persistence path (atomic temp+rename, restart-readable) is
// exercised rather than mocked. The final guard reads the two shipped modules
// and asserts the no-network invariant directly — this flow must never be able
// to turn into a runtime install.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginSupplyStore, registerPluginSupplyRoutes } from "../server/routes/plugin-supply.js";

const dirs = [];
const servers = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    await new Promise((resolve) => s.close(resolve));
  }
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const CATALOG = {
  version: 2,
  plugins: [
    { id: "on", name: "On bundle", description: "supplied and enabled" },
    { id: "off", name: "Off bundle", description: "supplied and disabled" },
    { id: "new", name: "New plugin", description: "catalogued but not supplied" },
  ],
};

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "plugin-supply-"));
  dirs.push(dir);
  return join(dir, "requests.json");
}

async function startServer({ catalog = CATALOG, bundles = [], identify = false, now } = {}) {
  const file = tempFile();
  const store = createPluginSupplyStore({ file });
  const app = express();
  app.use(express.json());
  if (identify) {
    app.use((req, _res, next) => {
      const email = req.get("x-test-user");
      if (email) req.user = { email };
      next();
    });
  }

  let roster = bundles;
  const ctx = {
    app,
    getPluginBundles: async () => ({ available: true, bundles: roster }),
  };
  registerPluginSupplyRoutes(ctx, {
    store,
    catalogFn: () => catalog,
    deploymentId: "dep-test",
    ...(now ? { now } : {}),
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    store,
    file,
    setRoster: (next) => {
      roster = next;
    },
  };
}

const getCatalog = async (base) => {
  const r = await fetch(`${base}/api/plugin-catalog`, { headers: { accept: "application/json" } });
  assert.equal(r.status, 200);
  return r.json();
};

const askSupply = async (base, body, headers = {}) => {
  const r = await fetch(`${base}/api/plugin-supply-requests`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

test("catalogue read exposes the three supply states against a fake roster", async () => {
  const h = await startServer({
    bundles: [
      { id: "on", enabled: true },
      { id: "off", enabled: false },
    ],
  });
  const doc = await getCatalog(h.base);
  const byId = Object.fromEntries(doc.plugins.map((p) => [p.id, p]));

  assert.equal(byId.on.state, "enabled");
  assert.equal(byId.off.state, "available");
  assert.equal(byId.new.state, "unsupplied");
  // No request row ⇒ no request state leaking into the row.
  assert.equal("requestState" in byId.new, false);
  assert.equal(doc.plugins.length, 3, "every catalogued row renders, supplied or not");
});

test("first request records one row with catalogue version and requester", async () => {
  const h = await startServer({ identify: true, now: () => 1_700_000_000_000 });
  const { status, body } = await askSupply(h.base, { pluginId: "new" }, { "x-test-user": "alice@example.test" });

  assert.equal(status, 201);
  assert.equal(body.request.pluginId, "new");
  assert.equal(body.request.catalogVersion, 2);
  assert.equal(body.request.requester, "alice@example.test");
  assert.equal(body.request.requestedAt, 1_700_000_000_000);
  assert.equal(body.request.state, "requested");
  assert.equal(body.request.declineReason, null);
  assert.equal(body.request.deploymentId, "dep-test");

  assert.equal(h.store.list().length, 1);
  // Restart-readable: the atomic write landed as plain JSON.
  const persisted = JSON.parse(readFileSync(h.file, "utf8"));
  assert.equal(persisted.requests.length, 1);
  assert.equal(persisted.requests[0].pluginId, "new");
});

test("duplicate request creates no second row and keeps the original ask", async () => {
  let tick = 1_700_000_000_000;
  const h = await startServer({ identify: true, now: () => tick++ });

  const first = await askSupply(h.base, { pluginId: "new" }, { "x-test-user": "alice@example.test" });
  assert.equal(first.status, 201);

  // Another user, same plugin, same deployment: idempotent, original wins.
  const second = await askSupply(h.base, { pluginId: "new" }, { "x-test-user": "bob@example.test" });
  assert.equal(second.status, 200);
  assert.equal(second.body.request.requester, "alice@example.test");
  assert.equal(second.body.request.requestedAt, first.body.request.requestedAt);

  assert.equal(h.store.list().length, 1);
  const persisted = JSON.parse(readFileSync(h.file, "utf8"));
  assert.equal(persisted.requests.length, 1);
});

test("request for an already-supplied plugin is refused with 409 and writes nothing", async () => {
  const h = await startServer({ bundles: [{ id: "on", enabled: true }] });
  const { status, body } = await askSupply(h.base, { pluginId: "on" });

  assert.equal(status, 409);
  assert.match(String(body.error), /already supplied/i);
  assert.equal(h.store.list().length, 0, "no request row for a supplied plugin");
});

test("read path derives supplied once the plugin appears in the roster", async () => {
  const h = await startServer({ bundles: [] });
  await askSupply(h.base, { pluginId: "new" });

  let doc = await getCatalog(h.base);
  let row = doc.plugins.find((p) => p.id === "new");
  assert.equal(row.state, "unsupplied");
  assert.equal(row.requestState, "requested");

  // The deployment now ships the plugin — no request row is edited.
  h.setRoster([{ id: "new", enabled: false }]);
  doc = await getCatalog(h.base);
  row = doc.plugins.find((p) => p.id === "new");
  assert.equal(row.state, "available");
  assert.equal(row.requestState, "supplied", "request resolves from supply, not a stored copy");
  assert.equal(h.store.list()[0].state, "requested", "the stored row is untouched");

  h.setRoster([{ id: "new", enabled: true }]);
  doc = await getCatalog(h.base);
  row = doc.plugins.find((p) => p.id === "new");
  assert.equal(row.state, "enabled");
  assert.equal(row.requestState, "supplied");
});

test("unknown or missing plugin id is a 400 and writes nothing", async () => {
  const h = await startServer({ bundles: [] });

  const unknown = await askSupply(h.base, { pluginId: "not-in-catalogue" });
  assert.equal(unknown.status, 400);

  const missing = await askSupply(h.base, {});
  assert.equal(missing.status, 400);

  assert.equal(h.store.list().length, 0);
});

test("plugin-supply modules contain no network primitive", () => {
  const sources = [
    ["server/routes/plugin-supply.js", readFileSync(new URL("../server/routes/plugin-supply.js", import.meta.url), "utf8")],
    ["server/plugin-catalog.js", readFileSync(new URL("../server/plugin-catalog.js", import.meta.url), "utf8")],
  ];
  // No outbound call of any shape: a request may only ever write a local row.
  const forbidden = [
    [/\bfetch(?:Sync)?\s*\(/, "fetch call"],
    [/from\s+["']node:https?["']/, "node http import"],
    [/require\(\s*["']https?["']\s*\)/, "http require"],
    [/\bhttps?\.request\s*\(/, "http.request"],
    [/\baxios\b/, "axios"],
    [/\bundici\b/, "undici"],
    [/from\s+["']node:child_process["']/, "child_process import"],
    [/\bexecSync\s*\(/, "execSync"],
    [/\bexecFile\s*\(/, "execFile"],
    [/\bspawn\s*\(/, "spawn"],
    [/\.download\s*\(/, "download call"],
  ];
  for (const [name, src] of sources) {
    for (const [pattern, label] of forbidden) {
      assert.ok(!pattern.test(src), `${name} must not contain a ${label}`);
    }
  }
});
