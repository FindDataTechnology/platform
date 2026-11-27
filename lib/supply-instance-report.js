// ── Instance report reporter (close-supply-loop-interfaces 2.1) ──────────────
//
// One-way instance-state registry: reads the local fleet deployment snapshot
// and upserts it into the spine supply-store instances family. Charter D4:
// 单向 + 出处 + 诚实降级 — this reporter is fire-and-forget by contract:
//   · every failure is logged and counted, NEVER thrown to the caller;
//   · the deployment write path calls this after success and ignores the
//     outcome (a spine outage must be invisible to users);
//   · no retry storm: the next deployment event re-reports; TTL (24h default)
//     expires stale rows naturally.
// The spine side has no path back into runtime: this module only POSTs.
import { randomUUID } from "node:crypto";

const REPORT_TIMEOUT_MS = 5_000;

export const reportStats = { ok: 0, failed: 0, lastError: null, lastReportedAt: null };

/**
 * Build the upsert payload for one deployment record.
 * Exported for tests — the shape is the contract (spec: fields + provenance).
 */
export function instancePayloadFromDeployment(dep, { seatId = null, reportedAt = null } = {}) {
  const ts = reportedAt ?? new Date().toISOString();
  return {
    entry: {
      instance_id: String(dep.id ?? dep.agentPath ?? `inst-${randomUUID()}`),
      status: String(dep.enabled === false ? "stopped" : "running"),
      runner_id: dep.runnerId ?? null,
      source_pack_id: dep.packId ?? null,
      source_pack_version: Number.isFinite(Number(dep.packVersion)) ? Number(dep.packVersion) : null,
      provenance: {
        reported_by: "paas-cell",
        seat: seatId,
        agent_path: dep.agentPath ?? null,
        reported_at: ts,
      },
    },
  };
}

/**
 * Report one deployment record to the spine instances gate. Fire-and-forget:
 * resolves { ok, code? } and never throws.
 */
export async function reportInstance(dep, { env = process.env, fetchImpl = fetch, seatId = null } = {}) {
  const base = String(env.SUPPLY_STORE_WRITE_URL || "").replace(/\/+$/, "");
  const token = String(env.SUPPLY_STORE_WRITE_TOKEN || "");
  if (!base || !token) {
    reportStats.failed += 1;
    reportStats.lastError = "supply-store write channel unconfigured";
    return { ok: false, code: "unconfigured" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  try {
    const { entry } = instancePayloadFromDeployment(dep, { seatId });
    const res = await fetchImpl(`${base}/api/supply-store/instances/upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "paas-instance-report", source: "facade", entry }),
      signal: controller.signal,
    });
    if (!res.ok) {
      reportStats.failed += 1;
      reportStats.lastError = `spine instances upsert → HTTP ${res.status}`;
      return { ok: false, code: `http_${res.status}` };
    }
    reportStats.ok += 1;
    reportStats.lastReportedAt = new Date().toISOString();
    return { ok: true };
  } catch (err) {
    reportStats.failed += 1;
    reportStats.lastError = err?.message || String(err);
    return { ok: false, code: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
