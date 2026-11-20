#!/usr/bin/env node
// ── Bench ↔ 平台 的舰队绑定体检（只读） ─────────────────────────────────────
//
// 抓的是「**登记与实体各自成立、而它们是两支不同的舰队**」这一类静默故障。
//
// 2026-11-14 实况：知验台 `distribution_consumers` 里 `ontology-fleet-win` 绑的
// `fleet_1700000000001_ghost1`（下文与夹具里的舰队 ID 一律是**同形状的合成值**：
// 真值会随本文件进公开镜像仓，而它是生产实体的标识，不是可公开的证据），在平台
// `fleets` 表里**根本不存在**（prod 只有 `..._other3`/`..._exist2`，demo 0 行，
// 13 张表穷举 0 命中）。而那一整套判据全绿：
// 登记成功、机器面 200、四行证据齐、strict 无红灯——因为**知验台只校验字符串**，
// 平台只校验它自己的行，没有任何一处问过「这两边说的是同一支舰队吗」。
//
// 所以本脚本只做一件事：把两边的事实摆在一起。
//   A 面（凭据侧）：用 `BENCH_FLEET_TOKEN` 打机器面 `GET work-orders`，
//     对端回给我们的 `fleet_ref` 就是这枚凭据被认证成的那支舰队（**不猜、不读配置**）。
//   B 面（实体侧）：平台 `fleets` 表的行（由调用方喂进来——DB 在 pod 里，
//     本脚本不碰 k8s，保持可离线复跑）。
// 判据：A 必须 ∈ B；且 B 那支不能是「零轮次的哑壳」（iterations/reports/runs 全零）。
//
// **B 面要读 cell 的库，不是主进程自己那份**（2026-11-14 我在这上面判错过一次）：
// 平台是「每 cell 一个数据目录」（`paths.js` 的 `storeDir` 由 `PLATFORM_DATA_DIR` 决定），
// 舰队住在 `/data/cells/<cell>/data/data/fleets.db`；`/data/data/fleets.db` 是**主进程自己**
// 那个库。同一时刻实测：全局那份 2 行，16 个 cell 合计 86 支/7207 轮 —— 拿全局那份判，
// 会把所有真实舰队判成「不存在」，而错的方向还恰好是「看起来很严格」。
// 一个 fleet 只属于一个 cell，所以喂服务它的那个 cell 的库就行。
//
// 用法（线上）：
//   kubectl -n fd-prod exec deploy/platform -- node -e '…导出 fleets json…' \
//     | node scripts/check-bench-fleet-binding.mjs --fleets-json -
//   BENCH_FLEET_TOKEN 从 Secret 注入环境，不进命令行。
//
// 退出码：0 绑定成立且舰队活着 / 1 绑定不成立（幽灵或哑壳）/ 2 判不出（缺输入、对端不可达）
// **判不出不许退 0**：一次网络故障被读成「绑定没问题」，正是这道闸存在的理由。
//
//   node --test scripts/test-check-bench-fleet-binding.mjs
//   node scripts/check-bench-fleet-binding.mjs --self-test

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DOMAIN_ENV = "BENCH_PROPOSAL_DOMAIN";
const URL_ENV = "BENCH_URL";
const TOKEN_ENV = "BENCH_FLEET_TOKEN";

function parseArgs(argv) {
  const out = { fleetsJson: null, url: null, domain: null, tokenEnv: TOKEN_ENV, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--self-test") out.selfTest = true;
    else if (a === "--fleets-json") out.fleetsJson = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--domain") out.domain = argv[++i];
    else if (a === "--token-env") out.tokenEnv = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

/** A 面：对端告诉我们的那支舰队（唯一权威——它刚认证过这枚凭据）。 */
export async function fetchAuthenticatedFleet({ url, domain, token, fetchImpl = fetch }) {
  const target = `${url.replace(/\/+$/, "")}/api/v1/distribution/${encodeURIComponent(domain)}/work-orders`;
  const res = await fetchImpl(target, {
    method: "GET",
    headers: { "content-type": "application/json", "x-consumer-token": token },
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { detail: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(`bench ${res.status}: ${body.detail || "no detail"}`);
    err.status = res.status;
    throw err;
  }
  return { fleetRef: String(body.fleet_ref ?? ""), domain: String(body.domain ?? domain) };
}

/** B 面：平台自己的舰队行。 */
export function parseFleets(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.fleets) ? raw.fleets : null;
  if (!list) throw new Error("fleets json 必须是数组，或 {fleets:[…]}");
  return list.map((f) => ({
    id: String(f.id ?? ""),
    name: String(f.name ?? ""),
    state: String(f.state ?? ""),
    iterations: Number(f.iterations ?? 0),
    reports: Number(f.reports ?? 0),
    runs: Number(f.runs ?? 0),
  }));
}

/**
 * 判据本体（纯函数，两面的数据都进来之后才判）。
 *
 * 三种结局，只有第一种是绿：
 *   ok           —— 凭据认证出的 fleet_ref 在平台里存在，且那支舰队跑过至少一件事
 *   ghost        —— 平台里没有这支舰队（登记是字符串，实体不存在）
 *   dormant      —— 存在但零轮次（把空转从幽灵换成哑壳，同样是没接上）
 *   undetermined —— 输入不全（fleet_ref 为空、平台表为空）
 */
export function judge({ authenticatedFleetRef, fleets }) {
  const ref = String(authenticatedFleetRef || "").trim();
  if (!ref) {
    return { verdict: "undetermined", detail: "A 面没给出 fleet_ref（对端未按契约返回，或凭据不属于任何舰队）" };
  }
  if (!fleets.length) {
    return { verdict: "undetermined", detail: "B 面为空：平台 fleets 表没有任何行，先确认读到的是这个平台的库" };
  }
  const hit = fleets.find((f) => f.id === ref);
  if (!hit) {
    return {
      verdict: "ghost",
      detail: `凭据认证成 ${ref}，而平台 fleets 里没有这一行（现有：${fleets.map((f) => f.id).join(", ")}）`,
    };
  }
  if (hit.iterations === 0 && hit.reports === 0 && hit.runs === 0) {
    return {
      verdict: "dormant",
      detail: `${ref}（${hit.name}）在平台里存在，但 iterations/reports/runs 全 0 —— 它从没跑过一轮`,
    };
  }
  return {
    verdict: "ok",
    detail: `${ref}（${hit.name}）存在且跑过：iterations=${hit.iterations} reports=${hit.reports} runs=${hit.runs}`,
  };
}

const EXIT = { ok: 0, ghost: 1, dormant: 1, undetermined: 2 };

async function readFleetsJson(spec) {
  if (!spec) return null;
  if (spec === "-") return JSON.parse(readFileSync(0, "utf8"));
  return JSON.parse(readFileSync(spec, "utf8"));
}

async function selfTest() {
  // 两条绿/红路都要证：只证红的话，「判据写反」与「全程命中」长得一模一样。
  const cases = [
    { name: "绑定成立且有轮次", args: { authenticatedFleetRef: "f1", fleets: parseFleets([{ id: "f1", name: "A", iterations: 3 }]) }, want: 0 },
    { name: "幽灵舰队（真实产库形态）", args: { authenticatedFleetRef: "fleet_1700000000001_ghost1", fleets: parseFleets([{ id: "fleet_1700000000002_exist2", name: "工单分诊" }]) }, want: 1 },
    { name: "存在但零轮次", args: { authenticatedFleetRef: "f1", fleets: parseFleets([{ id: "f1", name: "A" }]) }, want: 1 },
    { name: "对端没给 fleet_ref", args: { authenticatedFleetRef: "", fleets: parseFleets([{ id: "f1" }]) }, want: 2 },
    { name: "平台表为空（读错库）", args: { authenticatedFleetRef: "f1", fleets: [] }, want: 2 },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = EXIT[judge(c.args).verdict];
    const ok = got === c.want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? "✓" : "✗"} ${c.name}: exit=${got}（期望 ${c.want}）`);
  }
  console.log(bad === 0 ? "\nself-test 全过" : `\nself-test ${bad} 项不符`);
  return bad === 0 ? 0 : 1;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.selfTest) return selfTest();

  const url = args.url || process.env[URL_ENV] || "";
  const domain = args.domain || process.env[DOMAIN_ENV] || "";
  const token = (process.env[args.tokenEnv] || "").trim();
  if (!url || !domain) {
    console.error(`判不出：缺 --url/--domain（或 ${URL_ENV}/${DOMAIN_ENV}）`);
    return 2;
  }
  if (!token) {
    console.error(`判不出：${args.tokenEnv} 为空——没有凭据就问不出「它被认证成哪支舰队」`);
    return 2;
  }
  let fleets;
  try {
    const raw = await readFleetsJson(args.fleetsJson);
    if (raw === null) {
      console.error("判不出：没给 --fleets-json（平台侧的舰队表）");
      return 2;
    }
    fleets = parseFleets(raw);
  } catch (err) {
    console.error(`判不出：读不了平台舰队表 —— ${err.message}`);
    return 2;
  }
  let authenticated;
  try {
    authenticated = await fetchAuthenticatedFleet({ url, domain, token });
  } catch (err) {
    console.error(`判不出：问不到知验台 —— ${err.message}`);
    return 2;
  }

  const { verdict, detail } = judge({ authenticatedFleetRef: authenticated.fleetRef, fleets });
  const mark = verdict === "ok" ? "✓" : verdict === "undetermined" ? "？" : "✗";
  console.log(`${mark} ${verdict}: ${detail}`);
  console.log(`  凭据侧 domain=${authenticated.domain} fleet_ref=${authenticated.fleetRef || "(空)"}`);
  const shown = fleets.filter((f) => f.id === authenticated.fleetRef || f.state !== "archived").slice(0, 8);
  const more = fleets.length - shown.length;
  console.log(
    `  实体侧 ${fleets.length} 支（非归档前 8）：${shown.map((f) => `${f.id}(it=${f.iterations})`).join(" ")}` +
      (more > 0 ? ` …另 ${more} 支` : ""),
  );
  return EXIT[verdict];
}

// 别写成 `endsWith("check-bench-fleet-binding.mjs")`：测试文件叫
// `test-check-bench-fleet-binding.mjs`，同样满足后缀 ⇒ 被 import 时它会当成脚本跑一遍
// （第一次就是这么红的：`node --test` 里冒出一条「缺 --url/--domain」）。只认同一份文件。
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`崩了（不是判据结论）：${err?.stack || err}`);
      process.exit(2);
    });
}
