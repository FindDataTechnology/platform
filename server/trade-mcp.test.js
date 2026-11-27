// 交易台 MCP：谁能当委托人。
//
// 这是「替谁花钱」的边界：写错不会有报错，只会让一笔订单挂到错误的人名下。
// 一份 mcp.json 服务一个 cell，所以部署级 TRADE_ACTOR 不能当默认值 ——
// 那样所有用户都会以自己的名义替第一个用户花钱。

import test from "node:test";
import assert from "node:assert/strict";
import { actorFromEnv } from "./trade-mcp.js";

test("优先用部署级 TRADE_ACTOR", () => {
  assert.equal(actorFromEnv({ TRADE_ACTOR: "ops@x", CELL_USER_EMAIL: "u@x" }), "ops@x");
});

test("没有 TRADE_ACTOR 时回落 cell 自己的用户", () => {
  assert.equal(actorFromEnv({ CELL_USER_EMAIL: "u@x" }), "u@x");
});

test("两个都没有就是空串（调用方据此不出票，而不是随便挑一个）", () => {
  assert.equal(actorFromEnv({}), "");
});

test("空白值当没有", () => {
  assert.equal(actorFromEnv({ TRADE_ACTOR: "   ", CELL_USER_EMAIL: "u@x" }), "u@x");
});

test("explain 不再输出 undefined: undefined", async () => {
  const { explainForTest } = await import("./trade-mcp.js");
  // 上游返回了 error 壳但字段缺失（旧实现会拼出 "undefined: undefined"）
  assert.match(explainForTest({ status: 401, data: { error: {} } }), /upstream 401/);
  assert.doesNotMatch(explainForTest({ status: 401, data: { error: {} } }), /undefined: undefined/);
  // 正常错误码仍然照常展开
  const ok = explainForTest({ status: 422, data: { error: { code: "BUDGET_EXHAUSTED", message: "超了", detail: { limit: "50" } } } });
  assert.match(ok, /BUDGET_EXHAUSTED: 超了/);
  assert.match(ok, /limit/);
});

test("目录地址优先取 K8s 注入的 SERVICE_HOST（不受 mcp.json 陈旧影响）", async () => {
  const { directoryBaseForTest } = await import("./trade-mcp.js");
  // K8s 注入存在 ⇒ 用它，忽略可能过期的 SHOP_DIRECTORY_URL
  assert.equal(
    directoryBaseForTest({
      FD_SHOP_DIRECTORY_SERVICE_HOST: "10.43.149.64",
      FD_SHOP_DIRECTORY_SERVICE_PORT: "80",
      SHOP_DIRECTORY_URL: "http://stale.svc.cluster.local",
    }),
    "http://10.43.149.64:80",
  );
  // 没有 K8s 注入（本地 dev）⇒ 用显式配置
  assert.equal(
    directoryBaseForTest({ SHOP_DIRECTORY_URL: "http://127.0.0.1:8099" }),
    "http://127.0.0.1:8099",
  );
});
