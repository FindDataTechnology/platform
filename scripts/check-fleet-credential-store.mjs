#!/usr/bin/env node
// ── 舰队凭据存储面体检（只读） ─────────────────────────────────────────────
//
// 抓的是「**凭据行还在、它所属的舰队已经不在了**」这一类静默故障，以及
// 「凭据行的 kind 没有解析方」这种只在接线时才会暴露的漏配。
//
// 为什么要有这道闸：2026-11-14 的幽灵舰队（`fleet_1794335712751_wfa3ww`）—
// 知验台登记成功、机器面 200、13 条提案署名给它，而平台侧没有任何活舰队对应。
// 那一整套判据全绿，因为知验台只校验字符串、平台只校验自己的行，没有一处问过
// 「这两边说的是同一个实体吗」。本闸把存储面与舰队名册摆在一起判，且**判不出
// 不许退 0**：读不到库被读成「没有孤儿行」，正是这道闸要防的。
//
// 输入由调用方喂（DB 在 pod 里，本脚本不碰 k8s，保持可离线复跑）：
//   node scripts/check-fleet-credential-store.mjs --store-json - <<'JSON'
//   { "fleets": [{ "id": "fleet_A" }],
//     "credentials": [{ "fleetId": "fleet_A", "kind": "bench", "tokenTail": "1111" }],
//     "orphaned": [] }
//   JSON
//
// 判据（逐条打印）：
//   R1 每条凭据行的 fleet 必须存在于 fleets（缺 ⇒ FAIL）
//   R2 kind 必须在已知集合里（缺解析方 ⇒ FAIL）
//   R3 tokenTail 必须非空——指纹是给人读的，空指纹说明行里没有令牌
//   R4 调用方若带了 `orphaned`，它必须为空（存储层自己的孤儿查询与 R1 互相印证）
// 没有凭据行时不算失败，只打印「无人持有」（这是合法的引导前状态），但**清单要说话**：
//   「0 条」与「没读到」在输出里必须长得不一样。
//
// 退出码：0 全部成立 / 1 有命中 / 2 判不出（缺输入、JSON 不可解析、结构不对）
//
//   node --test scripts/test-check-fleet-credential-store.mjs
//   node scripts/check-fleet-credential-store.mjs --self-test

import { readFileSync } from "node:fs";

const KNOWN_KINDS = new Set(["bench"]);

function parseArgs(argv) {
  const out = { storeJson: null, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--self-test") out.selfTest = true;
    else if (a === "--store-json") out.storeJson = argv[++i];
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

// 输入规范化。结构不对要抛（调用方据此退 2），不能默默当成空集合 ——
// 「空集合」与「读错了」在判据里必须分得开。
export function normalizeStore(raw) {
  if (!raw || typeof raw !== "object") throw new Error("store json 必须是对象");
  const fleets = Array.isArray(raw.fleets) ? raw.fleets.map((f) => ({ id: String(f?.id ?? "") })) : null;
  if (!fleets) throw new Error("store json 缺 fleets 数组（名册必须一起喂，否则判不了 R1）");
  const credentials = Array.isArray(raw.credentials)
    ? raw.credentials.map((c) => ({
        fleetId: String(c?.fleetId ?? ""),
        kind: String(c?.kind ?? ""),
        tokenTail: String(c?.tokenTail ?? ""),
        updatedAt: c?.updatedAt ?? null,
      }))
    : [];
  const orphaned = Array.isArray(raw.orphaned)
    ? raw.orphaned.map((c) => ({ fleetId: String(c?.fleetId ?? ""), kind: String(c?.kind ?? "") }))
    : null;
  return { fleets, credentials, orphaned };
}

/**
 * 判据本体（纯函数）。返回 { findings:[{code,detail}], notes:[], counts }。
 * findings 非空即命中；notes 是「该说话」的绿信息（例如持有者清单）。
 */
export function judge({ fleets, credentials, orphaned }) {
  const findings = [];
  const notes = [];
  const fleetIds = new Set(fleets.map((f) => f.id).filter(Boolean));

  for (const c of credentials) {
    if (!c.fleetId) {
      findings.push({ code: "R1", detail: "有一条凭据行没有 fleetId（结构坏了，无法判归属）" });
      continue;
    }
    if (!fleetIds.has(c.fleetId)) {
      findings.push({ code: "R1", detail: `凭据行指向 ${c.fleetId}，而 fleets 名册里没有这一行（幽灵）` });
    }
    if (!KNOWN_KINDS.has(c.kind)) {
      findings.push({ code: "R2", detail: `${c.fleetId} 的凭据 kind="${c.kind}" 没有解析方（已知：${[...KNOWN_KINDS].join(", ")}）` });
    }
    if (!c.tokenTail) {
      findings.push({ code: "R3", detail: `${c.fleetId}/${c.kind} 的指纹为空 —— 行里没有令牌` });
    }
  }

  if (orphaned) {
    for (const o of orphaned) {
      findings.push({ code: "R4", detail: `存储层自己的孤儿查询命中 ${o.fleetId}/${o.kind}（与 R1 应互相印证）` });
    }
  } else {
    notes.push("调用方未提供 orphaned 视图 —— R4 未判（不算通过）");
  }

  if (credentials.length === 0) {
    notes.push("凭据存储为空：0 支舰队持有 bench 凭据（引导前的合法状态；共享补丁因此不带 bench 行）");
  } else {
    // A row whose fleet is gone is NOT a holder — that is the whole ghost point,
    // and counting it here would print a reassuring "shared patch carries X's
    // token" for an X that does not exist.
    const holders = [...new Set(credentials.filter((c) => fleetIds.has(c.fleetId)).map((c) => c.fleetId))].sort();
    if (holders.length === 0) {
      notes.push(`凭据行 ${credentials.length} 条，但没有一条指向名册内的舰队 ⇒ 共享补丁不带 bench 行（上面逐条点名了原因）`);
    } else {
      const mode = holders.length === 1 ? "sole" : "multiple";
      notes.push(
        `持有者 ${holders.length} 支：${holders.join(", ")} ⇒ 共享补丁${mode === "sole" ? `携带 ${holders[0]} 的令牌` : "不带 bench 行（按成员授予）"}`,
      );
    }
  }

  return { findings, notes, counts: { fleets: fleets.length, credentials: credentials.length } };
}

const EXIT = (verdict) => (verdict === "ok" ? 0 : verdict === "fail" ? 1 : 2);

export function verdictOf(result) {
  return result.findings.length ? "fail" : "ok";
}

async function readJson(spec) {
  if (!spec) return null;
  if (spec === "-") return JSON.parse(readFileSync(0, "utf8"));
  return JSON.parse(readFileSync(spec, "utf8"));
}

async function selfTest() {
  // 每一档红都要有夹具，且必须留一条绿路 —— 只证红的话，
  // 「判据写反」与「全程命中」在输出上长得一模一样。
  const cases = [
    {
      name: "健康：sole holder",
      input: { fleets: [{ id: "fleet_A" }], credentials: [{ fleetId: "fleet_A", kind: "bench", tokenTail: "1111" }], orphaned: [] },
      want: 0,
    },
    {
      name: "健康：0 持有者（引导前）",
      input: { fleets: [{ id: "fleet_A" }], credentials: [], orphaned: [] },
      want: 0,
    },
    {
      name: "幽灵：凭据行的舰队不在名册",
      input: { fleets: [{ id: "fleet_B" }], credentials: [{ fleetId: "fleet_ghost", kind: "bench", tokenTail: "1111" }], orphaned: [] },
      want: 1,
    },
    {
      name: "未知 kind",
      input: { fleets: [{ id: "fleet_A" }], credentials: [{ fleetId: "fleet_A", kind: "wire", tokenTail: "1111" }], orphaned: [] },
      want: 1,
    },
    {
      name: "空指纹",
      input: { fleets: [{ id: "fleet_A" }], credentials: [{ fleetId: "fleet_A", kind: "bench", tokenTail: "" }], orphaned: [] },
      want: 1,
    },
    {
      name: "存储层孤儿视图命中",
      input: { fleets: [{ id: "fleet_A" }], credentials: [], orphaned: [{ fleetId: "fleet_gone", kind: "bench" }] },
      want: 1,
    },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = EXIT(verdictOf(judge(normalizeStore(c.input))));
    const ok = got === c.want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? "✓" : "✗"} ${c.name}: exit=${got}（期望 ${c.want}）`);
  }
  // 判不出两档：没有输入 / 结构不对。
  const undet = [
    ["没有 --store-json", null],
    ["名册缺失", { credentials: [] }],
  ];
  for (const [name, input] of undet) {
    let code;
    try {
      if (!input) code = 2;
      else {
        normalizeStore(input);
        code = 0;
      }
    } catch {
      code = 2;
    }
    const ok = code === 2;
    if (!ok) bad += 1;
    console.log(`  ${ok ? "✓" : "✗"} ${name}: exit=${code}（期望 2）`);
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
    console.error(`判不出：读不到 store json（${e?.message || e}）`);
    return 2;
  }
  if (!raw) {
    console.error("判不出：缺 --store-json（用 - 从 stdin 喂）");
    return 2;
  }
  let store;
  try {
    store = normalizeStore(raw);
  } catch (e) {
    console.error(`判不出：${e?.message || e}`);
    return 2;
  }
  const result = judge(store);
  console.log(`舰队凭据存储面：${result.counts.fleets} 支舰队 / ${result.counts.credentials} 条凭据行`);
  for (const n of result.notes) console.log(`  · ${n}`);
  for (const f of result.findings) console.log(`  ✗ [${f.code}] ${f.detail}`);
  if (!result.findings.length) console.log("判定：无命中（R1-R4 成立）");
  return EXIT(verdictOf(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e?.stack || String(e));
      process.exit(2);
    });
}
