#!/usr/bin/env node
// ── 「只有一支舰队能做 bench 提案」这条前提，做成判据 ────────────────────────
//
// change `bind-bench-proposal-identity-to-credential` 的 design D2/③ 与 task 5.1。
//
// 为什么需要它：`BENCH_FLEET_TOKEN` 是**平台进程级**环境变量（`dsh-profile.js` 的
// `envRefs` 解析是 `scopedEnv?.[ref] ?? process.env[ref]`，而 `scopedEnv` 只覆盖 `SEARCH_*`）。
// 一旦切到机器面，身份就由令牌**派生**——若两支舰队同时挂 `bench-proposal` 而共用同一枚
// 令牌，第二支会以第一支的名义落提案，而且服务端还会把 `source` 强制成那支：
// **比自述身份更隐蔽的一致错误**。所以「同一时刻至多一份 pack 声明该面」必须是判据，
// 不能只写在 design.md 或岗位提示词里。
//
// 两条判据：
//   J1 声明面唯一：声明 `--server`（缺省 bench-proposal,bench-ops）的 pack 集合大小 ≤ 1。
//   J2 令牌 ↔ 声明方一致：用 `BENCH_FLEET_TOKEN` 问机器面「我被认证成哪支舰队」，
//      该 fleet_ref 必须出现在**声明方的舰队集合**里（由 `--fleets-json` 提供：
//      cell 库的 fleets 行，带 source_template.packId）。
//
// 退出码：0 通过 / 1 命中 / 2 判不出。**判不出不许当通过**——读不到快照、读不到舰队表、
// 没有令牌、对端不可达，都退 2；一次网络故障被读成「前提仍成立」，正是这道闸存在的理由。
//
// 用法（线上）：
//   kubectl -n fd-prod exec deploy/platform -c platform -- node -e '…导出 fleets json…' \
//     | BENCH_FLEET_TOKEN=… node scripts/check-bench-proposal-declaration.mjs --fleets-json -
//   node scripts/check-bench-proposal-declaration.mjs --self-test
//   node scripts/check-bench-proposal-declaration.mjs --no-live        # 只判 J1（离线）
//
// 写这个脚本踩到的坑（留在这里，别再踩）：`argparse` 那类是 Python 的事；这里第 1 版
// 把 `mcpServers` 的元素当成字符串，而快照里是 `{registryName, allowTools}` ⇒
// 十份 pack 全被判成「没声明」，闸永远绿。**两种形状都要认**，并且要有用例钉住。

import { readFileSync } from "node:fs";

const DEFAULT_SERVERS = ["bench-proposal", "bench-ops"];
const DEFAULT_SNAPSHOT = "docs/fleet-templates/staging/source-snapshot.json";

function parseArgs(argv) {
  const out = {
    snapshot: null,
    fleetsJson: null,
    servers: [],
    url: null,
    domain: null,
    live: true,
    selfTest: false,
    assumeFleetRef: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--self-test") out.selfTest = true;
    else if (a === "--no-live") out.live = false;
    else if (a === "--snapshot") out.snapshot = argv[++i];
    else if (a === "--fleets-json") out.fleetsJson = argv[++i];
    else if (a === "--server") out.servers.push(argv[++i]);
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--domain") out.domain = argv[++i];
    else if (a === "--assume-fleet-ref") out.assumeFleetRef = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
  }
  if (!out.servers.length) out.servers = [...DEFAULT_SERVERS];
  if (!out.snapshot) out.snapshot = DEFAULT_SNAPSHOT;
  return out;
}

/**
 * 每份 pack 声明了哪些 mcp 面。
 *
 * 快照里 `mcpServers` 的元素是 `{registryName, allowTools}`；老快照/手写夹具里是裸字符串。
 * 两种都认——只认一种会让「没声明」与「形状变了」长得一模一样。
 */
export function serverNames(pack) {
  const list = pack?.mcpServers;
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => (typeof s === "string" ? s : s?.registryName ?? s?.name ?? ""))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

/** 声明了任一目标面的 pack（返回 packId → 命中的面名）。 */
export function declaringPacks(snapshot, servers) {
  const wanted = new Set(servers);
  const hits = {};
  for (const [packId, pack] of Object.entries(snapshot || {})) {
    const declared = serverNames(pack).filter((n) => wanted.has(n));
    if (declared.length) hits[packId] = declared;
  }
  return hits;
}

/**
 * 舰队行的 packId（`source_template` 是 JSON 文本，可能是 null）。
 * 解析不出就返回 null —— 由调用方当「判不出」，不当成「没关联」。
 */
export function packIdOf(fleetRow) {
  // 直给的 packId 列是**裸 id**，不是 JSON 文本——别喂给 JSON.parse（`"P3"` 会抛，
  // 然后整行被判成「解析不出」，而那恰好是 J2 的「判不出」，看起来像「舰队无关」）。
  const direct = fleetRow?.packId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (direct && typeof direct === "object" && direct.packId) return String(direct.packId);

  const raw = fleetRow?.source_template ?? null;
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "object") return raw.packId ? String(raw.packId) : null;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && parsed.packId ? String(parsed.packId) : null;
  } catch {
    return null;
  }
}

/**
 * 判据本体（纯函数）。
 * @returns {findings: string[], undecided: string[]}
 */
export function judge({ snapshot, fleets, servers, authenticatedFleetRef = null }) {
  const findings = [];
  const undecided = [];

  if (!snapshot || typeof snapshot !== "object" || !Object.keys(snapshot).length) {
    return { findings, undecided: ["读不到 pack 声明快照（0 份 pack）—— J1 判不出"] };
  }

  const declaring = declaringPacks(snapshot, servers);
  const packIds = Object.keys(declaring);

  // J1：声明面唯一
  if (packIds.length > 1) {
    findings.push(
      `J1 命中：${packIds.length} 份 pack 都声明了 [${servers.join(", ")}] —— ` +
        packIds.map((p) => `${p}(${declaring[p].join("/")})`).join("、") +
        "。共用一枚 BENCH_FLEET_TOKEN 时，第二支舰队会以第一支的名义落提案（而且服务端会把 " +
        "source 强制成那支，比自述更隐蔽）。要么给每支舰队各自的令牌（design D2 ①/②），" +
        "要么确认多出来的那份不该挂这个面。",
    );
  }

  // J2：令牌 ↔ 声明方一致
  if (!fleets) {
    undecided.push("没有舰队表（--fleets-json）—— J2 判不出");
    return { findings, undecided };
  }
  if (!packIds.length) {
    // 没有任何 pack 声明该面：J2 无从谈起，但这是事实，要说出来（可能是刚从 pack 里摘掉）。
    undecided.push(
      `没有 pack 声明 [${servers.join(", ")}] —— 若这是有意的（面已摘除），说明令牌也该退役；` +
        "若是无意的，J1 现在是空集合，别把空集合读成「唯一」",
    );
    return { findings, undecided };
  }

  const owners = fleets.filter((f) => {
    const p = packIdOf(f);
    return p !== null && Object.hasOwn(declaring, p);
  });
  if (!owners.length) {
    undecided.push(
      `声明方 pack（${packIds.join(", ")}）在舰队表里没有任何对应舰队 —— J2 判不出` +
        "（可能舰队在另一个 cell 的库里，或声明方只是模具从未建队）",
    );
    return { findings, undecided };
  }

  if (!authenticatedFleetRef) {
    undecided.push("没有 BENCH_FLEET_TOKEN（或未问对端）—— J2 判不出");
    return { findings, undecided };
  }

  const ownerIds = new Set(owners.map((f) => String(f.id ?? "")));
  if (!ownerIds.has(String(authenticatedFleetRef))) {
    findings.push(
      `J2 命中：令牌认证成 ${authenticatedFleetRef}，而声明 ${servers.join("/")} 的 pack 属于 ` +
        `${[...ownerIds].join(", ")} —— 这枚令牌代表不了挂该面的舰队。` +
        "后果不是「不能用」而是「用错身份」：提案会以它自称的舰队落库，而 `submitted_by` 也由它派生。",
    );
  }
  return { findings, undecided };
}

/** 用机器面问「这枚令牌被认证成哪支舰队」（只读 GET）。 */
export async function fetchAuthenticatedFleet({ url, domain, token, fetchImpl = fetch }) {
  const target = `${String(url).replace(/\/+$/, "")}/api/v1/distribution/${encodeURIComponent(
    domain,
  )}/work-orders`;
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
  return String(body.fleet_ref ?? "");
}

async function selfTest() {
  const servers = ["bench-proposal"];
  const snap = (ids) => {
    const out = {};
    for (const id of ids) {
      out[id] = { name: id, mcpServers: [{ registryName: "wire-ops", allowTools: [] }] };
    }
    if (ids[0]) out[ids[0]].mcpServers.push({ registryName: "bench-proposal", allowTools: [] });
    return out;
  };
  const fleet = (id, packId) => ({ id, source_template: JSON.stringify({ packId, version: 1 }) });

  const cases = [
    {
      name: "绿：唯一声明方 + 令牌就是它",
      args: {
        snapshot: snap(["P1"]),
        fleets: [fleet("f1", "P1")],
        servers,
        authenticatedFleetRef: "f1",
      },
      want: { f: 0, u: 0 },
    },
    {
      name: "红 J2：令牌是另一支舰队",
      args: {
        snapshot: snap(["P1"]),
        fleets: [fleet("f1", "P1"), fleet("f2", "OTHER")],
        servers,
        authenticatedFleetRef: "f2",
      },
      want: { f: 1, u: 0 },
    },
    {
      name: "红 J1：两份 pack 都声明（无令牌作用域时的致命形态）",
      args: (() => {
        const s = snap(["P1"]);
        s.P2 = { name: "P2", mcpServers: [{ registryName: "bench-proposal" }] };
        return { snapshot: s, fleets: [fleet("f1", "P1")], servers, authenticatedFleetRef: "f1" };
      })(),
      want: { f: 1, u: 0 },
    },
    {
      name: "判不出：没有舰队表",
      args: { snapshot: snap(["P1"]), fleets: null, servers, authenticatedFleetRef: "f1" },
      want: { f: 0, u: 1 },
    },
    {
      name: "判不出：快照为空（读错文件不许当绿）",
      args: { snapshot: {}, fleets: [fleet("f1", "P1")], servers, authenticatedFleetRef: "f1" },
      want: { f: 0, u: 1 },
    },
    {
      name: "判不出：声明方 pack 没有对应舰队",
      args: { snapshot: snap(["P9"]), fleets: [fleet("f1", "P1")], servers, authenticatedFleetRef: "f1" },
      want: { f: 0, u: 1 },
    },
    {
      name: "判不出：没有令牌",
      args: { snapshot: snap(["P1"]), fleets: [fleet("f1", "P1")], servers, authenticatedFleetRef: null },
      want: { f: 0, u: 1 },
    },
  ];

  let bad = 0;
  for (const c of cases) {
    const { findings, undecided } = judge(c.args);
    const ok = findings.length === c.want.f && undecided.length === c.want.u;
    if (!ok) bad += 1;
    console.log(
      `  ${ok ? "✓" : "✗"} ${c.name}: findings=${findings.length}(期望 ${c.want.f}) ` +
        `undecided=${undecided.length}(期望 ${c.want.u})`,
    );
  }

  // 形状兼容：裸字符串与 {registryName} 都要认（第 1 版只认后者，十份 pack 全被判「没声明」）
  const bare = { P1: { mcpServers: ["bench-proposal"] } };
  const obj = { P1: { mcpServers: [{ registryName: "bench-proposal" }] } };
  const shapeOk =
    JSON.stringify(declaringPacks(bare, servers)) === JSON.stringify(declaringPacks(obj, servers)) &&
    Object.keys(declaringPacks(bare, servers)).length === 1;
  if (!shapeOk) bad += 1;
  console.log(`  ${shapeOk ? "✓" : "✗"} 形状兼容：裸字符串与 {registryName} 等价`);

  console.log(bad === 0 ? "\nself-test 全过" : `\nself-test ${bad} 项不符`);
  return bad === 0 ? 0 : 1;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.selfTest) return selfTest();

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(args.snapshot, "utf8"));
  } catch (err) {
    console.error(`判不出：读不到 pack 声明快照 ${args.snapshot} —— ${err.message}`);
    return 2;
  }

  let fleets = null;
  if (args.fleetsJson) {
    try {
      const raw = args.fleetsJson === "-"
        ? JSON.parse(readFileSync(0, "utf8"))
        : JSON.parse(readFileSync(args.fleetsJson, "utf8"));
      fleets = Array.isArray(raw) ? raw : Array.isArray(raw?.fleets) ? raw.fleets : null;
      if (!fleets) throw new Error("必须是数组或 {fleets:[…]}");
    } catch (err) {
      console.error(`判不出：读不了舰队表 —— ${err.message}`);
      return 2;
    }
  }

  let authenticatedFleetRef = args.assumeFleetRef || null;
  if (args.assumeFleetRef) {
    // 自证通道：拿一次真实令牌问出来的值注进来，用来验「绿档」与「红 J2」两条判据本身。
    console.log(`  （--assume-fleet-ref ${args.assumeFleetRef}：这是注入值，不是本机现问对端）`);
  }
  if (args.live && fleets && !authenticatedFleetRef) {
    const url = args.url || process.env.BENCH_URL || "";
    const domain = args.domain || process.env.BENCH_PROPOSAL_DOMAIN || "";
    const token = (process.env.BENCH_FLEET_TOKEN || "").trim();
    if (!url || !domain || !token) {
      console.error("判不出：缺 BENCH_URL / BENCH_PROPOSAL_DOMAIN / BENCH_FLEET_TOKEN —— J2 问不到对端");
      return 2;
    }
    try {
      authenticatedFleetRef = await fetchAuthenticatedFleet({ url, domain, token });
    } catch (err) {
      console.error(`判不出：问不到知验台 —— ${err.message}`);
      return 2;
    }
  }

  const { findings, undecided } = judge({
    snapshot,
    fleets,
    servers: args.servers,
    authenticatedFleetRef,
  });
  for (const line of undecided) console.log(`  ？ ${line}`);
  for (const line of findings) console.log(`  ✗ ${line}`);
  console.log(
    `\n${Object.keys(snapshot).length} 份 pack / 目标面 [${args.servers.join(", ")}] / ` +
      `命中 ${findings.length} / 判不出 ${undecided.length}`,
  );
  if (findings.length) return 1;
  if (undecided.length) return 2;
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`崩了（不是判据结论）：${err?.stack || err}`);
      process.exit(2);
    });
}
