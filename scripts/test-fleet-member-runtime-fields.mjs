// Fleet template per-member runtime config (enrich-fleet-template-member-config).
//
// The six fields a template member may declare (model / fallbackModel / effort /
// contextBudget / carrier / inputPolicy) used to be validated by NOBODY and
// dropped by the provisioner — a template could name them and provisioning
// silently discarded them. These tests pin: parse accepts + carries them,
// typos refuse, shapes refuse, and each field actually reaches a createMember
// column (the closure gate that would have caught input_policy's missing INSERT
// column).
//
// effort ruling (coordinator 2026-11-23): parse-time validates SHAPE only
// (non-empty string | null). The legal levels are a deployment-time fact
// (effortUnion from the live dshModels roster), so the parser must NOT pretend
// to know a vocabulary — `effort:"extreme"` passes the parse and the live write
// face (validateConfigDims) is the vocabulary gate. Therefore the old
// "extreme is rejected" expectation is replaced by "non-string is rejected".
//
// Run: node --test scripts/test-fleet-member-runtime-fields.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-runtime-fields-"));
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const {
  parseFleetTemplate,
  MEMBER_RUNTIME_FIELDS,
  CONTEXT_BUDGET_FLOOR,
  CONTEXT_BUDGET_CEILING,
} = await import("../server/fleet-template.js");
const { provisionFleetFromTemplate } = await import("../server/fleet-provisioner.js");
const { createFleetDatabase } = await import("../server/routes/fleets-db.js");

const FULL_RUNTIME = {
  model: "deepseek-v4-pro",
  fallbackModel: "deepseek-v4-flash",
  effort: "high",
  contextBudget: 128000,
  carrier: "runner",
  inputPolicy: { maxTurns: 3 },
};

function manifestWith(memberOverrides = {}, memberExtra = {}) {
  return {
    fleet: {
      name: "运行时字段模板",
      members: [
        {
          ref: "ceo",
          title: "CEO",
          target: { kind: "existing-persona", id: "persona-ceo" },
          kpiSlots: [],
          cadence: null,
          ...memberOverrides,
          ...memberExtra,
        },
      ],
    },
  };
}

test("六个运行时字段齐全的模板通过校验，装台后逐字段相等", async () => {
  const parsed = parseFleetTemplate(manifestWith(FULL_RUNTIME));
  assert.equal(parsed.ok, true, parsed.error);
  const m = parsed.template.members[0];
  for (const field of MEMBER_RUNTIME_FIELDS) {
    assert.deepEqual(m[field], FULL_RUNTIME[field], `parse carried ${field}`);
  }

  // Real provision round-trip: land the fleet and read the member rows back.
  const db = createFleetDatabase({ file: path.join(tmpRoot, `f-${Date.now()}.db`) });
  const out = await provisionFleetFromTemplate({
    packId: "pack_runtime",
    version: "1.0.0",
    manifest: manifestWith(FULL_RUNTIME),
    ownerEmail: "owner@test",
    deps: {
      db,
      catalogAgentIds: () => new Set(),
      resolveExisting: () => true,
      reconcile: async () => {},
      syncMemoryPolicy: async () => ({ ok: true, action: "skipped" }),
    },
  });
  assert.equal(out.ok, true, out.error);
  const landed = db.listMembers(out.fleet.id).find((x) => x.title === "CEO");
  for (const field of MEMBER_RUNTIME_FIELDS) {
    assert.deepEqual(landed[field], FULL_RUNTIME[field], `provision carried ${field}`);
  }
});

test("拼错的键（modle）被拒，错误里含该键名", () => {
  const parsed = parseFleetTemplate(manifestWith({}, { modle: "deepseek-v4-pro" }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "fleet_member_unknown_field");
  assert.match(parsed.error, /modle/);
});

test("effort 只校验形状：非字符串被拒，词表值放行", () => {
  // Non-string shapes refuse (the value would reach a TEXT column).
  for (const bad of [42, { level: "high" }, ["high"], true]) {
    const parsed = parseFleetTemplate(manifestWith({ effort: bad }));
    assert.equal(parsed.ok, false, `effort ${JSON.stringify(bad)} must refuse`);
    assert.match(parsed.error, /effort/);
  }
  // A level string passes the parse even if no model declares it — the
  // vocabulary is a deployment-time fact, owned by the live write face.
  assert.equal(parseFleetTemplate(manifestWith({ effort: "extreme" })).ok, true);
  assert.equal(parseFleetTemplate(manifestWith({ effort: null })).ok, true);
});

test("carrier 非法值（spaceship）被拒", () => {
  const parsed = parseFleetTemplate(manifestWith({ carrier: "spaceship" }));
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /carrier/);
  assert.match(parsed.error, /auto|cell|worker|runner/);
});

// ── closure gate: MEMBER_RUNTIME_FIELDS ↔ createMember INSERT ────────────────
//
// A name on MEMBER_RUNTIME_FIELDS whose column is absent from createMember's
// INSERT is dropped WITHOUT ERROR — that was this change's actual bug
// (input_policy was missing from the INSERT even though deserializeMember and
// updateMember knew it). The gate below reads the INSERT source directly, so a
// declared-but-uncolumned field fails loudly instead of vanishing at provision
// time. camelCase → snake_case is mapped so `inputPolicy` checks `input_policy`.
const camelToSnake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const fleetsDbSrc = fs.readFileSync(path.join(repoRoot, "server/routes/fleets-db.js"), "utf8");
const insertColumnSet = new Set(
  fleetsDbSrc
    .match(/INSERT INTO fleet_members\s*\(([^)]*)\)/)[1]
    .split(",")
    .map((c) => c.trim()),
);

test("闭包：MEMBER_RUNTIME_FIELDS 每个字段都能在 createMember 的 INSERT 里找到对应列", () => {
  const missing = MEMBER_RUNTIME_FIELDS.filter((f) => !insertColumnSet.has(camelToSnake(f)));
  assert.deepEqual(
    missing,
    [],
    `createMember INSERT is missing column(s) for: ${missing.join(", ")} — a runtime field declared here but absent from the INSERT is silently dropped on provisioning`,
  );
});

test("闭包闸有牙：删掉某字段对应的列时，同一检查必须报红", () => {
  // Why this test exists: the gate above is only worth its name if it actually
  // reads the INSERT. This simulates the exact regression (carrier's column
  // missing) and asserts the SAME predicate reports it. If the closure were a
  // note in a comment instead of an assertion, provisioning would silently lose
  // the field while every test stayed green.
  const withoutCarrier = new Set([...insertColumnSet].filter((c) => c !== "carrier"));
  const reported = MEMBER_RUNTIME_FIELDS.filter((f) => !withoutCarrier.has(camelToSnake(f)));
  assert.deepEqual(reported, ["carrier"]);
});

// ── drift: contextBudget bounds must equal server/fleet-model.js's ───────────
//
// fleet-template.js restates the two bounds (it must stay gateway-pure, so it
// cannot import fleet-model.js). This pins the two against each other without an
// import: parse the numbers out of fleet-model.js source and compare.
test("漂移：contextBudget 上下界与 server/fleet-model.js 的同名常量一致", () => {
  const src = fs.readFileSync(path.join(repoRoot, "server/fleet-model.js"), "utf8");
  const read = (name) => Number(src.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`))[1].replace(/_/g, ""));
  assert.equal(CONTEXT_BUDGET_FLOOR, read("CONTEXT_BUDGET_FLOOR"));
  assert.equal(CONTEXT_BUDGET_CEILING, read("CONTEXT_BUDGET_CEILING"));
});
