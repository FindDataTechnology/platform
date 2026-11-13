// ── Landing a pack's process axis onto its memory root ─────────────────────
//
// Task 4.1/4.2 of add-pack-memory-declaration. `lib/pack-memory-policy.js`
// decides WHAT to write; this module performs the write, and it is deliberately
// the only place in paas that does.
//
// Three things are not obvious and each has bitten a similar feature before:
//
//  · **The token.** The document belongs to the pack's memory root (`d-<pack>`),
//    which is shared by every team landed from that pack — including teams of
//    other owners. Writing it with the platform token would work and would be
//    wrong: the platform token can reach any root, and a per-pack write should
//    only be able to reach its own. So a POD token is minted for exactly
//    `d/<pack>` (the same namespace agent-runner already mounts), which is the
//    narrowest credential that can do this job.
//
//  · **Clearing is not the same as writing an empty document.** In the memory
//    service an empty document IS the clear operation. So "the pack declares
//    nothing" must mean "leave the row alone", not "write {}" — otherwise a
//    pack that simply never declared a process axis would delete a sibling
//    team's policy the first time it lands.
//
//  · **Archive is a per-pack decision, not a per-team one.** The row is keyed by
//    pack. One owner archiving their team must not switch off distillation for
//    another owner's team on the same pack, so the row is cleared only when no
//    live fleet from that pack remains. (The spec's "团队归档 → 清理" was written
//    before we measured that the row's scope is the pack; this is the honest
//    reading of it.)
//
// Every failure is degrade-open: memory is a product surface, not a dependency
// of landing a team. A failed write logs and returns `ok:false` with a reason;
// callers must not fail the request because of it.

import { cellMemoryConfig } from "@finddatatechnology/yongyi-client";
import { compilePackMemoryPolicy, packMemoryRootKey } from "../lib/pack-memory-policy.js";

const WRITE_TIMEOUT_MS = 5000;

/** Per-process cache of `d/<pack>` pod tokens — one mint per root, like the runner. */
const tokenCache = new Map();

/** Test seam: forget cached tokens (a test that mints twice must be able to). */
export function resetPackMemoryTokenCache() {
  tokenCache.clear();
}

async function podTokenFor(cfg, rootKey, fetchImpl) {
  const cached = tokenCache.get(rootKey);
  if (cached) return cached;
  const namespace = rootKey.replace(/^d-/, "d/");
  const res = await fetchImpl(`${cfg.url}/admin/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.platformToken}` },
    body: JSON.stringify({ namespace, label: `policy:${rootKey}` }),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`mint HTTP ${res.status}`);
  const { token } = await res.json();
  if (!token) throw new Error("mint returned no token");
  tokenCache.set(rootKey, token);
  return token;
}

/**
 * Write (or clear) the policy row for one pack root.
 *
 * @param {object}   opts
 * @param {string}   opts.packId
 * @param {object}   [opts.manifest]      the installed pack manifest (declaration source)
 * @param {"land"|"archive"} opts.on      why we are syncing
 * @param {number}   [opts.liveFleets]    live teams from this pack AFTER the event
 * @returns {Promise<{ok: boolean, action: string, rootKey?: string, reason?: string, errors?: object[]}>}
 */
export async function syncPackMemoryPolicy({
  packId,
  manifest = null,
  on = "land",
  liveFleets = 1,
  env = process.env,
  fetchImpl = fetch,
  log = console,
} = {}) {
  const cfg = cellMemoryConfig(env);
  if (!cfg) return { ok: true, action: "skipped", reason: "memory_not_configured" };
  const rootKey = packMemoryRootKey(packId);
  if (!rootKey) return { ok: false, action: "skipped", reason: "pack_id_invalid" };

  const compiled = compilePackMemoryPolicy(manifest?.memory, { packId });
  if (!compiled.ok) {
    // A declaration that cannot compile should have been refused at publish, so
    // this is a stale/mis-stored manifest. Report it by name and change nothing:
    // writing a half-understood document into a shared root is worse than
    // leaving the previous one in force.
    return { ok: false, action: "refused", rootKey, reason: compiled.errors[0]?.code ?? "declaration_invalid", errors: compiled.errors };
  }

  // What this event means for the row.
  let mode;
  if (on === "archive" && liveFleets <= 0) mode = "clear";
  else if (!compiled.empty) mode = "write";
  else return { ok: true, action: "none", rootKey, reason: "pack_declares_no_process" };

  try {
    const token = await podTokenFor(cfg, rootKey, fetchImpl);
    const u = new URL(`${cfg.url}/policy`);
    u.searchParams.set("rootKey", rootKey);
    u.searchParams.set("scope", "root");
    const res = await fetchImpl(u, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // An empty process document is the CLEAR operation in the memory service.
      body: JSON.stringify({ process: mode === "clear" ? {} : compiled.doc }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`policy PUT HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, action: body?.cleared ? "cleared" : mode === "clear" ? "cleared" : "written", rootKey, doc: mode === "clear" ? {} : compiled.doc };
  } catch (err) {
    // Degrade open, loudly: landing a team must never fail because memory is
    // unreachable, but the reason has to be readable afterwards.
    log.warn?.(`[pack-memory-policy] ${rootKey}: ${err?.message ?? err}`);
    return { ok: false, action: "failed", rootKey, reason: String(err?.message ?? err) };
  }
}

/**
 * Re-assert on landing, i.e. the common case: a pack just became a team.
 * Kept separate so the call site reads as intent rather than as options.
 */
export function landPackMemoryPolicy({ packId, manifest, liveFleets = 1, ...rest } = {}) {
  return syncPackMemoryPolicy({ packId, manifest, on: "land", liveFleets, ...rest });
}

/**
 * Sync after a team left the rotation (archived / source pack uninstalled).
 *
 * Callers MUST pass the live count measured AFTER the change; passing 1
 * unconditionally is how one owner's archive would silently switch off another
 * owner's team on the same pack.
 */
export function releasePackMemoryPolicy({ packId, manifest = null, liveFleets, ...rest } = {}) {
  return syncPackMemoryPolicy({ packId, manifest, on: "archive", liveFleets, ...rest });
}
