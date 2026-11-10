// close-supply-loop-interfaces 2.1 — instance report reporter contract pins.
// Fire-and-forget is the spec: failures never throw, the deployment path
// ignores the outcome, and the payload shape is the spine contract.
import { describe, expect, it, beforeEach } from "vitest";
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
    expect(p.entry.instance_id).toBe("d1");
    expect(p.entry.status).toBe("running");
    expect(p.entry.runner_id).toBe("r-9");
    expect(p.entry.source_pack_id).toBe("pK");
    expect(p.entry.source_pack_version).toBe(3);
    expect(p.entry.provenance).toEqual({
      reported_by: "paas-cell",
      seat: "seat-1",
      agent_path: "/agents/a",
      reported_at: "2026-11-07T00:00:00Z",
    });
  });

  it("maps enabled=false to stopped and tolerates missing fields", () => {
    const p = instancePayloadFromDeployment({ id: "d2", enabled: false });
    expect(p.entry.status).toBe("stopped");
    expect(p.entry.source_pack_id).toBeNull();
    expect(p.entry.provenance.seat).toBeNull();
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
    expect(out.ok).toBe(true);
    expect(seen.url).toBe("https://facet.test/api/supply-store/instances/upsert");
    expect(seen.init.headers.Authorization).toBe("Bearer wt-token");
    expect(JSON.parse(seen.init.body).actor).toBe("paas-instance-report");
    expect(reportStats.ok).toBe(1);
    expect(reportStats.failed).toBe(0);
  });

  it("never throws on HTTP failure — counts and degrades", async () => {
    const fetchImpl = async () => ({ ok: false, status: 503 });
    const out = await reportInstance({ id: "d1" }, { env: ENV, fetchImpl });
    expect(out).toEqual({ ok: false, code: "http_503" });
    expect(reportStats.failed).toBe(1);
    expect(reportStats.lastError).toContain("503");
  });

  it("never throws on unreachable spine", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const out = await reportInstance({ id: "d1" }, { env: ENV, fetchImpl });
    expect(out).toEqual({ ok: false, code: "unreachable" });
    expect(reportStats.failed).toBe(1);
  });

  it("degrades honestly when the channel is unconfigured", async () => {
    const out = await reportInstance({ id: "d1" }, { env: {}, fetchImpl: async () => { throw new Error("should not fetch"); } });
    expect(out).toEqual({ ok: false, code: "unconfigured" });
  });
});
