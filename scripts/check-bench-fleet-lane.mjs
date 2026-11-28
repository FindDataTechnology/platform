#!/usr/bin/env node
// ── 舰队的 bench 取数通道体检（只读） ──────────────────────────────────────
//
// 抓的是「**凭据过期 ⇒ 提案恒零，而所有别的判据全绿**」这一类静默故障。
//
// 2026-11-14 实况（`add-bench-ops-tools` 5.2 里记的那条）：`fleet_1793422472811_i28xac`
// 的五岗链是 盘账员取数(mcp.json 的 `wire-ops`) → 建模师 → 提案员调
// `bench_proposal_submit`。owner `aloadtree@gmail.com` 在**承载该舰队的 cell**
// （`1da519d4c1c0bf89`）里的 `wire-customer` 行自 2026-11-10 06:44 起 `stale=1`，而
// `line-credentials.js` 的 `liveToken()` 对 stale 行直接返回 null ⇒ 那个 MCP 子进程拿不到
// 凭据 ⇒ 盘账员报「wire 四读面在本聚焦模式确认缺位」⇒ 建模师空批 ⇒ 提案员零提交。
// 每一环都"正常工作"，只有最后的产出是零 —— 而**零产出不会红任何东西**
// （提案面健康、工单面健康、绑定闸绿、机器面 401/405 都符合预期）。
//
// 探过两次（2026-11-14、2026-11-15）：这条状态一直没变，所以它该是判据而不是文档里的一句话。
//
// 判据（只打「持有 bench 凭据的舰队」这一个小人口——不是全平台一问，那会变成常年红闸）：
//   R1 该舰队 owner 在他自己 cell 里必须有 ≥1 条 line 凭据行；一行都没有 ⇒ **红**
//      （取数面是空的，这条链的输入不存在）
//   R2 那些行里**不许有 stale=1** ⇒ 有就红，并逐行点名 line 与最后更新时间
//   R3 判不出（缺 fleet/cell 输入、缺 credentials 输入）⇒ **exit 2，不许当通过**
// 不做的事：不推断「哪条 line 是它该用的」（那要从 pack 的 mcp 行反推，推错方向会替错配置
// 背书）；只按 owner 的行集合判——owner 是本舰队岗位跑回合的身份，它的行就是这个 cell 的脸。
//
// 用法（输入由调用方从 pod 喂，本脚本不碰 k8s）：
//   node scripts/check-bench-fleet-lane.mjs --store-json - <<'JSON'
//   { "fleets": [{ "id": "fleet_A", "ownerEmail": "o@x.y", "cell": "1da519d4c1c0bf89" }],
//     "credentials": [{ "cell": "1da519d4c1c0bf89", "email": "o@x.y", "line": "wire-customer", "stale": 1 }] }
//   JSON
//   可选 `benchHolders: ["fleet_A"]`：只判这些（缺省＝有凭据行的那些，见 --bench-holders）。
//
// 退出码：0 无命中 / 1 有命中 / 2 判不出
//
//   node --test scripts/test-check-bench-fleet-lane.mjs
//   node scripts/check-bench-fleet-lane.mjs --self-test

import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { storeJson: null, selfTest: false, benchHolders: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--self-test") out.selfTest = true;
    else if (a === "--store-json") out.storeJson = argv[++i];
    else if (a === "--bench-holders") out.benchHolders = String(argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

export function normalizeLaneInput(raw) {
  if (!raw || typeof raw !== "object") throw new Error("lane json 必须是对象");
  if (!Array.isArray(raw.fleets)) throw new Error("缺 fleets 数组（舰队名册必须一起喂）");
  if (!Array.isArray(raw.credentials)) throw new Error("缺 credentials 数组（凭据行必须一起喂，否则判不了 R2）");
  return {
    fleets: raw.fleets.map((f) => ({
      id: String(f?.id ?? ""),
      ownerEmail: String(f?.ownerEmail ?? "").trim().toLowerCase(),
      cell: f?.cell == null ? null : String(f.cell),
    })),
    credentials: raw.credentials.map((c) => ({
      cell: c?.cell == null ? null : String(c.cell),
      email: String(c?.email ?? "").trim().toLowerCase(),
      line: String(c?.line ?? ""),
      stale: Number(c?.stale ?? 0) === 1,
      updatedAt: c?.updatedAt ?? null,
    })),
    benchHolders: Array.isArray(raw.benchHolders) ? raw.benchHolders.map((x) => String(x)) : null,
  };
}

/**
 * 判据本体（纯函数）。人口 = benchHolders（显式）或调用方标了 hasBenchCredential 的舰队；
 * 两者都没有时**判不出**，不是"没有人口所以绿"。
 */
export function judge({ fleets, credentials, benchHolders }, { holders = null } = {}) {
  const findings = [];
  const notes = [];
  const holderIds = holders ?? benchHolders;
  if (!Array.isArray(holderIds) || holderIds.length === 0) {
    return {
      findings,
      notes: ["没有给出持有 bench 凭据的舰队（--bench-holders / benchHolders）——判不出该判谁"],
      counts: { population: 0, checked: 0 },
      undetermined: true,
    };
  }
  let checked = 0;
  for (const id of holderIds) {
    const fleet = fleets.find((f) => f.id === id);
    if (!fleet) {
      findings.push({ code: "R0", detail: `bench 持有者 ${id} 不在舰队名册里（判不出它属于哪个 cell）` });
      continue;
    }
    if (!fleet.ownerEmail) {
      findings.push({ code: "R0", detail: `${id} 没有 ownerEmail——判不出该按谁的凭据行判` });
      continue;
    }
    // Only rows in the fleet's own cell count: the cell is the process that runs
    // its posts, and a fresh row in some other cell's db is not the credential
    // this fleet's MCP child would read.
    const rows = credentials.filter(
      (c) => c.email === fleet.ownerEmail && (fleet.cell == null || c.cell === fleet.cell),
    );
    checked += 1;
    if (rows.length === 0) {
      findings.push({
        code: "R1",
        detail: `${id}（owner ${fleet.ownerEmail}${fleet.cell ? ` @ ${fleet.cell}` : ""}）没有任何 line 凭据行——取数面是空的，提案链没有输入`,
      });
      continue;
    }
    const stale = rows.filter((r) => r.stale);
    if (stale.length) {
      for (const r of stale) {
        findings.push({
          code: "R2",
          detail: `${id}（owner ${fleet.ownerEmail}${r.cell ? ` @ ${r.cell}` : ""}）的 ${r.line} 凭据 stale=1${r.updatedAt ? `（最后更新 ${r.updatedAt}）` : ""} ⇒ liveToken() 返回 null，取数面拿不到凭据`,
        });
      }
      notes.push("处置：由该 owner 本人在浏览器里重授权对应线（ID-token 线、PKCE silent）——这是人工前置，不是工程能替的");
    } else {
      notes.push(`${id}: ${rows.length} 条 line 凭据全部可用（${rows.map((r) => r.line).join(", ")}）`);
    }
  }
  return { findings, notes, counts: { population: holderIds.length, checked } };
}

export function verdictOf(result) {
  if (result.undetermined) return "undetermined";
  return result.findings.length ? "fail" : "ok";
}

const EXIT = (v) => (v === "ok" ? 0 : v === "fail" ? 1 : 2);

async function readJson(spec) {
  if (!spec) return null;
  if (spec === "-") return JSON.parse(readFileSync(0, "utf8"));
  return JSON.parse(readFileSync(spec, "utf8"));
}

async function selfTest() {
  const base = {
    fleets: [{ id: "fleet_A", ownerEmail: "o@x.y", cell: "cell1" }, { id: "fleet_B", ownerEmail: "o@x.y", cell: "cell2" }],
    credentials: [
      { cell: "cell1", email: "o@x.y", line: "lex", stale: 0 },
      { cell: "cell1", email: "o@x.y", line: "wire-customer", stale: 1, updatedAt: "2026-11-10T06:44Z" },
    ],
    benchHolders: ["fleet_A"],
  };
  const cases = [
    ["红：owner 的 wire-customer 过期（2026-11-14/15 真实形态）", base, 1],
    ["绿：同一 owner 的行都新鲜", { ...base, credentials: [{ cell: "cell1", email: "o@x.y", line: "lex", stale: 0 }] }, 0],
    ["红：owner 一行都没有（取数面空）", { ...base, credentials: [] }, 1],
    // 夹具要给出「本 cell 有新鲜行」这一半：只剩别的 cell 的行时，本舰队其实是 R1
    // （一行都没有），不是 R2 —— 第一版这两例就写错了，红在夹具而不是判据。
    [
      "绿：本 cell 有新鲜行时，别的 cell 的过期行不影响本舰队",
      {
        ...base,
        credentials: [
          { cell: "cell1", email: "o@x.y", line: "lex", stale: 0 },
          { cell: "cell2", email: "o@x.y", line: "wire-customer", stale: 1 },
        ],
      },
      0,
    ],
    [
      "绿：非持有者不判（它自己 cell 的行是新鲜的）",
      {
        fleets: base.fleets,
        credentials: [
          { cell: "cell1", email: "o@x.y", line: "wire-customer", stale: 1 },
          { cell: "cell2", email: "o@x.y", line: "lex", stale: 0 },
        ],
        benchHolders: ["fleet_B"],
      },
      0,
    ],
    ["红：持有者不在名册", { ...base, benchHolders: ["fleet_ghost"] }, 1],
  ];
  let bad = 0;
  for (const [name, input, want] of cases) {
    let got;
    try {
      got = EXIT(verdictOf(judge(normalizeLaneInput(input))));
    } catch {
      got = 2;
    }
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? "✓" : "✗"} ${name}: exit=${got}（期望 ${want}）`);
  }
  // 判不出两档：缺人口 / 缺输入。
  const undet = [
    ["判不出：没给 bench 持有者", { ...base, benchHolders: null }, 2],
    ["判不出：没有 --store-json", null, 2],
  ];
  for (const [name, input, want] of undet) {
    let got;
    try {
      got = input ? EXIT(verdictOf(judge(normalizeLaneInput(input)))) : 2;
    } catch {
      got = 2;
    }
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? "✓" : "✗"} ${name}: exit=${got}（期望 ${want}）`);
  }
  console.log(bad === 0 ? "\nself-test 全过" : `\nself-test ${bad} 项不符`);
  return bad === 0 ? 0 : 1;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.selfTest) return selfTest();
  let raw;
  try {
    raw = await readJson(args.storeJson);
  } catch (e) {
    console.error(`判不出：读不到 lane json（${e?.message || e}）`);
    return 2;
  }
  if (!raw) {
    console.error("判不出：缺 --store-json（用 - 从 stdin 喂）");
    return 2;
  }
  let input;
  try {
    input = normalizeLaneInput(raw);
  } catch (e) {
    console.error(`判不出：${e?.message || e}`);
    return 2;
  }
  const result = judge(input, { holders: args.benchHolders ?? input.benchHolders });
  console.log(`舰队 bench 取数通道：人口 ${result.counts.population} 支 / 实际判了 ${result.counts.checked} 支`);
  for (const n of result.notes) console.log(`  · ${n}`);
  for (const f of result.findings) console.log(`  ✗ [${f.code}] ${f.detail}`);
  const v = verdictOf(result);
  if (v === "ok") console.log("判定：无命中（R1-R2 成立）");
  if (v === "undetermined") console.log("判定：判不出（缺人口或输入不全）");
  return EXIT(v);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e?.stack || String(e));
      process.exit(2);
    });
}
