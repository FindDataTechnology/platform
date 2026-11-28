#!/usr/bin/env node
// ── Seed one fleet's bench credential (the rollout's only production WRITE) ──
//
// fleet-scoped-bench-credentials 5.1: the seed must land in the SAME window as
// the image roll, and in that order — the old image does not create the
// `fleet_credentials` table at all, and between the roll and the seed the cell
// holds ZERO holders ⇒ bench rows are absent from every patch ⇒ the proposer's
// post silently loses the tool for that round. So this step is hand-run once,
// under time pressure, on a live pod. That is exactly the kind of step that
// must not be an ad-hoc `node -e` typed from memory.
//
// What it does, and why each part matters:
//   · writes through the APPLICATION's own module (getFleetDatabase /
//     setFleetCredential) — never hand-written DDL, never a direct INSERT. The
//     write path already refuses an unknown fleet (the 2026-11-14 ghost shape)
//     and an empty token, so this script cannot create a row nobody can resolve.
//   · the token comes from the pod's OWN environment by default
//     (`BENCH_FLEET_TOKEN`), so it never appears on a command line, in shell
//     history, or in a log. `--token-env` names a different variable;
//     `--token-stdin` reads one line from stdin for the rotate case.
//   · `--dry-run` answers "would this work" without writing: fleet exists?
//     store readable? holder count before/after?
//
// Usage (inside the cell pod, with PLATFORM_DATA_DIR already set for that cell):
//   node scripts/seed-fleet-credential.mjs --fleet fleet_1793422472811_i28xac --dry-run
//   node scripts/seed-fleet-credential.mjs --fleet fleet_1793422472811_i28xac
//   node scripts/seed-fleet-credential.mjs --fleet <id> --token-stdin  < /path/token
//
// Exit: 0 seeded (or dry-run OK) / 1 refused or verification failed / 2 undecidable
// **Undecidable is never success**: an unreadable store or an unparseable
// holder scope must not be reported as "nothing to do".

import { resolveFleetBenchCredential, benchHolderScope, CREDENTIAL_KINDS } from "../lib/fleet-credentials.js";

function parseArgs(argv) {
  const out = { fleet: "", kind: "bench", tokenEnv: "BENCH_FLEET_TOKEN", tokenStdin: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--fleet") out.fleet = String(argv[++i] ?? "").trim();
    else if (a === "--kind") out.kind = String(argv[++i] ?? "").trim();
    else if (a === "--token-env") out.tokenEnv = String(argv[++i] ?? "").trim();
    else if (a === "--token-stdin") out.tokenStdin = true;
    else if (a === "--dry-run") out.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

async function readToken(args) {
  if (args.tokenStdin) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return String(process.env[args.tokenEnv] ?? "").trim();
}

// One line per fact, so a pasted log tells the whole story without context.
function report(label, value) {
  console.log(`${label}: ${value}`);
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`判不出：${e.message}`);
    return 2;
  }
  if (!args.fleet) {
    console.error("判不出：缺 --fleet <fleetId>（种子必须点名舰队，不猜）");
    return 2;
  }
  if (!CREDENTIAL_KINDS.includes(args.kind)) {
    console.error(`判不出：kind="${args.kind}" 没有解析方（已知：${CREDENTIAL_KINDS.join(", ")}）`);
    return 2;
  }

  const token = await readToken(args);
  if (!token) {
    const where = args.tokenStdin ? "stdin" : `环境变量 ${args.tokenEnv}`;
    console.error(`判不出：${where} 里没有令牌（不写空值——空令牌会让行存在但谁也用不了）`);
    return 2;
  }

  // Store readability first: the two failure directions must not be confused —
  // "the store is not there yet" means the image has not rolled (wait), while
  // "the fleet is not there" means the wrong cell or a ghost id (stop).
  const scopeBefore = await benchHolderScope();
  if (scopeBefore.mode === "unknown") {
    console.error(`判不出：凭据存储读不到（${scopeBefore.error ?? "unknown"}）——镜像滚了吗？先确认这片里有 fleet_credentials 表`);
    return 2;
  }

  const resolved = await resolveFleetBenchCredential(args.fleet);
  if (resolved.status === "store_unavailable") {
    console.error(`判不出：${resolved.error ?? "store unavailable"}`);
    return 2;
  }
  if (resolved.status === "ghost") {
    // The ghost-fleet lesson, applied forward: an id that names no fleet in THIS
    // cell's db is either the wrong cell or a deleted fleet. Both warrant a stop.
    console.error(`拒绝：${args.fleet} 不在本 cell 的 fleets 名册里（核对 PLATFORM_DATA_DIR / cell，别在错的库里种）`);
    return 1;
  }

  report("fleet", args.fleet);
  report("kind", args.kind);
  report("token来源", args.tokenStdin ? "stdin" : args.tokenEnv);
  report("token尾部", token.slice(-4));
  report("写入前持有者", `${scopeBefore.mode}${scopeBefore.holders?.length ? ` (${scopeBefore.holders.join(", ")})` : ""}`);
  report("该舰队当前", resolved.status);

  if (args.dryRun) {
    console.log("dry-run：未写。上面的状态即「真跑会发生什么」的前置条件。");
    return 0;
  }

  const mod = await import("../server/routes/fleets-db.js");
  const db = mod.getFleetDatabase();
  const written = db.setFleetCredential({ fleetId: args.fleet, kind: args.kind, token });
  if (!written.ok) {
    console.error(`拒绝：写入被存储层拒绝（${written.reason}）`);
    return 1;
  }

  // Verify by reading back through the resolver the PATCH ASSEMBLER uses, not by
  // trusting the write's return value — the thing that matters is "the next
  // patch write will see this", and that is exactly what the resolver answers.
  const after = await resolveFleetBenchCredential(args.fleet);
  const scopeAfter = await benchHolderScope();
  report("写入后解析", `${after.status}${after.credential ? `（尾部 ${after.credential.token.slice(-4)}）` : ""}`);
  report("写入后持有者", `${scopeAfter.mode}${scopeAfter.holders?.length ? ` (${scopeAfter.holders.join(", ")})` : ""}`);
  if (after.status !== "ok" || after.credential?.token !== token) {
    console.error("失败：写完读回不一致 —— 不要继续滚动，先查这张表是不是被别的进程覆盖");
    return 1;
  }
  if (scopeAfter.mode === "multiple") {
    // Not a failure of THIS write, but the next reader must know the shared
    // patch will carry no bench rows (granted per member instead).
    console.log(`注意：本 cell 有 ${scopeAfter.holders.length} 支舰队持有 ${args.kind} 凭据 ⇒ 共享补丁不带 bench 行（按成员授予）`);
  }
  console.log("种子已落：下一步 `node scripts/check-fleet-credential-store.mjs --store-json -` 验收。");
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e?.stack || String(e));
    process.exit(2);
  });
