// ── `check-bench-fleet-binding.mjs` 的守门测试 ──────────────────────────────
//
// 这道闸的判据只有一句话：「凭据被认证成的那支舰队，在平台里存在且不是哑壳」。
// 但它有两种容易写错的形态，两种都必须钉住：
//
//   1. **判据写反**（全绿或全红）——只看红证的话，「全程命中」与「判据写反」长得一模一样，
//      所以这里既证绿路也证红路。
//   2. **判不出被读成通过**——对端 500 / 返回 HTML / 平台表为空时必须是 exit 2，
//      不能退化成 0（一次网络故障被读成「绑定没问题」正是这道闸存在的理由）。
//
// 端到端那几条用本地 http 服务代替知验台，走真实进程、真实退出码。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchAuthenticatedFleet,
  judge,
  parseFleets,
} from "./check-bench-fleet-binding.mjs";

const SCRIPT = new URL("./check-bench-fleet-binding.mjs", import.meta.url).pathname;

// ── 判据本体 ────────────────────────────────────────────────────────────────

test("绑定成立且有轮次 → ok", () => {
  const fleets = parseFleets([{ id: "f1", name: "政策盯梢", iterations: 3 }]);
  const got = judge({ authenticatedFleetRef: "f1", fleets });
  assert.equal(got.verdict, "ok");
  assert.match(got.detail, /iterations=3/);
});

test("凭据认证出的舰队不在平台里 → ghost（2026-11-14 的真实形态）", () => {
  // 舰队 ID 用**同形状的合成值**（真值会随本文件进公开镜像仓，而它是生产实体的
  // 标识）；形状保持 `fleet_<13位毫秒>_<6位>`，断言因此仍然钉住真实形态。
  const fleets = parseFleets([
    { id: "fleet_1700000000003_other3", name: "政策盯梢集群·试跑" },
    { id: "fleet_1700000000002_exist2", name: "工单分诊集群·试跑" },
  ]);
  const got = judge({ authenticatedFleetRef: "fleet_1700000000001_ghost1", fleets });
  assert.equal(got.verdict, "ghost");
  // 报错必须点名「哪支找不到、现有哪几支」——否则排查要靠人再查一遍库。
  assert.match(got.detail, /fleet_1700000000001_ghost1/);
  assert.match(got.detail, /other3/);
});

test("舰队存在但零轮次 → dormant（把空转变哑壳，同样算没接上）", () => {
  const fleets = parseFleets([{ id: "f1", name: "A", state: "active" }]);
  const got = judge({ authenticatedFleetRef: "f1", fleets });
  assert.equal(got.verdict, "dormant");
  assert.match(got.detail, /从没跑过一轮/);
});

test("只要有一项非零就不算 dormant", () => {
  const fleets = parseFleets([{ id: "f1", name: "A", runs: 1 }]);
  assert.equal(judge({ authenticatedFleetRef: "f1", fleets }).verdict, "ok");
});

test("对端没给 fleet_ref → undetermined（不是 ok，也不是 ghost）", () => {
  const fleets = parseFleets([{ id: "f1", iterations: 9 }]);
  assert.equal(judge({ authenticatedFleetRef: "", fleets }).verdict, "undetermined");
  assert.equal(judge({ authenticatedFleetRef: "   ", fleets }).verdict, "undetermined");
});

test("平台表为空 → undetermined（读错库不许当绿）", () => {
  assert.equal(judge({ authenticatedFleetRef: "f1", fleets: [] }).verdict, "undetermined");
});

// ── 输入解析 ────────────────────────────────────────────────────────────────

test("parseFleets 认数组与 {fleets:[…]} 两种形状", () => {
  assert.equal(parseFleets([{ id: "a" }]).length, 1);
  assert.equal(parseFleets({ fleets: [{ id: "a" }, { id: "b" }] }).length, 2);
});

test("parseFleets 对没形状可言的输入报错（而不是静默给出空表）", () => {
  assert.throws(() => parseFleets({ rows: [] }), /必须是数组/);
  assert.throws(() => parseFleets("nope"), /必须是数组/);
});

// ── 凭据侧：只认 X-Consumer-Token ───────────────────────────────────────────

function fakeFetch({ status = 200, body = "{}", seen = [] } = {}) {
  return async (url, init) => {
    seen.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
}

test("只发 x-consumer-token，不发明细里的另一枚凭据（两套面不可互换）", async () => {
  const seen = [];
  await fetchAuthenticatedFleet({
    url: "https://bench.example/",
    domain: "ont legal",
    token: "lbc_demo",
    fetchImpl: fakeFetch({ body: JSON.stringify({ fleet_ref: "f1" }), seen }),
  });
  const headers = seen[0].init.headers;
  assert.equal(headers["x-consumer-token"], "lbc_demo");
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["x-api-key"], undefined);
  // domain 要 URL 编码，且尾部斜杠不能拼成 `//`
  assert.equal(seen[0].url, "https://bench.example/api/v1/distribution/ont%20legal/work-orders");
});

test("对端非 2xx 抛错并带上状态码（判不出，不是结论）", async () => {
  await assert.rejects(
    fetchAuthenticatedFleet({
      url: "https://bench.example",
      domain: "d",
      token: "t",
      fetchImpl: fakeFetch({ status: 401, body: JSON.stringify({ detail: "invalid consumer token" }) }),
    }),
    (err) => err.status === 401 && /invalid consumer token/.test(err.message),
  );
});

test("对端回 HTML（网关兜底页）时 detail 被截断，不当成 fleet_ref", async () => {
  await assert.rejects(
    fetchAuthenticatedFleet({
      url: "https://bench.example",
      domain: "d",
      token: "t",
      fetchImpl: fakeFetch({ status: 502, body: "<html>" + "x".repeat(5000) + "</html>" }),
    }),
    (err) => err.status === 502 && err.message.length < 300,
  );
});

// ── 端到端：真实进程 + 真实退出码 ───────────────────────────────────────────

async function runAgainst({ fleets, status = 200, body = "{}" }) {
  const seen = [];
  const server = createServer((req, res) => {
    // 顺手把真实进程打出去的 URL 记下来：路径拼错（漏 `/api/v1`、把 domain 拼错）
    // 在对端眼里也是 200/404，只断言 body 抓不到。
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const dir = mkdtempSync(join(tmpdir(), "fleet-binding-"));
  const file = join(dir, "fleets.json");
  writeFileSync(file, JSON.stringify(fleets));
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [SCRIPT, "--url", `http://127.0.0.1:${port}`, "--domain", "ontology", "--fleets-json", file],
        { env: { ...process.env, BENCH_FLEET_TOKEN: "lbc_test" }, stdio: "ignore" },
      );
      child.on("exit", resolve);
    });
    return { code, seen };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("端到端 · 绿路：exit 0（没有这条，全红与判据写反分不出来）", async () => {
  const { code, seen } = await runAgainst({
    fleets: [{ id: "f1", name: "A", iterations: 2 }],
    body: JSON.stringify({ fleet_ref: "f1", domain: "ontology" }),
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, ["GET /api/v1/distribution/ontology/work-orders"]);
});

test("端到端 · 幽灵舰队：exit 1", async () => {
  const { code } = await runAgainst({
    fleets: [{ id: "f_other", name: "B" }],
    body: JSON.stringify({ fleet_ref: "fleet_1700000000001_ghost1", domain: "ontology" }),
  });
  assert.equal(code, 1);
});

test("端到端 · 哑壳：exit 1", async () => {
  const { code } = await runAgainst({
    fleets: [{ id: "f1", name: "A" }],
    body: JSON.stringify({ fleet_ref: "f1", domain: "ontology" }),
  });
  assert.equal(code, 1);
});

test("端到端 · 知验台 500：exit 2（判不出不许退 0）", async () => {
  const { code } = await runAgainst({
    fleets: [{ id: "f1", iterations: 1 }],
    status: 500,
    body: JSON.stringify({ detail: "boom" }),
  });
  assert.equal(code, 2);
});

test("端到端 · 缺凭据：exit 2，且不发请求", async () => {
  const code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [SCRIPT, "--url", "http://127.0.0.1:1", "--domain", "d", "--fleets-json", "/dev/null"],
      { env: { ...process.env, BENCH_FLEET_TOKEN: "" }, stdio: "ignore" },
    );
    child.on("exit", resolve);
  });
  assert.equal(code, 2);
});

test("--self-test 自证通过", async () => {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--self-test"], { stdio: "ignore" });
    child.on("exit", resolve);
  });
  assert.equal(code, 0);
});
