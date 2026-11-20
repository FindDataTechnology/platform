#!/usr/bin/env node
// ── bench-ops 工具面体检（只读） ────────────────────────────────────────────
//
// `add-bench-ops-tools` 的 5.2 卡在一句话上：四条 ops 工具（领单 / 认领 / 关单 /
// 回写）**对任何舰队都不可达**。代码早已上产（`1ad1241ed` + 两笔真机修复），但
// 「能力面有没有授予」此前只有一个判法：人手动 `kubectl exec` 进去数 `/proc`。
// 那是**一次性读数**，不是判据 —— 授予前后各数一遍靠的是记忆，而记忆正是这个仓
// 里最不可靠的东西（同族：`check-bench-fleet-lane.mjs` 把「凭据 stale」从一句
// 文档变成一条闸）。
//
// 判据（只回答「这个面此刻到不到得了岗位」，不推断它该给谁）：
//   J1 `bench-ops` 在 operator `mcp.json` 的名字表里吗？
//      不在 ⇒ **红**：定义都不存在，任何舰队都不可能有它。这是今天的实况。
//   J2 有任一活 dsh 真的 spawn 了 `bench-ops` 子进程吗？
//      定义在、但没人装载 ⇒ **红**（overlay/pack 没声明，或声明了但被组/凭据闸删掉）。
//   J3 输入不全（缺 mcp 名字表或缺 dsh 清单）⇒ **exit 2 判不出**，不许当通过。
//
// 附带一条事实行（不参与判定）：参考面 `bench-proposal` 的装载比例 N/M。
// 它存在的理由：`bench-proposal` 也是 mcp.json + `envRefs` 的 server，2026-11-17
// 实测只落在 **2/6** 个 dsh 上 ⇒ 「加进 mcp.json 就等于人人都有」是错的，而
// 「加进去只给一支」也没被证过。把这两句一起印出来，读的人才知道自己面对的是
// 哪一种授予语义（详见记忆 `operator-mcp-json-reaches-every-focused-role`）。
//
// 用法（输入由调用方从 pod 喂，本脚本不碰 k8s、不联网）：
//   node scripts/check-bench-ops-surface.mjs --store-json - <<'JSON'
//   { "mcpServers": ["connector", "bench-proposal", "..."],
//     "dsh": [ { "pid": 3286, "children": ["library", "bench-proposal"] },
//              { "pid": 3424, "children": ["library"] } ] }
//   JSON
//
//   node scripts/check-bench-ops-surface.mjs --self-test
//
// 退出码：0 已授予且已装载 / 1 有命中 / 2 判不出

import { readFileSync } from "node:fs";

const SERVER = "bench-ops";
const REFERENCE = "bench-proposal";
//: 授予落地后应当出现的四个工具名（`tools/list` 的期望值）。这里只用于报文，
//: 判定不依赖它——工具名在读面由 MCP `tools/list` 证明，不靠数进程。
const TOOLS = [
  "bench_work_order_list",
  "bench_work_order_claim",
  "bench_work_order_complete",
  "bench_run_report",
];

function parseArgs(argv) {
  const out = { storeJson: null, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--self-test") out.selfTest = true;
    else if (a === "--store-json") out.storeJson = argv[i + 1] ?? null;
    else if (a.startsWith("--store-json=")) out.storeJson = a.slice("--store-json=".length);
    else if (a === "-h" || a === "--help") {
      console.log("usage: check-bench-ops-surface.mjs --store-json <path|-> | --self-test");
      process.exit(0);
    }
  }
  return out;
}

function readInput(spec) {
  if (!spec) return null;
  const raw = spec === "-" ? readFileSync(0, "utf8") : readFileSync(spec, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { __parseError: e?.message || String(e) };
  }
}

/**
 * The whole judgment, pure: no IO, so the self-test drives it directly.
 *
 * @returns {{code: 0|1|2, lines: string[]}}
 */
export function judge(input) {
  const lines = [];
  if (!input || input.__parseError) {
    return {
      code: 2,
      lines: [`✗ 判不出：输入读不了（${input?.__parseError || "没有输入"}）`],
    };
  }

  const names = Array.isArray(input.mcpServers) ? input.mcpServers.map(String) : null;
  const dsh = Array.isArray(input.dsh) ? input.dsh : null;
  if (!names) {
    return { code: 2, lines: ["✗ 判不出：缺 `mcpServers`（operator mcp.json 的名字表）"] };
  }
  if (!dsh) {
    return { code: 2, lines: ["✗ 判不出：缺 `dsh`（活 dsh 及其子进程清单）"] };
  }

  const live = dsh.filter((d) => d && Array.isArray(d.children));
  const carrying = live.filter((d) => d.children.map(String).includes(SERVER));
  const refCarrying = live.filter((d) => d.children.map(String).includes(REFERENCE));

  const declared = names.includes(SERVER);
  lines.push(
    declared
      ? `· 定义：\`${SERVER}\` 在 operator mcp.json（${names.length} 个 server 里）`
      : `· 定义：\`${SERVER}\` **不在** operator mcp.json（${names.length} 个 server 里）`,
  );
  lines.push(
    `· 装载：${carrying.length}/${live.length} 个活 dsh 有 \`${SERVER}\` 子进程` +
      `（参考面 \`${REFERENCE}\`：${refCarrying.length}/${live.length}）`,
  );

  // J1 — no definition means nobody can ever have it. Name the fix, not the symptom:
  // the two candidate routes differ in blast radius, and that difference is the whole
  // decision (mcp.json is a shared name table; a pack version is per-fleet).
  if (!declared) {
    lines.push(
      `✗ 未授予：\`${SERVER}\` 没有定义 ⇒ 四个工具（${TOOLS.join(" / ")}）对任何舰队都不可达。` +
        "授予要么走 pack 新版本（按 scope.mcpKeep 收窄），要么先确认 operator mcp.json 这条路的实际范围——" +
        "2026-11-17 实测参考面只落 2/6，范围不是「全员」。",
    );
    return { code: 1, lines };
  }

  // J2 — declared but never spawned: the declaration is not reaching any role.
  // BUT with zero live dsh this is undecidable, not red: "nobody loads it" and
  // "nothing is running to load it" are the same reading at 0/0. That is the
  // 「判不出当红」 family, and it fires exactly after a platform roll (§ 2026-11-17
  // 实测：新 pod 里 dsh 还没起来，脚本把 0/0 读成未装载)。
  if (live.length === 0) {
    lines.push(
      "✗ 判不出：没有任何活 dsh（MCP 子进程一个都没有）——此刻读不到「谁装载了它」" +
        "，这与「装载面是空的」在 0/0 上同形。等平台上起一支 dsh 再判；本行不是命中。",
    );
    return { code: 2, lines };
  }
  if (carrying.length === 0) {
    lines.push(
      `✗ 未装载：\`${SERVER}\` 有定义，但没有任何活 dsh 装载它` +
        "（pack/overlay 没声明，或声明后被组/凭据闸删掉）。",
    );
    return { code: 1, lines };
  }

  lines.push(`✓ 已授予：${carrying.length}/${live.length} 个活 dsh 装载了 \`${SERVER}\``);
  return { code: 0, lines };
}

// ── self-test ────────────────────────────────────────────────────────────────
//
// 每条臂都断言 **退出码 + 报文里的具体片段**：只断言「有输出」或只断言 rc，
// 会让「判据被删空」与「判据跑过」长得一样（本仓已撞过三次）。
const SELF_TEST_ARMS = 8;

function selfTest() {
  const arms = [];
  const arm = (name, input, wantCode, wantFragments) => {
    const { code, lines } = judge(input);
    const text = lines.join("\n");
    const problems = [];
    if (code !== wantCode) problems.push(`期望 rc=${wantCode}，实得 ${code}`);
    for (const frag of wantFragments) {
      if (!text.includes(frag)) problems.push(`报文缺片段：${frag}`);
    }
    arms.push({ name, ok: problems.length === 0, problems, code, text });
  };

  const base = ["connector", REFERENCE, "library"];
  const dshWith = (names) => [{ pid: 1, children: names }, { pid: 2, children: ["library"] }];

  // 1. 今天的实况：定义都没有 ⇒ 红，且报文要点名「对任何舰队都不可达」
  arm("定义缺失即红", { mcpServers: base, dsh: dshWith(["library", REFERENCE]) }, 1, [
    "未授予",
    "对任何舰队都不可达",
  ]);
  // 2. 定义在、没人装载 ⇒ 红（区分「没定义」与「没装载」两种处置方向）
  arm("定义在但零装载即红", { mcpServers: [...base, SERVER], dsh: dshWith(["library"]) }, 1, [
    "未装载",
    "没有任何活 dsh",
  ]);
  // 3. 绿路：定义在 + 有 dsh 装载
  arm("定义在且有装载即绿", { mcpServers: [...base, SERVER], dsh: dshWith(["library", SERVER]) }, 0, [
    "已授予",
    "1/2",
  ]);
  // 4. 绿路里不许出现红字（只断言「没有 ✗」会把「判据没跑」读成绿）
  arm("绿路不出现未授予字样", { mcpServers: [...base, SERVER], dsh: dshWith([SERVER]) }, 0, [
    "✓ 已授予",
  ]);
  // 5. 缺名字表 ⇒ 判不出（2，不是 1：不知道不等于不合格）
  arm("缺 mcpServers 判不出", { dsh: dshWith([SERVER]) }, 2, ["缺 `mcpServers`"]);
  // 6. 缺 dsh 清单 ⇒ 判不出
  arm("缺 dsh 判不出", { mcpServers: [...base, SERVER] }, 2, ["缺 `dsh`"]);
  // 7. 坏 JSON ⇒ 判不出（不是崩）
  arm("坏输入判不出", { __parseError: "Unexpected token" }, 2, ["判不出"]);
  // 8. 定义在但**一支活 dsh 都没有** ⇒ 判不出（0/0 上「没人装载」与「没有东西可装载」同形；
  //    2026-11-17 平台滚动后实测撞到：新 pod 里 dsh 还没起，脚本曾把它读成「未装载」）
  arm("零活 dsh 判不出", { mcpServers: [...base, SERVER], dsh: [] }, 2, [
    "判不出",
    "没有任何活 dsh",
  ]);

  let failed = 0;
  for (const a of arms) {
    if (a.ok) {
      console.log(`  ✓ ${a.name}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${a.name}：${a.problems.join("；")}`);
      console.log(`    实得 rc=${a.code}`);
      for (const line of a.text.split("\n")) console.log(`      ${line}`);
    }
  }
  console.log(`\n自证 ${arms.length}/${SELF_TEST_ARMS} 臂：通过 ${arms.length - failed} / 失败 ${failed}`);
  if (arms.length !== SELF_TEST_ARMS) {
    console.log(`✗ 臂数与 SELF_TEST_ARMS=${SELF_TEST_ARMS} 不符——自证自己被改过`);
    return 1;
  }
  return failed === 0 ? 0 : 1;
}

// Only run the real judgment when asked to: an accidental `node script.mjs` must
// not silently read stdin and exit 2 (that reads as "flat" to a scheduler).
const args = parseArgs(process.argv.slice(2));
if (args.selfTest) {
  process.exit(selfTest());
}
if (!args.storeJson) {
  console.error("usage: check-bench-ops-surface.mjs --store-json <path|-> | --self-test");
  process.exit(2);
}
const verdict = judge(readInput(args.storeJson));
for (const line of verdict.lines) console.log(line);
process.exit(verdict.code);
