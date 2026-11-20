#!/usr/bin/env node
// ── 契约消费侧：三个消费者读的字段，契约必须都声明了 ─────────────────────────
//
// retire-wanxing-twin-face 3.4。契约（facet/contract/wanxing-public-api.v1.json）
// 只有在**消费方真的按它读**时才有约束力。本测试把两边的词表对上：
//
//   1. 脊柱 `/api/facades-catalog`：喂一条按 catalogEntry 形状的条目，断言投影
//      出来的行带齐脊柱承诺的字段，且契约声明的状态值原样透传；
//   2. `server/routes/fleets.js` 读 `byCaller[]`：抽出它真正访问的行字段，
//      断言每一个都在 opsUsageResponse.byCaller.items.properties 里；
//   3. `services/ops-console/index.js` 读 board：抽出它访问的字段，断言每一个
//      都在 fleetBoardResponse 里。
//
// 为什么用"词表对账"而不是跑一遍真请求：这两个消费者是内联闭包/服务端渲染，
// 没有可注入的读函数。词表对账能抓的正是我们怕的那件事——契约改名而消费方
// 没跟，或消费方读了个契约从没承诺的字段。改名一处即红（见任务 3.4 的红证）。
//
//   node --test scripts/test-wanxing-contract-consumer.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const contract = JSON.parse(readFileSync(path.join(ROOT, "facet", "contract", "wanxing-public-api.v1.json"), "utf8"));
const defs = contract.$defs;

const { projectFacadeEntries } = await import("../facet/supply-catalog.js");

// Descend through plain properties, array items, AND map-style
// additionalProperties (board.runners is an id → row map).
const propsOf = (def, ...extra) => {
  let node = defs[def];
  for (const key of extra) {
    node = node?.properties?.[key];
    if (node?.items) node = node.items;                                   // array element shape
    if (node?.additionalProperties && typeof node.additionalProperties === "object") node = node.additionalProperties; // id → row map
  }
  return Object.keys(node?.properties ?? {});
};

// One render function's body: accessing `f.`/`s.` outside it means something
// else (`s` is also a string variable in this file). Scoping to the function is
// what makes the field vocabulary meaningful.
function functionBodyAround(src, needle) {
  const at = src.indexOf(needle);
  assert.ok(at > 0, `marker not found: ${needle}`);
  const start = src.lastIndexOf("\nfunction ", at);
  const end = src.indexOf("\nfunction ", at);
  return src.slice(start, end < 0 ? undefined : end);
}

test("3.4 contract: the vendored copy declares a revision and the surfaces we consume", () => {
  // Pinned on purpose: bumping the owner's rev must fail here until a human
  // re-affirms that this consumer still matches. Rev 2 (2026-11-13) corrected
  // two board sub-shapes this consumer never read (`runner_liveness[*]` and
  // `agent_health[*]` item keys were declared under names the emitter never
  // sent) and declared `agent_health[*].window_hours`; nothing read here changed.
  assert.equal(contract["x-contract-rev"], "3");
  for (const def of ["catalogEntry", "opsUsageResponse", "fleetBoardResponse"]) {
    assert.ok(defs[def], `contract must define ${def}`);
  }
});

test("3.4 spine: a contract-shaped entry lands in the supply catalog with the promised fields", () => {
  // Exactly the shape the contract promises (required + the optional ones the
  // spine copies). status is the declared enum value, so it must pass through.
  const entry = {
    slug: "law-bench-assistant",
    name: "Law Bench",
    description: "法条检索",
    version: "1.2.0",
    tags: ["legal"],
    skills: [{ id: "case-retrieval" }],
    chatable: true,
    status: "paused",
    turns7d: 3,
  };
  const { facades, dropped, coerced } = projectFacadeEntries([entry], {
    bySlug: new Map([["law-bench-assistant", { packId: "law-bench", agentId: "assistant", deployedAt: 1 }]]),
    asOf: "2026-11-13T00:00:00.000Z",
  });
  assert.equal(dropped, 0);
  assert.equal(coerced, 0);
  const row = facades[0];
  // The spine's own promise to ITS consumers (contract: facades catalog).
  for (const field of ["id", "name", "description", "version", "tags", "status", "chatable", "deployment", "annotation"]) {
    assert.ok(field in row, `spine row must carry ${field}`);
  }
  assert.equal(row.id, entry.slug, "identity comes from the contract's slug, never a re-derivation");
  assert.equal(row.status, "paused", "a declared status passes through unchanged");
  assert.deepEqual(row.deployment, { packId: "law-bench", agentId: "assistant", deployedAt: 1 });
});

test("3.4 owner cross-line: every byCaller field fleets.js aggregates is declared by the contract", () => {
  const src = readFileSync(path.join(ROOT, "server", "routes", "fleets.js"), "utf8");
  // The consumer names its row variables differently per closure (`row` in the
  // filter, `b` in the reduces), so the check is anchored on the five fields the
  // owner cross-line view cannot work without: each must be READ here and
  // DECLARED there. A contract rename breaks the second half; a consumer that
  // stops reading one breaks the first.
  const declared = new Set(propsOf("opsUsageResponse", "byCaller"));
  assert.ok(src.includes("j.byCaller"), "fleets.js must consume the ops/usage byCaller array");
  const MUST = ["email", "turns", "minutes", "usd", "pending"];
  const missingRead = MUST.filter((f) => !new RegExp(`\\.${f}\\b`).test(src));
  const missingDecl = MUST.filter((f) => !declared.has(f));
  assert.deepEqual(missingRead, [], `fleets.js no longer reads: ${missingRead.join(", ")}`);
  assert.deepEqual(missingDecl, [], `contract no longer declares byCaller: ${missingDecl.join(", ")}`);
  // No row field is read without being declared: scan the byCaller slice only.
  const at = src.indexOf("j.byCaller");
  const slice = src.slice(at, src.indexOf("byAgent", at) + 400);
  const read = new Set([...slice.matchAll(/\b(?:row|b|x)\.([a-zA-Z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  const undeclared = [...read].filter((f) => !declared.has(f)).sort();
  assert.deepEqual(undeclared, [],
    `fleets.js reads byCaller fields the contract does not declare:\n  ${undeclared.join("\n  ")}`);
});

// `services/ops-console/` 被公开快照整体排除（make-public-snapshot 的
// EXCLUDE_PREFIXES：internal operator dashboard），镜像仓 CI 里没有这个文件。
// 缺席时这条判据在此树不可判 —— 跳过并写明原因，绝不静默当成通过。
// 2026-11-14 实历：这一行原是无条件 readFileSync，镜像仓 unit 分片连续 5 轮红。
const OPS_CONSOLE_INDEX = path.join(ROOT, "services", "ops-console", "index.js");
test("3.4 ops-console: every board field the console renders is declared by the contract", {
  skip: existsSync(OPS_CONSOLE_INDEX) ? false : "services/ops-console is not in the public drop (EXCLUDE_PREFIXES)",
}, () => {
  const src = readFileSync(OPS_CONSOLE_INDEX, "utf8");
  const boardFields = new Set(propsOf("fleetBoardResponse"));
  // The board section's own render function: `f` is the board, `s` a runner row.
  const body = functionBodyAround(src, "const states = f.states ?? {}");
  const fields = (text, prefix) =>
    new Set([...text.matchAll(new RegExp(`\\b${prefix}\\.([a-z_][a-z0-9_]*)`, "g"))]
      .map((m) => m[1])
      // `s.trim()` / `s.split()` are string methods on a different variable;
      // `__error` is the snapshot store's failure envelope, not a board field.
      .filter((name) => name !== "__error" && !new RegExp(`\\b${prefix}\\.${name}\\s*\\(`).test(text)));
  const readBoard = fields(body, "f");
  const readRunner = fields(body, "s");
  const runnerDeclared = new Set(propsOf("fleetBoardResponse", "runners"));
  assert.ok(readBoard.size >= 4, `expected several f.* accesses, saw ${[...readBoard].join(",")}`);
  assert.ok(readRunner.size >= 3, `expected several s.* accesses, saw ${[...readRunner].join(",")}`);
  const bad = [
    ...[...readBoard].filter((f) => !boardFields.has(f)).map((f) => `board.${f}`),
    ...[...readRunner].filter((f) => !runnerDeclared.has(f)).map((f) => `runners[].${f}`),
  ].sort();
  assert.deepEqual(bad, [], `ops-console renders fields the contract does not declare:\n  ${bad.join("\n  ")}`);
  for (const must of ["states", "runners", "ingest_lag", "settled_pending", "wake_ms", "agents_total"]) {
    assert.ok(readBoard.has(must), `ops-console must render ${must}`);
  }
});
