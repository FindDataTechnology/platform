#!/usr/bin/env node
// ── Install report · connector block (add-served-agent-connector-access 6.9) ──
//
// The install report is where a pack that declares `connector_bindings` tells
// the customer which external systems it needs. The server has always written
// that state (`pack-store.js` → `report.connector`, with the comment "so the
// surface can render one row per unmet binding with the right fix"); until now
// nothing rendered it, so a *required* binding left unconnected installed
// silently and read as "ready".
//
// This file pins both halves of that surface:
//   1. SOURCE — the block is gated on `report.connector` (a pack with no
//      declarations must render nothing at all), and the parent wires it in.
//      That gate cannot be seen from a render of the block itself.
//   2. RENDER — the four gate shapes a customer can meet, mounted through
//      react-dom/server with the real zh-CN locale. "It type-checks" says
//      nothing about whether a gate error is reported as "connected".
//
// The render half needs web's deps (esbuild ships with vite, react-dom with the
// app). When they are absent the render subtests SKIP loudly rather than
// silently passing — the source half still runs.
//
//   node --test scripts/test-connector-report-render.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const webDir = path.join(root, "web");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const view = read("web/src/components/packs/PackInstallReport.tsx");
const api = read("web/src/lib/packs-api.ts");

// ── 1. Source ────────────────────────────────────────────────────────────────

test("the block renders only when the gate reported something", () => {
  // `report.connector` is set by the server only for packs that declare
  // bindings — so the customer's "no declarations ⇒ no block" guarantee is
  // this `&&`, not a length check inside the block.
  assert.match(
    view,
    /\{connector && <ConnectorReportBlock connector=\{connector\} \/>\}/,
    "the install report must gate the connector block on report.connector",
  );
  // The four gate fields the block relies on exist on the wire type; without
  // them `tsc` would have forced casts and the block could drift from the
  // server's actual shape (`gateFromRows`).
  for (const field of ["connected", "required", "unresolved", "optionalUnmet", "pendingGrant", "error"]) {
    assert.match(api, new RegExp(`\\b${field}\\??:`), `PackConnectorReport must type \`${field}\``);
  }
});

test("an ungranted-but-satisfied row is not labelled as usable", () => {
  // `pendingGrant` rows are `satisfied` in the ledger yet have no token, so
  // they are unusable until the one-click grant. Borrowing the settings panel's
  // "已连接" label for them would tell the customer the opposite of the truth.
  assert.match(
    view,
    /kind === "pendingGrant"\s*\?\s*t\("packs\.report\.connector\.needsGrant"\)/,
    "pendingGrant rows must use the grant wording, not the satisfied state label",
  );
});

test("the block speaks the settings panel's vocabulary", () => {
  // Same status words and the same read/write words as
  // 设置 → 连接 →「已装应用的连接器需求」: two surfaces describing one fact must
  // not invent two vocabularies.
  assert.match(view, /settings\.connections\.bindings\.state\.\$\{/, "reuse the settings state labels");
  assert.match(view, /settings\.connections\.bindings\.operations\.\$\{/, "reuse the settings operation labels");
  assert.match(view, /settings\.connections\.bindings\.optional/, "reuse the settings optional label");
});

// ── 2. Producer shape (the block reads what `gateFromRows` actually writes) ──
//
// The render cases above are hand-written fixtures: if the server renamed or
// dropped a field, the block would render `undefined` and every render
// assertion above would still pass against the stale fixture. So run the real
// gate and hold the two shapes together.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-report-shape-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
const cwdBefore = process.cwd();
process.chdir(TMP);
fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

test.after(() => {
  process.chdir(cwdBefore);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("report.connector rows carry every field the block reads", async () => {
  const db = await import("../db.js");
  // The gate projection lives in connector-grants.js (connector-bindings.js owns
  // the ledger rows it consumes); initDb is needed because a `satisfied` row is
  // only "granted" when a live token exists.
  const binds = await import("../connector-grants.js");
  await db.initDb();
  const EMAIL = "report-shape@example.com";

  const rows = [
    // satisfied and granted would need a live token; satisfied without one is
    // the `pendingGrant` shape, which is the one the block special-cases.
    { bindingKey: "crm.contacts", provider: "oomol", role: null, operations: ["read"], status: "satisfied", optional: false, reason: null },
    { bindingKey: "erp.orders", provider: "oomol", role: null, operations: ["read", "write"], status: "missing", optional: false, reason: "no connection" },
    { bindingKey: "oms.stock", provider: "oomol", role: null, operations: ["read"], status: "unwired", optional: true, reason: "catalog gap" },
  ];
  const gate = binds.gateFromRows(EMAIL, "pack-shape", rows);

  assert.deepEqual(gate.pendingGrant.map((r) => r.bindingKey), ["crm.contacts"]);
  assert.deepEqual(gate.unresolved.map((r) => r.bindingKey), ["erp.orders"]);
  assert.deepEqual(gate.optionalUnmet.map((r) => r.bindingKey), ["oms.stock"]);
  assert.equal(gate.connected, false, "an unconnected required binding is not connected");
  assert.equal(gate.required, 2, "required counts the non-optional rows");

  // Fields the block renders on unmet rows.
  for (const field of ["bindingKey", "provider", "operations", "status", "reason", "optional"]) {
    assert.ok(field in gate.unresolved[0], `unresolved rows must carry \`${field}\``);
    assert.ok(field in gate.optionalUnmet[0], `optionalUnmet rows must carry \`${field}\``);
  }
  assert.ok(Array.isArray(gate.unresolved[0].operations), "operations is the array the block joins");

  // …and on pendingGrant rows, where `status` is deliberately absent: the row
  // IS satisfied, so rendering the satisfied label would read as usable.
  assert.ok(!("status" in gate.pendingGrant[0]), "pendingGrant rows carry no status — that is why the block branches on kind");
  for (const field of ["bindingKey", "provider", "operations"]) {
    assert.ok(field in gate.pendingGrant[0], `pendingGrant rows must carry \`${field}\``);
  }
});

test("the install report nests that projection under `connector`", () => {
  // pack-store spreads the gate and adds the per-binding list; the block reads
  // the spread fields, so the spread is the contract.
  const store = read("pack-store.js");
  assert.match(store, /report\.connector = \{\s*\n\s*\.\.\.gate,/, "report.connector spreads the gate projection");
  assert.match(store, /report\.connector = \{ connected: false, unresolved: \[\], optionalUnmet: \[\], pendingGrant: \[\], error:/, "a gate failure reports `error` rather than claiming a state");
});

// ── 3. Render ────────────────────────────────────────────────────────────────

const esbuildBin = path.join(webDir, "node_modules", ".bin", "esbuild");
const haveWebDeps = fs.existsSync(esbuildBin);

const CASES_ENTRY = `
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import zhCN from "./src/locales/zh-CN/common.json";
import { ConnectorReportBlock } from "./src/components/packs/PackInstallReport";

const CASES = {
  mixed: {
    connected: false,
    required: 2,
    unresolved: [
      { bindingKey: "erp.orders", provider: "oomol", operations: ["read", "write"], status: "missing", reason: "没有可用的连接" },
    ],
    pendingGrant: [{ bindingKey: "crm.contacts", provider: "oomol", operations: ["read"] }],
    optionalUnmet: [
      { bindingKey: "oms.stock", provider: "oomol", operations: ["read"], status: "unwired", optional: true, reason: "连接器目录未覆盖该操作" },
    ],
  },
  allReady: { connected: true, required: 2, unresolved: [], pendingGrant: [], optionalUnmet: [] },
  optionalOnly: {
    connected: true,
    required: 0,
    unresolved: [],
    pendingGrant: [],
    optionalUnmet: [{ bindingKey: "oms.stock", provider: "oomol", operations: ["read"], status: "missing", optional: true }],
  },
  gateFailed: { connected: false, unresolved: [], pendingGrant: [], optionalUnmet: [], error: "connector unreachable: ECONNREFUSED" },
};

async function main() {
  await i18next.use(initReactI18next).init({
    lng: "zh-CN",
    fallbackLng: false,
    defaultNS: "common",
    resources: { "zh-CN": { common: zhCN } },
    interpolation: { escapeValue: false },
  });
  const out = {};
  for (const [name, connector] of Object.entries(CASES)) {
    out[name] = renderToStaticMarkup(<ConnectorReportBlock connector={connector} />);
  }
  process.stdout.write("---RENDERCHECK---" + JSON.stringify(out));
}

main();
`;

let rendered = null;
function render() {
  if (rendered) return rendered;
  const entry = path.join(webDir, ".test-connector-report-render.tsx");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-report-"));
  const bundle = path.join(dir, "bundle.cjs");
  try {
    fs.writeFileSync(entry, CASES_ENTRY, "utf8");
    // The entry lives inside web/ so React/i18next resolve from web/node_modules.
    execFileSync(
      esbuildBin,
      [entry, "--bundle", "--platform=node", "--format=cjs", "--loader:.json=json", `--outfile=${bundle}`, "--log-level=error"],
      { cwd: webDir, stdio: "inherit" },
    );
    const stdout = execFileSync(process.execPath, [bundle], { encoding: "utf8", maxBuffer: 64 << 20 });
    const marker = "---RENDERCHECK---";
    rendered = JSON.parse(stdout.slice(stdout.indexOf(marker) + marker.length));
    return rendered;
  } finally {
    fs.rmSync(entry, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const skip = haveWebDeps ? false : "web/node_modules not installed (esbuild missing) — run `npm --prefix web ci`";

test("mixed state: required-first rows, honest counts", { skip }, () => {
  const html = render().mixed;
  assert.ok(html.includes('data-testid="pack-report-connector"'), "the block must be present");
  // Only non-optional rows block use — the count must not include the
  // optional degradation, or every all-optional pack reads as broken.
  assert.match(html, /2 项待接通/, "summary counts the 2 non-optional rows");
  assert.ok(html.includes('data-open="2"'));
  assert.ok(html.includes('data-connected="false"'));
  assert.ok(html.includes("oomol") && html.includes("erp.orders"), "row names the system and the key");
  assert.ok(html.includes("可一键授权"), "the ungranted row says what is missing");
  assert.ok(!html.includes("已连接"), "…and never claims it is connected");
  assert.match(html, /pack-report-connector-oms\.stock"[^>]*data-kind="optionalUnmet"/);
  assert.ok(html.includes("可选"), "optional rows are marked as such");
  assert.ok(html.includes("连接器目录未覆盖该操作"), "the gate's reason reaches the customer");
  assert.ok(html.includes("连接器由设置"), "the hint names the real menu path");
  // Customer's order of business: blocking, then one-click, then optional.
  const i = html.indexOf("erp.orders");
  const j = html.indexOf("crm.contacts");
  const k = html.indexOf("oms.stock");
  assert.ok(i >= 0 && i < j && j < k, "rows are ordered required → pendingGrant → optional");
});

test("all required bindings usable: says so, lists nothing", { skip }, () => {
  const html = render().allReady;
  assert.ok(html.includes("必需项已接通"));
  assert.ok(html.includes('data-connected="true"'));
  assert.ok(!html.includes("data-kind="), "no rows when nothing is open");
});

test("all-optional pack: does not pretend something is connected", { skip }, () => {
  const html = render().optionalOnly;
  assert.ok(html.includes("无必需连接器"), "a pack with no required system is usable as installed");
  assert.ok(html.includes('data-kind="optionalUnmet"'), "…while still disclosing the optional gap");
  assert.ok(!html.includes("必需项已接通"), "there is nothing required to have connected");
});

test("gate threw: unknown, never 'connected'", { skip }, () => {
  const html = render().gateFailed;
  assert.ok(html.includes("无法确认连接状态"), "an install that could not resolve bindings says so");
  assert.ok(!html.includes("必需项已接通"), "and must not claim the pack is connected");
  // The raw error is for whoever debugs the install, not customer copy.
  assert.ok(html.includes('title="connector unreachable'), "the raw gate error rides the title attribute");
  assert.ok(!html.includes("ECONNREFUSED</"), "…not the visible text");
});
