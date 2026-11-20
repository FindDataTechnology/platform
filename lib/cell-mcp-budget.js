// ── Cell MCP budget (enable-constructor-skill-authoring / D8 ④ 容量面) ──────
//
// Why this exists: a cell's dsh child initialises its MCP servers SERIALLY and
// with a hard 60s budget. Nothing caps how many a cell may accumulate, and the
// only symptom when the budget is blown is:
//
//   /api/ready → {"ready":false,"dshInitError":"initialize timed out after 60000ms …"}
//   every fleet turn → error_kind "runtime_not_ready"
//
// Live evidence 2026-11-08: the owner cell had 41 packs installed → 32 MCP
// servers → init timed out → the WHOLE cell was unreachable and every fleet's
// rounds were skipped, with nothing anywhere pointing at "too many servers".
// The healthy comparison cell carried 15. Diagnosis took hours because the
// failure message names the timeout, not the cause.
//
// So the install face gets a budget: project the union of MCP server names the
// cell would carry after this install, and warn (soft) or refuse (hard) with a
// message that names the real cause.
//
// Pure arithmetic over manifests already in hand — no db, no IO, no caching, so
// it is trivially testable and cannot itself become a source of drift.

export const DEFAULT_MCP_SOFT_LIMIT = 22;
export const DEFAULT_MCP_HARD_LIMIT = 30;

/** Every distinct `registryName` a manifest declares. Shape-tolerant. */
export function mcpNamesOf(manifest) {
  const out = new Set();
  const servers = Array.isArray(manifest?.mcpServers) ? manifest.mcpServers : [];
  for (const s of servers) {
    if (typeof s?.registryName === "string" && s.registryName.trim()) out.add(s.registryName.trim());
  }
  return out;
}

/**
 * The union of MCP server names after installing `incoming` on top of
 * `existingManifests`. Overlapping references (the common case — fleet-architect
 * and facet-market are shared by many packs) count ONCE, because that is what
 * the profile patch materialises.
 */
export function projectedMcpNames(existingManifests, incomingManifest) {
  const union = new Set();
  for (const m of Array.isArray(existingManifests) ? existingManifests : []) {
    for (const n of mcpNamesOf(m)) union.add(n);
  }
  for (const n of mcpNamesOf(incomingManifest)) union.add(n);
  return union;
}

function limitsOf(env = {}) {
  const soft = Number(env.CELL_MCP_SOFT_LIMIT);
  const hard = Number(env.CELL_MCP_HARD_LIMIT);
  const softLimit = Number.isFinite(soft) && soft > 0 ? soft : DEFAULT_MCP_SOFT_LIMIT;
  const hardLimit = Number.isFinite(hard) && hard > 0 ? hard : DEFAULT_MCP_HARD_LIMIT;
  return { softLimit, hardLimit: Math.max(hardLimit, softLimit) };
}

/**
 * 关闸（回滚点）。ADR-0032 承诺的「上限配置可整体置空 ⇒ 等价于关闭闸」必须真的
 * 存在：只把闸的**数**做成可配置、却没有一个「不判」的取值，回滚就只剩改代码。
 *
 * 两种写法都认（只记得住一个变量名的人也关得掉）：
 *   - `CELL_MCP_BUDGET=off|none|disabled|0|false` —— 显式总闸
 *   - `CELL_MCP_HARD_LIMIT=0|off|none|disabled` —— 把硬上限写成「不许判」
 *
 * 关闸**不是**「上限变成 0」：那会把所有装包全拒掉（方向正好相反）。所以这里单独
 * 判一个布尔，`limitsOf` 的默认值不受影响。
 */
function budgetDisabled(env = {}) {
  const off = new Set(["off", "none", "disabled", "false", "0"]);
  const budget = String(env.CELL_MCP_BUDGET ?? "").trim().toLowerCase();
  if (off.has(budget)) return true;
  const hard = String(env.CELL_MCP_HARD_LIMIT ?? "").trim().toLowerCase();
  return off.has(hard);
}

/**
 * Decide what the install face should do.
 *
 * @returns {{level: "ok"|"soft"|"hard"|"disabled", ok: boolean, count: number,
 *            added: string[], softLimit: number, hardLimit: number,
 *            disabled?: boolean, message: string|null}}
 *   `ok:false` only at "hard" — soft is advisory by design: a cell already past
 *   the soft limit must still be able to install the pack that would let its
 *   owner remove others (refusing everything would strand it).
 */
export function mcpBudgetCheck({ existingManifests = [], incomingManifest = null, env = {} } = {}) {
  const { softLimit, hardLimit } = limitsOf(env);
  const before = projectedMcpNames(existingManifests, null);
  const after = projectedMcpNames(existingManifests, incomingManifest);
  const added = [...after].filter((n) => !before.has(n));
  const count = after.size;

  const base = { count, added, softLimit, hardLimit };
  // 关闸优先于一切：回滚点是「不判」，不是「判得更松」。
  if (budgetDisabled(env)) return { ...base, level: "disabled", ok: true, disabled: true, message: null };
  if (count > hardLimit) {
    return {
      ...base,
      level: "hard",
      ok: false,
      message:
        `installing this pack would leave the cell carrying ${count} MCP servers `
        + `(limit ${hardLimit}, adding ${added.length ? added.join(", ") : "none"}). `
        + `dsh initialises them serially inside a 60s budget — past this point the whole `
        + `cell fails to start and EVERY fleet on it stops running, reporting only `
        + `"initialize timed out". Uninstall unused packs first (each uninstall frees its references).`,
    };
  }
  if (count > softLimit) {
    return {
      ...base,
      level: "soft",
      ok: true,
      message:
        `this cell now carries ${count} MCP servers (soft limit ${softLimit}). `
        + `There is a hard ceiling near ${hardLimit}: past it dsh init exceeds 60s and the `
        + `cell stops starting entirely. Consider uninstalling packs you no longer use.`,
    };
  }
  return { ...base, level: "ok", ok: true, message: null };
}

/**
 * The install face's verdict — `mcpBudgetCheck` plus the one policy that belongs
 * to it: **a pack that adds no new MCP server is never hard-refused**
 * (mcp-injection-budget-residual 2.2).
 *
 * Why that carve-out is not a loophole: `mcpBudgetCheck` answers "where would the
 * cell land", and a cell already past the hard limit answers `hard` even for an
 * install that adds nothing. Refusing those installs would strand the very cell
 * that needs to be repaired — it could not upgrade, re-install, or install the
 * pack whose skills tell its owner which packs to drop. The state is bad; the
 * install does not make it worse; so it goes through with a warning.
 *
 * A pack that DOES add servers is refused the moment the union crosses the hard
 * limit, and `ok`/`level` stay `mcpBudgetCheck`'s own answer, so the two faces
 * cannot drift apart.
 *
 * @returns {{refuse: boolean, level: "ok"|"soft"|"hard"|"disabled", count: number,
 *            added: string[], softLimit: number, hardLimit: number,
 *            disabled?: boolean, message: string|null}}
 */
export function installBudgetVerdict({ existingManifests = [], incomingManifest = null, env = {} } = {}) {
  const check = mcpBudgetCheck({ existingManifests, incomingManifest, env });
  if (check.level !== "hard") return { ...check, refuse: false };
  if (check.added.length === 0) {
    // Already over the ceiling, and this pack changes nothing about that.
    return {
      ...check,
      refuse: false,
      message:
        `this cell already carries ${check.count} MCP servers (hard limit ${check.hardLimit}) — `
        + `over the ceiling dsh still fails to start. This pack adds no new MCP server, so it is `
        + `installed, but the cell stays broken until packs are uninstalled.`,
    };
  }
  return { ...check, refuse: true };
}
