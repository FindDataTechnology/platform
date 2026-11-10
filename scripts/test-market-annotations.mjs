// Repo annotation source (add-mcp-annotation-overlay D7, tasks 6.1/6.2/6.5;
// mcp-annotation-source-requirements.md §B/§C/§E):
//   - loader discipline: validate → index → cache; invalid entries dropped
//     with a warn, never a throw; missing/corrupt file → empty table
//   - the committed root file self-checks against the SAME validator the
//     merge point uses, with pathToName-shaped keys
//   - mapServer merge point: registry metadata wins field-wise over the repo
//     file; file-only locales/canonical survive; both empty → null (entries
//     render raw upstream text, byte-identical to the pre-change shape)
//   - tool-level merge is per leaf, and the tool ROW set stays governed by
//     registry tool_list — annotations decorate rows, never invent them
//   - locale resolution untouched: unsupported locale falls back to zh;
//     unannotated projects to null.
//
// Registry env is set before the dynamic bridge import (module constants read
// it at load); cwd is redirected to a temp dir holding the fixture
// market-annotations.json (bundledJson prefers the cwd copy).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadRepoAnnotations,
  getRepoAnnotation,
  resetRepoAnnotationsCache,
} from "../lib/market-annotations.js";
import { validateAnnotation, projectAnnotation } from "../lib/supply-annotations.js";

const REPO_ROOT = resolve0();
function resolve0() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

// ── loader ───────────────────────────────────────────────────────────────────

function goodAnnotation(name) {
  return {
    human: {
      zh: { name, summary: "一句话说明" },
      en: { name: `${name} EN`, summary: "one-line summary" },
    },
    canonical: { brief: "brief for agents" },
    provenance: { source: "test-curation", updatedAt: "2026-11-02" },
  };
}

function writeFixture(t, doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-annotations-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "market-annotations.json");
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

test("loader: valid entries index by name; the map is the cached reference", (t) => {
  resetRepoAnnotationsCache();
  const file = writeFixture(t, {
    version: 1,
    entries: { "alpha-srv": { annotation: goodAnnotation("甲一") } },
  });
  const map = loadRepoAnnotations(file);
  assert.equal(map.size, 1);
  assert.equal(map.get("alpha-srv").human.zh.name, "甲一");
  // Process cache: same (file, mtime) → same Map identity, no re-parse.
  assert.equal(loadRepoAnnotations(file), map);
  assert.equal(getRepoAnnotation("alpha-srv"), map.get("alpha-srv"));
  assert.equal(getRepoAnnotation("nope"), undefined);
});

test("loader: invalid entry dropped with a warn naming it; siblings survive", (t) => {
  resetRepoAnnotationsCache();
  const broken = goodAnnotation("乙二");
  delete broken.human.zh; // zh MAIN track missing → invalid wholesale
  const file = writeFixture(t, {
    version: 1,
    entries: { bad: { annotation: broken }, good: { annotation: goodAnnotation("丙三") } },
  });
  const warn = t.mock.method(console, "warn", () => {});
  const map = loadRepoAnnotations(file);
  assert.equal(map.size, 1);
  assert.ok(map.has("good"));
  assert.equal(warn.mock.calls.length, 1);
  assert.match(warn.mock.calls[0].arguments.join(" "), /'bad'/);
});

test("loader: missing file is a silent empty table; corrupt file warns and empties", (t) => {
  resetRepoAnnotationsCache();
  const warn = t.mock.method(console, "warn", () => {});
  const missing = path.join(os.tmpdir(), "does-not-exist-market-annotations.json");
  assert.equal(loadRepoAnnotations(missing).size, 0);
  assert.equal(warn.mock.calls.length, 0, "missing file is the normal no-curation state");
  const corrupt = path.join(fs.mkdtempSync(os.tmpdir() + "/ma-"), "market-annotations.json");
  fs.writeFileSync(corrupt, "{not json");
  assert.equal(loadRepoAnnotations(corrupt).size, 0);
  assert.equal(warn.mock.calls.length, 1);
  // No entries object → empty table + warn, still never a throw.
  const shapeless = writeFixture(t, { version: 1 });
  assert.equal(loadRepoAnnotations(shapeless).size, 0);
  assert.equal(warn.mock.calls.length, 2);
  assert.equal(getRepoAnnotation("anything"), undefined);
});

test("committed market-annotations.json: full-file validate + pathToName-shaped keys", () => {
  const file = path.join(REPO_ROOT, "market-annotations.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(doc.version, 1);
  for (const [name, entry] of Object.entries(doc.entries)) {
    const r = validateAnnotation(entry.annotation, `entries['${name}']`);
    assert.ok(r.ok, `${name}: ${r.error}`);
    // Keys are registry entry names (pathToName result): no slashes, not
    // empty, no leading/trailing dash.
    assert.doesNotMatch(name, /\//, `${name} must not contain a slash`);
    assert.match(name, /^[a-z0-9][a-z0-9._-]*$/i, `${name} is not pathToName-shaped`);
  }
  assert.ok(Object.keys(doc.entries).includes("fd-quant"), "fd-quant sample shipped");
});

// ── bridge merge point ───────────────────────────────────────────────────────

process.env.MARKET_REGISTRY_URL = "https://registry.example.test";
process.env.MARKET_REGISTRY_TOKEN = "test-token";
delete process.env.REGISTRY_URL;

// Fixture file the bridge resolves through bundledJson (cwd copy wins).
const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-annotations-"));
process.chdir(bridgeDir);
fs.writeFileSync(
  path.join(bridgeDir, "market-annotations.json"),
  JSON.stringify({
    version: 1,
    entries: {
      "ann-test": {
        annotation: {
          human: {
            zh: { name: "Z-F", summary: "S-F" },
            en: { name: "E-F", summary: "S-EF" },
            ja: { name: "J-F", summary: "S-JF" },
          },
          canonical: { brief: "B-F" },
          provenance: { source: "test-curation", updatedAt: "2026-11-02" },
        },
      },
      "leaf-test": {
        annotation: {
          human: { zh: { name: "叶面", summary: "一句话" } },
          tools: {
            leaf_a: { human: { zh: { name: "叶A", summary: "S-A" } } },
            leaf_b: { human: { zh: { name: "叶B", summary: "S-B" } } },
          },
        },
      },
    },
  }),
);

const bridge = await import("../registry-bridge.js");

let servers = [];
function stubFetch() {
  return async (url) => {
    const endpoint = String(url).replace(/^https:\/\/registry\.example\.test/, "");
    const [rawPath] = endpoint.split("?");
    if (rawPath === "/api/servers") {
      return { ok: true, status: 200, json: async () => ({ servers, total_count: servers.length }) };
    }
    if (rawPath === "/api/skills") {
      return { ok: true, status: 200, json: async () => ({ skills: [], total_count: 0 }) };
    }
    if (rawPath === "/api/agents") {
      return { ok: true, status: 200, json: async () => [] };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
}
async function refresh() {
  bridge.initRegistryBridge({ fetchImpl: stubFetch() });
  await bridge.refreshRegistry();
  return bridge.getMarketEntries().mcpServers;
}
function baseServer(pathName, extra = {}) {
  return {
    path: pathName,
    display_name: pathName.replace(/^\//, ""),
    description: "raw upstream",
    is_enabled: true,
    ...extra,
  };
}

test("invariant ①: unannotated entries keep the exact pre-change shape", async () => {
  servers = [baseServer("/plain-test")];
  const [entry] = await refresh();
  // The annotations key exists and is null — same as the raw passthrough was.
  assert.ok(Object.hasOwn(entry, "annotations"));
  assert.equal(entry.annotations, null);
  // Raw fields untouched by the merge point.
  assert.equal(entry.displayName, "plain-test");
  assert.equal(entry.description, "raw upstream");
  assert.equal(entry.origin, "registry");
});

test("invariant ②: registry metadata wins field-wise; file-only locales/canonical survive", async () => {
  servers = [
    baseServer("/ann-test", {
      metadata: {
        annotations: {
          human: { zh: { name: "Z-R", summary: "S-R" }, en: { name: "E-R", summary: "S-RE" } },
        },
      },
    }),
  ];
  const [entry] = await refresh();
  const a = entry.annotations;
  assert.equal(a.human.en.name, "E-R", "registry en track beats the file");
  assert.equal(a.human.en.summary, "S-RE");
  assert.equal(a.human.zh.name, "Z-R", "registry zh track beats the file");
  assert.equal(a.human.ja.name, "J-F", "file-only ja track survives the merge");
  assert.equal(a.canonical.brief, "B-F", "registry has no canonical → the file's is kept");
  // Provenance follows the winner (existing mergeAnnotations semantics).
  assert.equal(a.provenance.source, "registry");
});

test("invariant ③: tools merge per leaf; the row set stays tool_list-governed", async () => {
  servers = [
    baseServer("/leaf-test", {
      tool_list: [
        { name: "leaf_a", description: "A raw" },
        { name: "leaf_c", description: "C raw" },
      ],
      metadata: { annotations: { tools: { leaf_a: { canonical: { brief: "BC" } } } } },
    }),
  ];
  const [entry] = await refresh();
  const a = entry.annotations;
  assert.equal(a.tools.leaf_a.canonical.brief, "BC", "registry leaf canonical kept");
  assert.equal(a.tools.leaf_a.human.zh.name, "叶A", "file leaf human backfilled");
  // The file's leaf_b annotation rides along on the annotation side…
  assert.ok(a.tools.leaf_b, "file-only leaf annotation survives");
  // …but the tool ROW set is governed by registry tool_list: no row appears
  // for leaf_b, none disappears for leaf_c. Annotations decorate rows, never
  // invent them.
  assert.deepEqual(entry.toolList, ["leaf_a", "leaf_c"]);
  assert.deepEqual(entry.toolDetails.map((d) => d.name), ["leaf_a", "leaf_c"]);
});

test("invariant ④: locale resolution unchanged after the merge", async () => {
  servers = [
    baseServer("/ann-test", {
      metadata: { annotations: { human: { zh: { name: "Z-R", summary: "S-R" } } } },
    }),
  ];
  const [entry] = await refresh();
  const a = entry.annotations;
  // Unsupported locale falls back to the zh main track.
  const de = projectAnnotation(a, "de");
  assert.equal(de.name, "Z-R");
  // Supported secondary track renders its own.
  assert.equal(projectAnnotation(a, "ja").name, "J-F");
  // Unannotated projects to null (raw upstream rendering path).
  assert.equal(projectAnnotation(null, "en"), null);
});

test("repo annotation flows without any registry metadata (the 28-entries case)", async () => {
  servers = [baseServer("/ann-test")]; // metadata.annotations absent, as on every live entry
  const [entry] = await refresh();
  assert.equal(entry.annotations.human.en.name, "E-F", "repo file fills the whole annotation");
  assert.equal(entry.annotations.provenance.source, "test-curation", "file provenance kept");
});
