// ── 裁决路由键来自数据，不来自配置（fix-disclosure-gate-reachability D2 修订）──
//
// 背景：原设计让部署用 env 点名 owner。生产数据判掉了它——唯一的部署属主
// （ops-seed）没有 cell，在跑的真人 cell（aloadtree）又不属于它，填谁都错。
//
// 新做法：每个 cell 的 local feed 自报它是谁家的（`/api/agents` 回包里的 owner），
// runner 拉到名单时记住它，裁决时随请求带上。owner 于是是**数据**：
//   * 一个 runner 服务多个 cell 也不会串（每次拉到的是那一家的）；
//   * 解析不到就不带头 → 网关 400 → 失败关闭，绝不猜。
//
// 这里钉两件事：feed 会把 owner 报出来；runner 会记住并使用它（含"没有就不带"）。
//
// Run: node --test scripts/test-mandate-owner-from-feed.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

const { createLocalAgentFeed } = await import("../server/local-agent-feed.js");
const { createRegistryClient } = await import("../agent-runner/registry.js");

async function feedServer({ ownerEmail, agents = [] }) {
  const app = express();
  app.use("/local-registry", createLocalAgentFeed({ ownerEmail, runnerId: null }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { base: `http://127.0.0.1:${server.address().port}/local-registry`, server, agents };
}

test("feed: /api/agents 自报 owner（小写、去空白）；没有就报 null", async () => {
  const a = await feedServer({ ownerEmail: "Owner-A@Example.COM" });
  const b = await feedServer({ ownerEmail: null });
  try {
    const ra = await (await fetch(`${a.base}/api/agents?limit=5`)).json();
    assert.equal(ra.owner, "owner-a@example.com", "owner 归一化后才能当路由键");
    const rb = await (await fetch(`${b.base}/api/agents?limit=5`)).json();
    assert.equal(rb.owner, null, "不知道就说不知道，不要编一个");
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("registry client: 拉到名单后记住 feed 自报的 owner", async () => {
  const { base, server } = await feedServer({ ownerEmail: "owner-a@example.com" });
  try {
    const client = createRegistryClient({ registryUrl: base });
    assert.equal(client.feedOwner, null, "还没拉过名单时是 null");
    await client.listServedAgents();
    assert.equal(client.feedOwner, "owner-a@example.com");
  } finally {
    server.close();
  }
});

test("registry client: feed 不报 owner 时保持 null —— 上层据此不带 owner 头", async () => {
  const { base, server } = await feedServer({ ownerEmail: null });
  try {
    const client = createRegistryClient({ registryUrl: base });
    await client.listServedAgents();
    assert.equal(client.feedOwner, null);
  } finally {
    server.close();
  }
});

test("两个 cell 的 feed 各报各的，client 不会把 A 的 owner 带到 B", async () => {
  const a = await feedServer({ ownerEmail: "owner-a@example.com" });
  const b = await feedServer({ ownerEmail: "owner-b@example.com" });
  try {
    const ca = createRegistryClient({ registryUrl: a.base });
    const cb = createRegistryClient({ registryUrl: b.base });
    await ca.listServedAgents();
    await cb.listServedAgents();
    assert.equal(ca.feedOwner, "owner-a@example.com");
    assert.equal(cb.feedOwner, "owner-b@example.com");
  } finally {
    a.server.close();
    b.server.close();
  }
});
