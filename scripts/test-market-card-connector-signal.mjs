#!/usr/bin/env node
// ── Market card · connector signal (add-market-card-connector-signal) ────────
//
// The shelf used to be silent about connectors: a customer could only learn that
// a pack needs N external systems by opening the detail dialog. Two of the three
// published vertical connector packs declare ONLY `optional` bindings — which
// are never minted at deploy time and can never be used by a served agent — so
// "needs connecting" and "declares connectors" are genuinely different facts and
// the card must not conflate them.
//
//  1. READ FACE — publish real manifests into a real registry and read
//     `GET /api/packs`: counts must come from the SQL projection, and an
//     undeclared pack must keep its pre-change shape (no keys at all, because
//     absent is "unknown", never zero).
//  2. RENDER — mount the real PackCard through react-dom/server with the real
//     zh-CN locale: a positive required count renders the segment; all-optional
//     and undeclared render nothing.
//
// Each half has a red arm documented below (run it by making the change the
// comment names).
//
//   node --test scripts/test-market-card-connector-signal.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import express from "express";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const webDir = path.join(root, "web");

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const tmp = mkdtempSync(path.join(tmpdir(), "card-connector-signal-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Five bindings: one with no `optional` key at all (legacy author), one explicit
// false, three optional. Required = 2 under `IS NOT 1`; the legacy row is what
// makes `= 0` visibly wrong (1 instead of 2) — that is the SQL red arm.
const MIXED = {
  name: "仓配分销连接器包",
  description: "五条绑定，两条必需。",
  tags: ["供应链"],
  connector_bindings: [
    { key: "kingdee-cloud", provider: "kingdee", allowOperations: ["read"] },
    { key: "payments-merchant", provider: "payments", allowOperations: ["read"], optional: false },
    { key: "wms-snapshot", provider: "wms", allowOperations: ["read"], optional: true },
    { key: "supplier-portal", provider: "supplier", allowOperations: ["read"], optional: true },
    { key: "carrier-portal", provider: "carrier", allowOperations: ["read"], optional: true },
  ],
};

// Both optional — the shape two of the three published vertical packs actually
// have. Required count is a REAL zero and must stay present as 0.
const OPTIONAL_ONLY = {
  name: "餐饮连锁对账连接器包",
  description: "两条都是 optional。",
  tags: ["餐饮"],
  connector_bindings: [
    { key: "pos-sales", provider: "pos", allowOperations: ["read"], optional: true },
    { key: "payments-merchant", provider: "payments", allowOperations: ["read"], optional: true },
  ],
};

// Never mentions connectors: the shelf majority. Both keys must be absent.
const NO_DECLARATION = {
  name: "普通助手包",
  description: "没有任何连接器声明。",
  tags: ["通用"],
};

function mount() {
  const dir = mkdtempSync(path.join(tmp, "reg-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  const app = express();
  registerPackRoutes(app, {
    registry: reg,
    resolveUser: () => ({ email: "author@e.test", groups: ["creators"] }),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "nope" }),
    creatorGroups: ["creators"],
    anonymousRead: true,
    officialAuthors: [],
  });
  const server = http.createServer(app);
  server.listen(0);
  const base = () => `http://127.0.0.1:${server.address().port}`;
  return { server, reg, dir, base };
}

async function publishAndList(manifests) {
  const { server, reg, dir, base } = mount();
  try {
    const ids = manifests.map((manifest) => reg.publish({ email: "author@e.test", manifest }).id);
    const body = await fetch(`${base()}/api/packs`).then((r) => r.json());
    const list = ids.map((id) => body.packs.find((p) => p.id === id));
    // The detail face selects neither column (the counts are a shelf concern —
    // "how many systems must I connect before buying" — and the dialog reads
    // the manifest itself). Both keys must stay absent there: a detail payload
    // gaining them would be a second, driftable source for the same number.
    const detail = [];
    for (const id of ids) {
      const payload = await fetch(`${base()}/api/packs/${id}`).then((r) => r.json());
      detail.push(payload.pack ?? payload);
    }
    return { list, detail };
  } finally {
    server.close();
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("read face: required count excludes optional bindings, and counts a legacy row as required", async () => {
  const { list, detail } = await publishAndList([MIXED, OPTIONAL_ONLY, NO_DECLARATION]);
  const [mixed, optionalOnly, none] = list;

  assert.equal(mixed.connectorBindingCount, 5, "all five declarations are counted");
  assert.equal(mixed.connectorRequiredCount, 2, "one legacy (no `optional` key) + one explicit false");
  // RED ARM (SQL): change `IS NOT 1` to `= 0` in gateway/packs.js → this becomes
  // 1, because a missing key extracts to NULL and NULL = 0 is NULL.
  assert.notEqual(mixed.connectorRequiredCount, 1, "a missing `optional` key must not fall out of the required set");

  assert.equal(optionalOnly.connectorBindingCount, 2);
  assert.equal(optionalOnly.connectorRequiredCount, 0, "an explicit 0 stays 0 — real zero, not unknown");

  assert.ok(!("connectorBindingCount" in none), "undeclared pack must not gain a count");
  assert.ok(!("connectorRequiredCount" in none), "undeclared pack must not gain a count");
  // Same ternary covers "the caller's row didn't project the columns" — both
  // states are `undefined` here, which is exactly why the projection keys are
  // omitted rather than coerced to 0.
  for (const row of detail) {
    assert.ok(!("connectorBindingCount" in row), "the detail face must not project the list-only declaration count");
    assert.ok(!("connectorRequiredCount" in row), "the detail face must not project the list-only required count");
  }
});

// ── Render ───────────────────────────────────────────────────────────────────

const esbuildBin = path.join(webDir, "node_modules", ".bin", "esbuild");
const haveWebDeps = existsSync(esbuildBin);
const skip = haveWebDeps ? false : "web/node_modules not installed (esbuild missing) — run `npm --prefix web ci`";

const CASES_ENTRY = `
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import zhCN from "./src/locales/zh-CN/common.json";
import { PackCard } from "./src/components/packs/PackCard";

const base = {
  id: "pack-1",
  authorEmail: "author@e.test",
  createdAt: 1,
  version: 1,
  name: "包",
  description: "描述。",
  tags: [],
  publishedAt: 1,
  unlisted: false,
  visibility: "public",
  category: "",
  line: "",
  lineLabel: "",
  featured: false,
  official: false,
  skillCount: 0,
  agentCount: 0,
  mcpCount: 0,
};

const CASES = {
  required: { ...base, connectorBindingCount: 5, connectorRequiredCount: 2 },
  optionalOnly: { ...base, connectorBindingCount: 2, connectorRequiredCount: 0 },
  unknown: { ...base },
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
  for (const [name, pack] of Object.entries(CASES)) {
    out[name] = renderToStaticMarkup(<PackCard pack={pack} onOpen={() => {}} testId={"pack-card-" + name} />);
  }
  process.stdout.write("---RENDERCHECK---" + JSON.stringify(out));
}

main();
`;

let rendered = null;
function render() {
  if (rendered) return rendered;
  const entry = path.join(webDir, ".test-market-card-connector-signal.tsx");
  const dir = mkdtempSync(path.join(tmpdir(), "card-connector-render-"));
  const bundle = path.join(dir, "bundle.cjs");
  try {
    writeFileSync(entry, CASES_ENTRY, "utf8");
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
    rmSync(entry, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

test("render: a positive required count shows the external-systems segment", { skip }, () => {
  const html = render().required;
  assert.ok(html.includes('data-testid="pack-signals-pack-1-connectors"'), "the segment must be present");
  assert.match(html, /外部系统 2/, "it renders the required count, not the declaration count (5)");
  // RED ARM (RENDER): drop the `> 0` guard in PackCard.tsx → the two "must be
  // absent" assertions below fail (the segment appears with 0).
});

test("render: all-optional declares connectors but asks for nothing", { skip }, () => {
  const html = render().optionalOnly;
  assert.ok(
    !html.includes('data-testid="pack-signals-pack-1-connectors"'),
    "0 required must render no segment — '0 external systems' would deny the optional declarations",
  );
});

test("render: an undeclared pack gains nothing", { skip }, () => {
  const html = render().unknown;
  assert.ok(!html.includes('data-testid="pack-signals-pack-1-connectors"'), "no count, no segment");
  assert.ok(!/外部系统/.test(html), "the label must not leak for packs that never mention connectors");
});
