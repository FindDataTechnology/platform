#!/usr/bin/env node
// ── Connector inventory section · render (connector-inventory-in-connections) ─
//
// The projection's tests (test-connector-inventory.mjs) pin what the server
// answers. This pins what the card SAYS about it, and the one thing that must
// never blur: "could not read" and "nothing connected" are different sentences.
// A user who sees the wrong one either re-connects everything for nothing, or
// sits on an empty shelf believing it is real.
//
//   node --test scripts/test-connector-inventory-render.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const webDir = path.join(root, "web");
const esbuildBin = path.join(webDir, "node_modules", ".bin", "esbuild");
const skip = existsSync(esbuildBin) ? false : "web/node_modules not installed (esbuild missing) — run `npm --prefix web ci`";

const ENTRY = `
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import zhCN from "./src/locales/zh-CN/common.json";
import { ConnectorInventorySection } from "./src/components/extensions/ConnectorConnectPanel";

const CASES = {
  unknownNoCredential: { state: "unknown", code: "no_credential" },
  unknownUnauthorized: { state: "unknown", code: "unauthorized" },
  unknownOther: { state: "unknown", code: "http_500" },
  empty: { state: "ok", rows: [], connectorUrl: "https://connector.example.test" },
  rows: {
    state: "ok",
    connectorUrl: "https://connector.example.test",
    rows: [
      { service: "github", connectionName: "default", authType: "api_key", requiredByPack: false },
      { service: "kingdee-cloud", connectionName: "sandbox", authType: "oauth2", requiredByPack: true },
    ],
  },
  rowsNoOrigin: { state: "ok", connectorUrl: null, rows: [{ service: "github", connectionName: "default", requiredByPack: false }] },
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
  for (const [name, inventory] of Object.entries(CASES)) {
    out[name] = renderToStaticMarkup(<ConnectorInventorySection inventory={inventory} />);
  }
  process.stdout.write("---RENDERCHECK---" + JSON.stringify(out));
}

main();
`;

let rendered = null;
function render() {
  if (rendered) return rendered;
  const entry = path.join(webDir, ".test-connector-inventory-render.tsx");
  const dir = mkdtempSync(path.join(tmpdir(), "connector-inventory-render-"));
  const bundle = path.join(dir, "bundle.cjs");
  try {
    writeFileSync(entry, ENTRY, "utf8");
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

test("unknown and empty never share a sentence", { skip }, () => {
  const out = render();
  // Both are empty shelves to a careless reader; they must not read the same.
  assert.notEqual(out.unknownNoCredential, out.empty);
  assert.match(out.unknownNoCredential, /无法读取/);
  assert.match(out.empty, /连好之后会出现在这里/);
  assert.doesNotMatch(out.empty, /无法读取/);
  assert.doesNotMatch(out.unknownNoCredential, /连好之后会出现在这里/);
});

test("the unknown reason names WHY, not just that", { skip }, () => {
  const out = render();
  // Three different repairs: sign in / reconnect / retry later or ask ops.
  assert.match(out.unknownNoCredential, /还没有连接器账号/);
  assert.match(out.unknownUnauthorized, /失效/);
  assert.notEqual(out.unknownNoCredential, out.unknownUnauthorized);
  // An unrecognised code falls back to the code itself rather than a blank.
  assert.match(out.unknownOther, /http_500/);
});

test("rows carry the service, the non-default name, and the pack label", { skip }, () => {
  const out = render();
  assert.match(out.rows, /github/);
  assert.match(out.rows, /kingdee-cloud/);
  // A non-default connection name is shown; "default" is the floor and is not.
  assert.match(out.rows, /sandbox/);
  // Only the pack-declared provider wears the label.
  assert.equal((out.rows.match(/包要求/g) ?? []).length, 1);
  assert.match(out.rows, /data-service="github" data-required="0"/);
  assert.match(out.rows, /data-service="kingdee-cloud" data-required="1"/);
});

test("rows deep-link to the connector's own form for that provider", { skip }, () => {
  const out = render();
  assert.match(out.rows, /https:\/\/connector\.example\.test\/me\?add=github/);
  assert.match(out.rows, /https:\/\/connector\.example\.test\/me\?add=kingdee-cloud/);
  // Browsing the catalog is offered wherever there is an origin to send them to.
  assert.match(out.rows, /https:\/\/connector\.example\.test\/me#catalog/);
});

test("no connector origin means no dead links", { skip }, () => {
  const out = render();
  assert.match(out.rowsNoOrigin, /github/);
  // A link with no origin would be a dead end; the row states the fact alone.
  assert.doesNotMatch(out.rowsNoOrigin, /\/me\?add=/);
  assert.doesNotMatch(out.rowsNoOrigin, /#catalog/);
});

test("an empty inventory still offers the way to fill it", { skip }, () => {
  const out = render();
  assert.match(out.empty, /#catalog/);
});
