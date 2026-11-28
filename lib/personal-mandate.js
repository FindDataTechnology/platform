// ── Personal mandate (add-personal-mandate) ──────────────────────────────────
//
// The policy layer that sits ON TOP of action-gate, not beside it. Given
// (principal, domain, action, args, usage) it answers one question with one
// return value: may this be done, at what tier, and how much may be said.
//
// Deliberately a leaf module: it imports nothing. action-preflight imports it,
// action-registry re-exports its immutable constants, and neither direction
// creates a cycle.
//
// Design notes that must survive edits:
//   - D2: mode → decision is a hardcoded table, never derived from data.
//   - D3: NON_DOWNGRADABLE lives here as a frozen constant, not in the DB. A
//     single UPDATE must never be able to unlock a destructive action.
//   - D8: an action with no reverse operation may not auto-execute. The revoke
//     window is the premise of "act first, report after", not a nicety.
//   - Unconfigured domains resolve to `advise` with zero quota: the default is
//     the floor, never a grant.

export const DOMAINS = Object.freeze([
  "ops", // 舰队内部运营（沿用既有委托语义）
  "external-comms", // 对外沟通
  "advancement", // 事项推进
  "research", // 研究产出
]);

export const MODES = Object.freeze({
  advise: "advise",
  draft: "draft",
  "act-notify": "act-notify",
  "act-silent": "act-silent",
});

// Higher rank = more autonomy. Downgrades only ever move down.
export const MODE_RANK = Object.freeze({
  advise: 0,
  draft: 1,
  "act-notify": 2,
  "act-silent": 3,
});

export const DECISION = Object.freeze({
  ADVISE: "advise",
  DRAFT: "draft",
  EXECUTE: "execute",
  // No mandate applies (copilot, or a caller that does not hold one). The
  // caller MUST fall back to action-gate's risk-based tier.
  FALLBACK: "fallback",
});

export const DISCLOSE_LEVELS = Object.freeze(["public", "internal", "confidential", "hr", "finance"]);

// Risks that may never be downgraded by a mandate, regardless of any config.
export const NON_DOWNGRADABLE = Object.freeze(["destructive", "publish"]);

const DEFAULT_MODE = MODES.advise;

export function isDomain(name) {
  return DOMAINS.includes(name);
}

export function isMode(name) {
  return Object.hasOwn(MODE_RANK, name);
}

export function isDiscloseLevel(name) {
  return DISCLOSE_LEVELS.includes(name);
}

// The most autonomous mode a given risk permits. Settings surfaces derive their
// option list from this function, so the UI and the server can never disagree.
export function allowedModesFor(risk) {
  return NON_DOWNGRADABLE.includes(risk)
    ? [MODES.advise, MODES.draft]
    : [MODES.advise, MODES.draft, MODES["act-notify"], MODES["act-silent"]];
}

function lowerMode(mode) {
  if (mode === MODES["act-silent"]) return MODES["act-notify"];
  if (mode === MODES["act-notify"]) return MODES.draft;
  return MODES.advise;
}

function normalizeLimits(raw) {
  const out = { amount: null, count: null };
  if (!raw || typeof raw !== "object") return out;
  if (Number.isFinite(raw.amount) && raw.amount >= 0) out.amount = raw.amount;
  if (Number.isFinite(raw.count) && raw.count >= 0) out.count = Math.floor(raw.count);
  return out;
}

function normalizeActionRule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rule = {
    mode: isMode(raw.mode) ? raw.mode : null,
    limits: normalizeLimits(raw.limits),
    expiresAt: Number.isFinite(raw.expiresAt) ? raw.expiresAt : null,
    revokeWindowMinutes: Number.isFinite(raw.revokeWindowMinutes) && raw.revokeWindowMinutes > 0
      ? Math.floor(raw.revokeWindowMinutes)
      : null,
  };
  return rule;
}

function normalizeDomainBlock(raw) {
  // Unknown keys are preserved on purpose: the `ops` domain carries the legacy
  // delegation fields (routes/maxSeverity/dailyBudget/enabled/deputyMemberId)
  // that the deputy path still reads. Dropping them here would silently reset
  // delegation on the next write.
  const block = { ...(raw && typeof raw === "object" ? raw : {}) };
  block.mode = isMode(block.mode) ? block.mode : DEFAULT_MODE;
  block.limits = normalizeLimits(block.limits);
  block.expiresAt = Number.isFinite(block.expiresAt) ? block.expiresAt : null;
  block.revokeWindowMinutes =
    Number.isFinite(block.revokeWindowMinutes) && block.revokeWindowMinutes > 0
      ? Math.floor(block.revokeWindowMinutes)
      : null;
  block.readScope = Array.isArray(block.readScope) ? block.readScope.filter(isDiscloseLevel) : [];
  block.discloseScope = Array.isArray(block.discloseScope) ? block.discloseScope.filter(isDiscloseLevel) : [];
  block.actions = {};
  if (raw?.actions && typeof raw.actions === "object") {
    for (const [id, ruleRaw] of Object.entries(raw.actions)) {
      const rule = normalizeActionRule(ruleRaw);
      if (rule) block.actions[id] = rule;
    }
  }
  return block;
}

// Flat legacy shape {routes, maxSeverity, dailyBudget, model, digest} is the
// `ops` domain, verbatim. Nothing is reinterpreted: the equivalence test pins
// this, and it is what makes the upgrade a no-op.
function legacyOpsBlock(raw) {
  const block = normalizeDomainBlock({ mode: MODES.draft });
  if (raw.enabled === false) block.mode = MODES.advise;
  if (raw.routes && typeof raw.routes === "object") block.routes = { ...raw.routes };
  if (typeof raw.maxSeverity === "string") block.maxSeverity = raw.maxSeverity;
  if (Number.isFinite(raw.dailyBudget)) block.dailyBudget = Math.floor(raw.dailyBudget);
  if (typeof raw.model === "string") block.model = raw.model;
  if (raw.digest !== undefined) block.digest = raw.digest;
  return block;
}

export function isLegacyPolicy(raw) {
  return Boolean(raw) && typeof raw === "object" && !raw.domains;
}

/**
 * Normalize any stored policy into the v2 shape.
 * Returns { ok: true, policy } or { ok: false, error } — unknown domain names are
 * rejected rather than silently degraded to `advise` (a typo that quietly
 * removes authority is as bad as one that quietly grants it).
 */
export function normalizeMandatePolicy(raw) {
  if (raw === null || raw === undefined) {
    return { ok: true, policy: { version: 2, domains: {} } };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "mandate policy must be an object" };
  }

  const domains = {};
  if (isLegacyPolicy(raw)) {
    domains.ops = legacyOpsBlock(raw);
    return { ok: true, policy: { version: 2, domains } };
  }

  const source = raw.domains && typeof raw.domains === "object" ? raw.domains : {};
  for (const [name, blockRaw] of Object.entries(source)) {
    if (!isDomain(name)) {
      return { ok: false, error: `unknown mandate domain: ${name}` };
    }
    domains[name] = normalizeDomainBlock(blockRaw);
  }
  return { ok: true, policy: { version: 2, domains } };
}

// Fleet-level override on top of the cell default. Overrides may only tighten:
// a mode higher than the base's is clamped, and a missing base stays missing.
export function mergeMandatePolicies(basePolicy, overridePolicy) {
  const base = basePolicy?.domains ?? {};
  const over = overridePolicy?.domains ?? {};
  const domains = {};
  for (const name of DOMAINS) {
    const b = base[name];
    const o = over[name];
    if (!b && !o) continue;
    if (!o) { domains[name] = b; continue; }
    const merged = normalizeDomainBlock({ ...(b ?? {}), ...o });
    if (b && MODE_RANK[merged.mode] > MODE_RANK[b.mode]) merged.mode = b.mode;
    domains[name] = merged;
  }
  return { version: 2, domains };
}

function effectiveRule(block, actionId) {
  const rule = block?.actions?.[actionId] ?? null;
  return {
    mode: rule?.mode ?? block?.mode ?? DEFAULT_MODE,
    limits: {
      amount: rule?.limits?.amount ?? block?.limits?.amount ?? null,
      count: rule?.limits?.count ?? block?.limits?.count ?? null,
    },
    expiresAt: rule?.expiresAt ?? block?.expiresAt ?? null,
    revokeWindowMinutes: rule?.revokeWindowMinutes ?? block?.revokeWindowMinutes ?? null,
  };
}

function included(scope, level) {
  return Array.isArray(scope) && scope.includes(level);
}

/**
 * Classify the outbound text of an action against a disclose scope.
 *
 * Deterministic on purpose — no model call, no NLP guess:
 *   1. declared provenance levels (the agent says which memory layers it drew on)
 *   2. currency/amount patterns → `finance`
 *   3. operator-configured sensitive terms → their declared level
 *
 * `contentArgs` comes from the action registry; an outbound action without it
 * fails registry load (see action-registry), so this function never has to
 * guess which argument is "the thing being said".
 */
export function checkDisclosure({
  action,
  args,
  discloseScope,
  declaredSources = [],
  sensitiveTerms = [],
} = {}) {
  const contentArgs = Array.isArray(action?.contentArgs) ? action.contentArgs : [];
  const texts = [];
  for (const key of contentArgs) {
    const value = args?.[key];
    // Publishing an object (a pack manifest) is still publishing its text: the
    // gate must read what a human would read, so non-strings are serialized
    // rather than skipped. Skipping them was a silent pass.
    if (typeof value === "string") texts.push(value);
    else if (value !== null && value !== undefined && typeof value === "object") {
      try { texts.push(JSON.stringify(value)); } catch { /* unserializable: nothing to read */ }
    } else if (typeof value === "number" || typeof value === "boolean") {
      texts.push(String(value));
    }
  }

  const hits = [];
  for (const source of declaredSources) {
    const level = source?.level;
    if (isDiscloseLevel(level) && !included(discloseScope, level)) {
      hits.push({ level, via: "provenance", ref: source?.ref ?? null });
    }
  }

  if (/\d[\d,.]*\s*(万|亿|元|美元|USD|CNY|¥|\$)/i.test(texts.join("\n"))) {
    if (!included(discloseScope, "finance")) {
      hits.push({ level: "finance", via: "pattern", ref: "amount" });
    }
  }

  for (const term of sensitiveTerms) {
    if (!term?.text || !isDiscloseLevel(term?.level)) continue;
    if (texts.some((text) => text.includes(term.text))) {
      if (!included(discloseScope, term.level)) {
        hits.push({ level: term.level, via: "term", ref: term.text });
      }
    }
  }

  if (hits.length === 0) return { ok: true, violations: [] };
  return { ok: false, violations: hits };
}

/**
 * Does the mandate grant the agent anything in this domain?
 *
 * This is the personal-domain routing question. The fleet-internal lane routes
 * by category (with three categories hard-locked to the owner), but that
 * vocabulary does not travel: in a personal domain "spend" is the most common
 * delegation of all, and what must not be delegated is spending ABOVE A LIMIT,
 * not the category. So a personal item routes to the agent when — and only
 * when — the domain's mode is anything other than `advise`.
 */
export function agentMayHandle(policy, domain) {
  const mode = policy?.domains?.[domain]?.mode;
  return mode === MODES.draft || mode === MODES["act-notify"] || mode === MODES["act-silent"];
}

/**
 * Read-side gate. `read_scope` and `disclose_scope` are deliberately separate:
 * being allowed to read a layer never implies being allowed to say it.
 *
 * Callers pass the levels the read would touch; every one of them must be in
 * scope. An absent/empty scope means "nothing outside `public`", never
 * "everything" — an empty list is the floor, not a wildcard.
 */
export function checkReadScope({ policy, domain, levels = [] } = {}) {
  const scope = policy?.domains?.[domain]?.readScope;
  const allowed = Array.isArray(scope) ? scope : [];
  const denied = levels.filter((level) => !included(allowed, level));
  if (denied.length === 0) return { ok: true, denied: [] };
  return { ok: false, denied };
}

/**
 * 层级样本闸 (add-principal-disclosure-gate 5.1)。
 *
 * 域整体一致率达标 ≠ 可以对外自动说话：错误的代价按披露层级分布——财务层
 * 说错一句和内部层说错一句不是一个量级。所以升档需要「本次命中的层级」自己
 * 攒够样本。
 *
 * `levelSamples` 形如 { public: 30, finance: 0 }；`level` 为本次发言命中的最高
 * 层级。层级未知（null）时按拒绝处理——不知道该按哪一层算，就不能放行。
 */
export function canAutoSendAtLevel({ level, levelSamples = {}, minSamples = 20 } = {}) {
  if (!level) {
    return { ok: false, reason: "unknown_level", level: null, samples: 0 };
  }
  const samples = Number(levelSamples?.[level] ?? 0);
  if (!Number.isFinite(samples) || samples < minSamples) {
    return { ok: false, reason: "insufficient_level_samples", level, samples };
  }
  return { ok: true, reason: null, level, samples };
}

/**
 * Resolve one proposed action against a mandate.
 *
 * usage: { count, amount } consumed in this domain during the current window.
 * principal: { kind: 'agent' | 'copilot' | ... } — only `agent` holds a mandate.
 */
export function resolveMandate({
  policy,
  domain,
  action,
  args = {},
  usage = { count: 0, amount: 0 },
  principal = { kind: "copilot" },
  now = Date.now(),
  declaredSources = [],
  sensitiveTerms = [],
  requestLevels = [],
} = {}) {
  const reasons = [];
  const mandateRef = { domain: domain ?? null, actionId: action?.id ?? null };

  const fallback = (why) => ({
    ok: true,
    decision: DECISION.FALLBACK,
    mode: null,
    tier: null,
    notify: false,
    disclose: null,
    mandateRef,
    reasons: [why],
  });

  if (principal?.kind !== "agent") return fallback("not_agent");
  if (!domain) return fallback("no_domain");

  const block = policy?.domains?.[domain];
  if (!block) {
    // Unconfigured domain: advise only, zero quota. Not a silent grant.
    return {
      ok: true,
      decision: DECISION.ADVISE,
      mode: MODES.advise,
      tier: null,
      notify: false,
      disclose: null,
      mandateRef,
      reasons: ["no_policy"],
    };
  }

  const rule = effectiveRule(block, action?.id);
  let mode = rule.mode;
  if (!isMode(mode)) mode = MODES.advise;

  // Risk ceiling. Applies before anything else: no quota, no override, and no
  // expiry can lift a mode above what this risk allows.
  const cap = allowedModesFor(action?.risk);
  const capMode = cap[cap.length - 1];
  if (MODE_RANK[mode] > MODE_RANK[capMode]) {
    mode = capMode;
    reasons.push("non_downgradable");
  }

  // D8: no reverse operation → no auto-execution.
  const wantsAuto = MODE_RANK[mode] >= MODE_RANK[MODES["act-notify"]];
  if (wantsAuto && action?.revocable !== true) {
    mode = MODES.draft;
    reasons.push("not_revocable");
  }

  // Expiry falls to draft, never to a higher mode.
  if (rule.expiresAt && now > rule.expiresAt && MODE_RANK[mode] > MODE_RANK[MODES.draft]) {
    mode = MODES.draft;
    reasons.push("expired");
  }

  // Quota exhaustion steps down exactly one level, and only downward.
  const count = Number.isFinite(usage.count) ? usage.count : 0;
  const amount = Number.isFinite(usage.amount) ? usage.amount : 0;
  const overCount = rule.limits.count !== null && count >= rule.limits.count;
  const overAmount = rule.limits.amount !== null && amount >= rule.limits.amount;
  if ((overCount || overAmount) && MODE_RANK[mode] > MODE_RANK[MODES.advise]) {
    mode = lowerMode(mode);
    reasons.push("quota_exhausted");
  }

  // A cost action may only auto-execute with an explicit amount ceiling.
  if (action?.risk === "cost" && wantsAuto && rule.limits.amount === null) {
    mode = MODES.draft;
    reasons.push("cost_limit_missing");
  }

  let disclose = null;
  if (action?.outbound === true) {
    const checked = checkDisclosure({
      action,
      args,
      discloseScope: block.discloseScope,
      declaredSources,
      sensitiveTerms,
    });
    disclose = checked;
    if (!checked.ok && MODE_RANK[mode] >= MODE_RANK[MODES["act-notify"]]) {
      // Out of scope: the action may still be drafted, never sent.
      mode = MODES.draft;
      reasons.push("disclose_out_of_scope");
    }
  }

  // Read-side: a read action that touches levels outside `read_scope` is not
  // permitted at all — there is no "draft" of a read. The caller declares what
  // the read would touch (requestLevels); an empty declaration is the floor.
  if (action?.risk === "read") {
    const levels = Array.isArray(requestLevels) ? requestLevels : [];
    if (!checkReadScope({ policy, domain, levels }).ok) {
      return {
        ok: true,
        decision: DECISION.ADVISE,
        mode: MODES.advise,
        tier: null,
        notify: false,
        disclose: null,
        mandateRef,
        reasons: ["read_out_of_scope"],
      };
    }
  }

  if (mode === MODES.advise) {
    return {
      ok: true,
      decision: DECISION.ADVISE,
      mode,
      tier: null,
      notify: false,
      disclose,
      mandateRef,
      reasons: reasons.length ? reasons : ["mode_advise"],
    };
  }
  if (mode === MODES.draft) {
    return {
      ok: true,
      decision: DECISION.DRAFT,
      mode,
      tier: "inline",
      notify: false,
      disclose,
      mandateRef,
      reasons,
    };
  }
  return {
    ok: true,
    decision: DECISION.EXECUTE,
    mode,
    tier: "auto",
    notify: mode === MODES["act-notify"],
    disclose,
    mandateRef: { ...mandateRef, revokeWindowMinutes: rule.revokeWindowMinutes },
    reasons,
  };
}

// Settings surfaces call this so the option list they render is the same
// function the server enforces (D3).
export function modeOptionsFor(action) {
  return allowedModesFor(action?.risk).map((mode) => ({
    mode,
    allowed: true,
  }));
}
