// 生产构造驱动：把 CORPUS 的真场景灌进生产，逐条走
// 创建 → 校验 → 批准 → 铸造 → 试跑 → 签字 → 再铸（reseal）。
//
//   BASE=http://127.0.0.1:13100 COOKIE_FILE=/tmp/paas_cookie.txt \
//     node scripts/blueprint-corpus-seed.mjs [--dry] [nameFilter]
//
// 纪律：
//   · 坏例只跑到「校验」这一步，验证生产侧闸也如实指名（不创建实体）。
//   · 报告落 /tmp/blueprint-seed-report.json，逐条记每一步的 HTTP 状态与要点。
//   · 幂等：同名蓝图已存在则复用（不重复建），便于迭代时重放。
import { readFileSync, writeFileSync } from "node:fs";
import { CORPUS } from "./blueprint-corpus.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:13100";
const COOKIE = readFileSync(process.env.COOKIE_FILE || "/tmp/paas_cookie.txt", "utf8").trim();
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const filter = argv.find((a) => !a.startsWith("--"));

const report = { startedAt: new Date().toISOString(), base: BASE, cases: [] };

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: `paas_session=${COOKIE}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body: json };
}

function log(mark, msg) {
  console.log(`${mark} ${msg}`);
}

async function findByName(name) {
  const list = await api("GET", "/api/blueprints");
  return (list.body?.blueprints ?? []).find((b) => b.name === name) ?? null;
}

for (const c of CORPUS) {
  if (filter && !c.name.includes(filter)) continue;
  const row = { name: c.name, expect: c.expect, steps: [] };
  report.cases.push(row);
  console.log(`\n── ${c.name} (${c.expect}) ──────────────────────────`);

  if (c.expect === "invalid") {
    // 坏例：生产侧校验必须指名拒绝，且不得创建实体。用一个临时蓝图来跑
    // /validate 太重——直接用创建 + validate：先在本地确认形状，这里只验
    // 「生产 API 的 validate 会指名字段」。
    const existing = await findByName(c.name);
    if (existing) {
      const v = await api("POST", `/api/blueprints/${existing.id}/validate`);
      row.steps.push({ step: "validate", status: v.status, ok: v.body?.ok, errors: v.body?.errors });
      log(v.body?.ok === false ? "✓" : "✗", `生产校验 ok=${v.body?.ok}，${(v.body?.errors ?? []).length} 条`);
      for (const e of (v.body?.errors ?? []).slice(0, 3)) console.log(`    · ${e.entry ?? "?"} :: ${String(e.error).split("\n")[0]}`);
    } else {
      // 坏例不建实体，只报出「本地已拦」这一事实（生产同一函数）。
      row.steps.push({ step: "skipped", reason: "bad case — not created in production" });
      log("·", "坏例不在生产建实体（同一校验函数已在本地证明拦截）");
    }
    continue;
  }

  if (dry) {
    log("·", "dry — 跳过写入");
    continue;
  }

  // 1. 创建（幂等）
  let bp = await findByName(c.name);
  if (bp) {
    log("·", `已存在 ${bp.id}（status=${bp.status} v${bp.version}）——复用`);
    row.steps.push({ step: "create", status: "reused", id: bp.id });
  } else {
    const created = await api("POST", "/api/blueprints", {
      name: c.name,
      content: c.content,
      oneLine: c.content.boundary?.oneLine,
      outOfScope: c.content.boundary?.outOfScope,
    });
    row.steps.push({ step: "create", status: created.status, id: created.body?.blueprint?.id });
    if (created.status !== 201) {
      log("✗", `创建失败 HTTP ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
      continue;
    }
    bp = created.body.blueprint;
    log("✓", `创建 ${bp.id}`);
  }

  // 2. 校验
  const v = await api("POST", `/api/blueprints/${bp.id}/validate`);
  row.steps.push({ step: "validate", status: v.status, ok: v.body?.ok, errorCount: (v.body?.errors ?? []).length });
  if (!v.body?.ok) {
    log("✗", `校验不过（${(v.body?.errors ?? []).length} 条）：`);
    for (const e of (v.body?.errors ?? []).slice(0, 5)) console.log(`    · ${e.entry ?? "?"} :: ${String(e.error).split("\n")[0]}`);
    continue;
  }
  log("✓", "校验全绿");

  // 3. 批准
  if (bp.status === "draft") {
    const ap = await api("POST", `/api/blueprints/${bp.id}/approve`, { expectVersion: bp.version });
    row.steps.push({ step: "approve", status: ap.status });
    if (ap.status !== 200) {
      log("✗", `批准失败 HTTP ${ap.status}: ${JSON.stringify(ap.body).slice(0, 300)}`);
      continue;
    }
    bp = ap.body.blueprint;
    log("✓", `批准 v${bp.version}`);
  } else {
    log("·", `已是 ${bp.status}，跳过批准`);
  }

  // 4. 铸造
  if (bp.status !== "cast") {
    const cast = await api("POST", `/api/blueprints/${bp.id}/cast`);
    row.steps.push({ step: "cast", status: cast.status, packId: cast.body?.cast?.packId });
    if (cast.status !== 200) {
      log("✗", `铸造失败 HTTP ${cast.status}: ${JSON.stringify(cast.body).slice(0, 400)}`);
      continue;
    }
    bp = cast.body.blueprint;
    log("✓", `铸造 packId=${cast.body.cast.packId}`);
  } else {
    log("·", `已铸造 packId=${bp.castPackId}`);
  }

  // 5. 试跑
  const trial = await api("POST", `/api/blueprints/${bp.id}/trial`);
  row.steps.push({ step: "trial", status: trial.status, green: trial.body?.report?.green, errors: trial.body?.report?.errors });
  if (trial.status !== 200) {
    log("✗", `试跑失败 HTTP ${trial.status}: ${JSON.stringify(trial.body).slice(0, 400)}`);
    continue;
  }
  const rep = trial.body.report;
  bp = trial.body.blueprint;
  log(rep.green ? "✓" : "✗", `试跑 green=${rep.green}（${(rep.assertions ?? []).length} 条断言）`);
  for (const a of rep.assertions ?? []) {
    console.log(`    ${a.pass ? "✓" : "✗"} ${a.id} [${a.kind}] ${a.detail ?? ""}`);
  }
  if ((rep.errors ?? []).length) console.log(`    errors=${JSON.stringify(rep.errors)}`);

  // 6. 签字（绿才签）
  if (rep.green) {
    const sg = await api("POST", `/api/blueprints/${bp.id}/trial-signoff`);
    row.steps.push({ step: "signoff", status: sg.status });
    if (sg.status === 200) log("✓", "报告已签字");
    else log("✗", `签字失败 HTTP ${sg.status}: ${JSON.stringify(sg.body).slice(0, 300)}`);

    // 7. 再铸（reseal）：让市场里那份 manifest 带上「绿+判决+签字」
    const reseal = await api("POST", `/api/blueprints/${bp.id}/cast`);
    row.steps.push({ step: "reseal", status: reseal.status, packId: reseal.body?.cast?.packId });
    if (reseal.status === 200) log("✓", `再铸 v${reseal.body.cast.version}（manifest 带试跑报告位）`);
    else log("✗", `再铸失败 HTTP ${reseal.status}: ${JSON.stringify(reseal.body).slice(0, 400)}`);
  }
}

writeFileSync("/tmp/blueprint-seed-report.json", JSON.stringify(report, null, 2));
console.log("\n报告已落 /tmp/blueprint-seed-report.json");
