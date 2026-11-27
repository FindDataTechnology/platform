// 判定运行装配（establish-agent-role-and-fitness-plane 2.2 / 3.x）。
//
// 钉的是「一行判定运行必须自己说得清它的证据等级与缺什么」：
//   · 只有观测臂 ⇒ mode=observed，裁决 inconclusive，missing 点名缺对照臂
//   · 输入不可变：staticAblation 与 readings 一起落进同一行
//   · 落库幂等：同 id 重放不产生第二行
//
// Run: node --test scripts/test-fitness-run.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { composeFitnessRun, persistFitnessRun } = await import("./fitness-run.mjs");
const { evaluateVerdict } = await import("../lib/fitness-verdict.js");

const W0 = 1_700_000_000_000;
const W1 = W0 + 86_400_000;

test("只有观测臂 ⇒ mode=observed，裁决 inconclusive，missing 点名缺对照臂", () => {
  const readings = { turns: 10, failureRate: 0.2, reportGapRate: 0.1, costUsd: 1 };
  const arms = [{ kind: "team", ref: "team" }];
  const verdict = evaluateVerdict({ arms: arms.map((a) => ({ ...a, readings })) });
  const run = composeFitnessRun({ fleetId: "f1", windowStart: W0, windowEnd: W1, arms, readingsByArm: { team: readings }, verdict });
  assert.equal(run.mode, "observed");
  assert.equal(run.verdict, "inconclusive");
  assert.ok(run.missing.some((m) => m.includes("对照臂")));
  assert.equal(run.evidence.level, "observed");
});

test("三臂 ⇒ mode=three-arm，证据等级同步", () => {
  const readings = { turns: 10, failureRate: 0.1, reportGapRate: 0.1, costUsd: 1 };
  const budget = { turnsPerDay: 3, tokensPerTurn: 1000 };
  const arms = [
    { kind: "control", ref: "control", budget },
    { kind: "team", ref: "team", budget },
    { kind: "ablation", ref: "drop-x", budget },
  ];
  const verdict = evaluateVerdict({ arms: arms.map((a) => ({ ...a, readings, observed: { tokens: 10, turns: 1 } })) });
  const run = composeFitnessRun({ fleetId: "f1", windowStart: W0, windowEnd: W1, budget, arms, readingsByArm: { team: readings }, verdict });
  assert.equal(run.mode, "three-arm");
  assert.equal(run.evidence.level, "three-arm");
});

test("判定输入不可变地随行落库：staticAblation 与 readings 同在一行", () => {
  const readings = { turns: 5, failureRate: 0.4, reportGapRate: 0.2, costUsd: 0.5 };
  const arms = [{ kind: "team", ref: "team" }];
  const verdict = evaluateVerdict({ arms: arms.map((a) => ({ ...a, readings })) });
  const run = composeFitnessRun({
    fleetId: "f1",
    windowStart: W0,
    windowEnd: W1,
    arms,
    readingsByArm: { team: readings },
    staticAblation: { ok: true, summary: { total: 3, candidateRetire: 1 } },
    verdict,
  });
  assert.deepEqual(run.evidence.staticAblation.summary, { total: 3, candidateRetire: 1 });
  assert.equal(run.readings.team.failureRate, 0.4);
});

test("落库 → 读回：行里带着缺失清单与裁决", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fitness-run-"));
  process.env.PLATFORM_DATA_DIR = tmp;
  process.env.CRON_STORAGE_PATH = tmp;
  process.env.DB_PATH = path.join(tmp, "app.db");
  process.env.DSH_HOME = path.join(tmp, "dsh");
  fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

  const dbPath = path.join(tmp, "fleets.db");
  const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
  const db = createFleetDatabase({ file: dbPath });
  const fleet = db.createFleet({ id: "f_persist", name: "判定舰", ownerEmail: "o@test" });
  db.close();

  const readings = { turns: 8, failureRate: 0.5, reportGapRate: 0.3, costUsd: 2 };
  const arms = [{ kind: "team", ref: "team" }];
  const verdict = evaluateVerdict({ arms: arms.map((a) => ({ ...a, readings })) });
  const run = composeFitnessRun({ fleetId: fleet.id, windowStart: W0, windowEnd: W1, arms, readingsByArm: { team: readings }, verdict });

  const first = await persistFitnessRun(run, { dbPath });
  assert.equal(first.ok, true);
  assert.equal(first.back.verdict, "inconclusive");
  assert.ok(first.back.missing.length > 0);

  const read = createFleetDatabase({ file: dbPath });
  const listed = read.listFitnessRuns(fleet.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].mode, "observed");
  read.close();
});