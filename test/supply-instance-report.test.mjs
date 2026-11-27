// close-supply-loop-interfaces 2.1 — instance report reporter contract pins.
// Fire-and-forget is the spec: failures never throw, the deployment path
// ignores the outcome, and the payload shape is the spine contract.
//
// 本文件出生时按 vitest 语法写（import from "vitest"），但仓里没有任何包声明
// vitest、也没有任何车道跑它 ⇒ 从出生起一次都没执行过（2026-11-15 孤儿测试
// 审计实测：node --test 一跑即炸在 @vitest/runner）。按仓内惯例（memory-dashboard
// 头注自陈「无 vitest/testing-library」）改为 node:test + assert/strict。语义
// 逐一对应：toBe ⇒ assert.equal（assert/strict 下即 Object.is 语义的 strict
// equal 对标量成立）、toEqual ⇒ assert.deepEqual（strict 模式）、toContain ⇒
// assert.match。
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { instancePayloadFromDeployment, reportInstance, reportStats } from "../lib/supply-instance-report.js";

const ENV = {
  SUPPLY_STORE_WRITE_URL: "https://facet.test",
  SUPPLY_STORE_WRITE_TOKEN: "wt-token",
};

describe("instancePayloadFromDeployment", () => {
  it("carries the contract fields and provenance", () => {
    const p = instancePayloadFromDeployment(
      { id: "d1", agentPath: "/agents/a", enabled: true, runnerId: "r-9", packId: "pK", packVersion: 3 },
      { seatId: "seat-1", reportedAt: "2026-11-07T00:00:00Z" },
    );
    assert.equal(p.entry.instance_id, "d1");
    assert.equal(p.entry.status, "running");
    assert.equal(p.entry.runner_id, "r-9");
    assert.equal(p.entry.source_pack_id, "pK");
    assert.equal(p.entry.source_pack_version, 3);
    assert.deepEqual(p.entry.provenance, {
      reported_by: "paas-cell",
      seat: "seat-1",
      agent_path: "/agents/a",
      reported_at: "2026-11-07T00:00:00Z",
    });
  });

  it("maps enabled=false to stopped and tolerates missing fields", () => {
    const p = instancePayloadFromDeployment({ id: "d2", enabled: false });
    assert.equal(p.entry.status, "stopped");
    assert.equal(p.entry.source_pack_id, null);
    assert.equal(p.entry.provenance.seat, null);
  });
});

describe("reportInstance", () => {
  beforeEach(() => {
    reportStats.ok = 0;
    reportStats.failed = 0;
    reportStats.lastError = null;
  });

  it("upserts through the write gate and counts ok", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200 };
    };
    const out = await reportInstance({ id: "d1" }, { env: ENV, fetchImpl, seatId: "s" });
    assert.equal(out.ok, true);
    assert.equal(seen.url, "https://facet.test/api/supply-store/instances/upsert");
    assert.equal(seen.init.headers.Authorization, "Bearer wt-token");
    assert.equal(JSON.parse(seen.init.body).actor, "paas-instance-report");
    assert.equal(reportStats.ok, 1);
    assert.equal(reportStats.failed, 0);
  });

  it("never throws on HTTP failure — counts and degrades", async () => {
    const fetchImpl = async () => ({ ok: false, status: 503 });
    const out = await reportInstance({ id: "d1" }, { env: ENV, fetchImpl });
    assert.deepEqual(out, { ok: false, code: "http_503" });
    assert.equal(reportStats.failed, 1);
    assert.match(reportStats.lastError, /503/);
  });

  it("never throws on unreachable spine", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const out = await reportInstance({ id: "d1" }, { env: ENV, fetchImpl });
    assert.deepEqual(out, { ok: false, code: "unreachable" });
    assert.equal(reportStats.failed, 1);
  });

  it("degrades honestly when the channel is unconfigured", async () => {
    const out = await reportInstance({ id: "d1" }, { env: {}, fetchImpl: async () => { throw new Error("should not fetch"); } });
    assert.deepEqual(out, { ok: false, code: "unconfigured" });
  });
});
