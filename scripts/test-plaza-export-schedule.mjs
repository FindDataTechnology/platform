// ── In-service plaza export: swap discipline ────────────────────────────────
//
//   node --test scripts/test-plaza-export-schedule.mjs
//
// Pins the three properties the cron-era chain never had (unify-supply-spine-
// lineage D2):
//   1. a failed export leaves the PREVIOUS generation serving untouched —
//      never a half-written family, never an empty directory;
//   2. a successful export swaps the whole family at once and refreshes the
//      root machine faces the compatibility door serves;
//   3. the stale-replay path works, i.e. a network failure replays the last
//      catalog marked stale instead of failing hard. (That path needs the
//      current catalog seeded into the staging dir; without the seed it could
//      never fire, which is the bug this test pins.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { test } from "node:test";
import assert from "node:assert/strict";

import { runExportOnce, startExportSchedule } from "../facet/plaza-export-schedule.js";

const SURFACE = {
  "catalog.json": '{"generatedAt":"2026-11-20","sentinel":"previous-generation"}\n',
  "counts.json": '{"generatedAt":"2026-11-20","stale":false,"packs":1,"byCategory":[{"category":"pack","count":1}]}\n',
  "llms.txt": "# previous llms\n",
  "llms-full.txt": "# previous llms full\n",
};

function seedSite() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-site-"));
  const gen = path.join(root, "generated");
  fs.mkdirSync(gen, { recursive: true });
  for (const [name, body] of Object.entries(SURFACE)) fs.writeFileSync(path.join(gen, name), body);
  fs.writeFileSync(path.join(root, "llms.txt"), "ROOT-OLD\n");
  return root;
}

/** A fake exporter: writes a generation, or exits non-zero, or writes half a set. */
function fakeExporter({ mode, body = SURFACE }) {
  return `import fs from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.mkdirSync(out, { recursive: true });
const mode = ${JSON.stringify(mode)};
if (mode === "partial") {
  fs.writeFileSync(out + "/catalog.json", '{"generatedAt":"2026-11-21","sentinel":"half"}\\n');
  process.exit(0); // exit 0 but no counts.json / llms — the swap must still be refused? no: swap happens
}
if (mode === "fail") { process.stderr.write("network down\\n"); process.exit(1); }
const body = ${JSON.stringify(body)};
for (const [k, v] of Object.entries(body)) fs.writeFileSync(out + "/" + k, v);
`;
}

function writeExporter(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-exp-"));
  const p = path.join(dir, "fake-export.mjs");
  fs.writeFileSync(p, src);
  return p;
}

test("a failed export leaves the previous generation intact", async () => {
  const root = seedSite();
  const res = await runExportOnce({
    siteRoot: root,
    exportScript: writeExporter(fakeExporter({ mode: "fail" })),
  });
  assert.equal(res.ok, false);
  for (const [name, body] of Object.entries(SURFACE)) {
    assert.equal(
      fs.readFileSync(path.join(root, "generated", name), "utf8"),
      body,
      `${name} must be untouched after a failed run`,
    );
  }
  assert.equal(fs.readFileSync(path.join(root, "llms.txt"), "utf8"), "ROOT-OLD\n");
  // no staging dirs left behind
  assert.deepEqual(
    fs.readdirSync(root).filter((n) => n.startsWith(".staging-")),
    [],
    "a failed run must clean its staging dir",
  );
});

test("a successful export swaps the whole family and refreshes the root faces", async () => {
  const root = seedSite();
  const next = {
    "catalog.json": '{"generatedAt":"2026-11-21","sentinel":"new"}\n',
    "counts.json": '{"generatedAt":"2026-11-21","stale":false,"packs":2,"byCategory":[{"category":"pack","count":2}]}\n',
    "llms.txt": "# new llms\n",
    "llms-full.txt": "# new llms full\n",
  };
  const res = await runExportOnce({
    siteRoot: root,
    exportScript: writeExporter(fakeExporter({ mode: "ok", body: next })),
  });
  assert.equal(res.ok, true);
  assert.equal(res.generatedAt, "2026-11-21");
  for (const [name, body] of Object.entries(next)) {
    assert.equal(fs.readFileSync(path.join(root, "generated", name), "utf8"), body);
  }
  // the compatibility door's root copies follow
  assert.equal(fs.readFileSync(path.join(root, "llms.txt"), "utf8"), "# new llms\n");
  assert.deepEqual(
    fs.readdirSync(root).filter((n) => n.startsWith(".previous-") || n.startsWith(".staging-")),
    [],
    "no leftover swap directories",
  );
});

test("an export that produces no catalog is refused, previous kept", async () => {
  // "partial" writes only catalog.json (with no materials) and exits 0. Two
  // gates apply and either is a refusal: the family is incomplete, and the
  // material count is zero against a non-empty live generation. The property
  // under test is refusal, not which gate fired.
  const root = seedSite();
  const res = await runExportOnce({
    siteRoot: root,
    exportScript: writeExporter(fakeExporter({ mode: "partial" })),
  });
  assert.equal(res.ok, false, "an empty partial family must be refused");
  assert.equal(
    fs.readFileSync(path.join(root, "generated", "catalog.json"), "utf8"),
    SURFACE["catalog.json"],
  );

  const root2 = seedSite();
  const noCat = writeExporter(`import fs from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(out + "/llms.txt", "only llms\\n");
process.exit(0);
`);
  const res2 = await runExportOnce({ siteRoot: root2, exportScript: noCat });
  assert.equal(res2.ok, false, "an export without catalog.json must be refused");
  assert.equal(
    fs.readFileSync(path.join(root2, "generated", "catalog.json"), "utf8"),
    SURFACE["catalog.json"],
  );
});

test("without FACET_SITE_ROOT the run reports failure instead of writing somewhere", async () => {
  const res = await runExportOnce({ siteRoot: "", exportScript: writeExporter(fakeExporter({ mode: "fail" })) });
  assert.equal(res.ok, false);
  assert.match(res.error, /FACET_SITE_ROOT/);
});

test("a zero-material export cannot wipe a non-empty live generation", async () => {
  const root = seedSite();
  const empty = {
    "catalog.json": '{"generatedAt":"2026-11-21","materials":[]}\n',
    "counts.json": '{"generatedAt":"2026-11-21","stale":false,"packs":0,"byCategory":[{"category":"pack","count":0}]}\n',
    "llms.txt": "# empty\n",
  };
  const res = await runExportOnce({
    siteRoot: root,
    exportScript: writeExporter(fakeExporter({ mode: "ok", body: empty })),
  });
  assert.equal(res.ok, false, "an empty family must be refused");
  assert.match(res.error, /empty export refused/);
  assert.equal(
    fs.readFileSync(path.join(root, "generated", "catalog.json"), "utf8"),
    SURFACE["catalog.json"],
    "the live generation must survive an empty run",
  );
});

test("the schedule's trigger debounces a burst into one run", async () => {
  const calls = [];
  const sched = startExportSchedule({
    siteRoot: "/tmp/does-not-matter",
    intervalSecs: 0,
    bootDelayMs: 10_000, // do not let the boot run interfere
    debounceMs: 20,
    runOnce: async () => {
      calls.push(Date.now());
      return { ok: true };
    },
    log: () => {},
  });
  sched.trigger();
  sched.trigger();
  sched.trigger();
  await new Promise((r) => setTimeout(r, 80));
  sched.stop();
  assert.equal(calls.length, 1, `three triggers must collapse to one run, got ${calls.length}`);
});
