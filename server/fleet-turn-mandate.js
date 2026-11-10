// Turn mandate lane (add-turn-mandate-lane, agent-turn-mandate).
//
// The authorization layer for event-sourced turn requests — the missing half
// of "who may start an agent's work" (charter: docs/agent-domain-design-charter.md
// §2 rules 1-3, 5). The orchestration half (edges, wakes, caps) already exists
// in fleet-event-wake.js; THIS module owns the vocabulary that wake now stamps:
//
//   • Signal-source policy — one per `bot:<id>` source: accept mode
//     (off/observe/auto), the allowed list, the admission table, explicit
//     accept rules. v1 config is a JSON file the owner edits
//     (`<PLATFORM_DATA_DIR>/signal-sources.json`); absence = the default
//     policy, which IS today's behavior byte for byte (spec: 默认表与现状
//     逐字节一致). Read fresh on every evaluation — no cache to invalidate.
//   • Mandate — the immutable authorization a wake records at creation:
//     strength (explicit/inferred), basis (via + cell), the policy version it
//     relied on, the trigger reference. Three operations only: accept creates,
//     a person's stop withdraws (not built — nothing withdraws it yet),
//     failed revalidation revokes. Charter rule 2.
//   • Revalidation — a mandate-carrying task re-executing (run-now / re-run,
//     task-engine's enqueueExecution seam) revalidates against the CURRENT
//     policy first: stamp mismatch notifies (an honest O1 row), a failed check
//     refuses the resume. Tasks without a mandate are untouched (zero
//     disturbance, byte-identical).
//   • Disposition — every guard-passed inbound message gets ONE exact fate
//     row per bot source (admitted / cap_refused / filtered / would_accept)
//     with a structured reason code — never free-text attribution (charter
//     rule 5). Bounded ring per bot (default 200, the machine-history
//     convention), one JSON file, async write, failure degrades observation
//     only — it must never block or disturb the inbound path.
//
// The gate is CODE; the model judges nothing here (design D4: observe's
// "would accept" is a deterministic rule match — model assessment is a later
// lane with the judge-discipline rules). Messages are inputs to decisions,
// never rules (charter rule 3).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Policy ───────────────────────────────────────────────────────────────────

// Accept modes (spec: 影子放量档). off = today's behavior, the default.
export const ACCEPT_MODES = ["off", "observe", "auto"];

// Admission cells (spec: 准入表). The DEFAULT table encodes current behavior:
// an edge-hit message is explicit regardless of sender (the owner declared
// that exact signal); everything else is off-mode, never evaluated.
export const ADMISSION_CELLS = ["explicit", "inferred", "ignore"];

// The admission table, per source. Rows:
//   edge                 — a message matched a declared event edge (the scope
//                          the owner declared): explicit | ignore
//   listed_unaddressed   — listed sender, not addressing the bot, no edge
//   unlisted_addressed   — unlisted sender addressing the bot, no edge
//   unlisted_unaddressed — unlisted sender, not addressing, no edge
// Bot senders may only ever yield inferred candidates (never explicit), and
// only when on the source's bot list; others are ignored.
export const DEFAULT_ADMISSION = {
  edge: "explicit",
  listed_unaddressed: "inferred",
  unlisted_addressed: "ignore",
  unlisted_unaddressed: "ignore",
};

// The default policy IS current behavior (spec: off 与现状逐字节一致).
export function defaultSignalPolicy() {
  return { mode: "off", allowed: [], bots: [], admission: { ...DEFAULT_ADMISSION }, rules: [] };
}

const POLICY_FILE = () =>
  path.join(process.env.PLATFORM_DATA_DIR || process.cwd(), "signal-sources.json");

// The one policy reader. Corrupt or malformed file → the default policy and a
// warning (a broken config must not take the inbound path down); unknown
// mode/cell values fall back to their defaults field by field.
export function readSignalPolicy(botId) {
  const fallback = defaultSignalPolicy();
  let raw;
  try {
    raw = fs.readFileSync(POLICY_FILE(), "utf8");
  } catch {
    return fallback;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`[turn-mandate] signal-sources.json is not valid JSON (${e.message}); default policy applies`);
    return fallback;
  }
  const entry = parsed?.[botId];
  if (!entry || typeof entry !== "object") return fallback;
  const mode = ACCEPT_MODES.includes(entry.mode) ? entry.mode : fallback.mode;
  const admission = { ...fallback.admission };
  for (const key of Object.keys(DEFAULT_ADMISSION)) {
    if (ADMISSION_CELLS.includes(entry.admission?.[key])) admission[key] = entry.admission[key];
  }
  const rules = Array.isArray(entry.rules)
    ? entry.rules.filter((r) => r && typeof r.id === "string" && typeof r.target === "string")
    : [];
  const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : []);
  return { mode, allowed: names(entry.allowed), bots: names(entry.bots), admission, rules };
}

// The policy version stamp: a content hash over EXACTLY these fields — mode,
// allowed, bots, admission, rules (design: the input field list is declared in
// one place and pinned by test, so a future field can never silently drop out
// of revalidation). Sorted keys/names so semantically equal policies hash equal.
export function policyVersionOf(policy) {
  const canonical = {
    mode: policy?.mode ?? "off",
    allowed: [...(policy?.allowed ?? [])].sort(),
    bots: [...(policy?.bots ?? [])].sort(),
    admission: { ...(policy?.admission ?? DEFAULT_ADMISSION) },
    rules: (policy?.rules ?? [])
      .map((r) => ({ id: r.id, target: r.target, keywords: [...(r.keywords ?? [])].sort(), note: r.note ?? null }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
  return "pv_" + crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}

// ── The gate ─────────────────────────────────────────────────────────────────

// Deterministic admission for one inbound message against one source's policy.
// Returns { admitted, strength, via, cell, ruleId, reason }:
//   admitted=true             → a wake may be created; strength/via feed the
//                               mandate
//   admitted=false, reason    → filtered; the code names why (never prose)
//   admitted=false,
//   wouldAccept=true          → observe-mode shadow acceptance: fully assessed,
//                               recorded, never woken
function ruleMatch(rule, text) {
  const kws = Array.isArray(rule.keywords) ? rule.keywords : [];
  if (!kws.length) return true; // a rule without keywords matches any candidate
  const hay = String(text ?? "").toLowerCase();
  return kws.some((k) => hay.includes(String(k).toLowerCase()));
}

// Routing note (our deviation from upstream, documented): upstream's main
// Session routes candidates, so an explicit request needs no rule. We have no
// router — a non-edge wake needs a STRUCTURAL route, so every non-edge
// admission (explicit cell or inferred) requires a matched rule whose
// `target` names the post. The owner-declared explicit lane is the EDGE, and
// it works in every mode — that is our "explicit requests work everywhere".
export function admitTrigger({ policy, edgeHit, senderName, isBot = false, addressed = false, text = "" }) {
  const sender = String(senderName ?? "");
  const listed = policy.allowed.includes(sender);
  if (edgeHit) {
    const cell = policy.admission.edge;
    if (cell === "explicit") return { admitted: true, strength: "explicit", via: "edge", row: "edge", cell };
    return { admitted: false, reason: "edge_ignored", row: "edge", cell };
  }
  // Non-edge surface: never evaluated in off mode (today's behavior).
  if (policy.mode === "off") return { admitted: false, reason: "off_mode" };
  // Pick the table row.
  let row;
  let cell;
  let botSender = false;
  if (isBot) {
    if (!policy.bots.includes(sender)) return { admitted: false, reason: "bot_not_listed" };
    botSender = true;
    row = "bot";
    cell = "inferred"; // a listed bot may produce an inferred candidate, never explicit
  } else if (listed) {
    row = "listed_unaddressed";
    cell = addressed ? "explicit" : policy.admission.listed_unaddressed;
  } else if (addressed) {
    row = "unlisted_addressed";
    cell = policy.admission.unlisted_addressed;
  } else {
    row = "unlisted_unaddressed";
    cell = policy.admission.unlisted_unaddressed;
  }
  if (cell === "ignore") return { admitted: false, reason: "ignored_by_table", row, cell };
  // A matched explicit accept rule decides (charter rule 3 — the gate is
  // code; a proactive accept requires a matched rule, which also names the
  // route). Observe shadows EVERY new surface — explicit cells included:
  // the ramp-up rung records, it never wakes.
  const matched = policy.rules.find((r) => ruleMatch(r, text));
  if (!matched) {
    return {
      admitted: false,
      reason: policy.mode === "auto" && !policy.rules.length ? "auto_missing_rules" : "no_rule_match",
      row,
      cell,
    };
  }
  if (policy.mode === "observe") {
    return { admitted: false, wouldAccept: true, reason: "observe_would_accept", row, cell, ruleId: matched.id };
  }
  // auto: admitted. A listed bot's candidate can never rise past inferred.
  const strength = botSender || cell !== "explicit" ? "inferred" : "explicit";
  return { admitted: true, strength, via: "admission", row, cell, ruleId: matched.id };
}

// ── Mandate ──────────────────────────────────────────────────────────────────

// The immutable authorization a wake carries. Frozen — nothing may edit it
// after creation (spec: mandate SHALL NOT 在创建后被改写). `row` names the
// admission-table row the strength came from, `listed` records the sender's
// membership at accept time — both feed revalidation (removing a sender CAN
// revoke, per spec).
export function buildMandate({ strength, via, row, cell = null, ruleId = null, policy, botId, chatKey, senderName }) {
  const sender = String(senderName ?? "");
  return Object.freeze({
    strength,
    via,
    ...(row ? { row } : {}),
    ...(cell ? { cell } : {}),
    ...(ruleId ? { ruleId } : {}),
    policyVersion: policyVersionOf(policy),
    trigger: { botId: botId ?? null, chatKey: chatKey ?? null, sender: senderName ?? null, listed: policy.allowed.includes(sender) },
  });
}

// Revalidation before resume (spec: 恢复前重校验). `policy` is the CURRENT
// policy for the mandate's source. Returns { ok, reason?, stampChanged }.
//   ok=true, stampChanged=true  → the resume may proceed under the new policy;
//                                 the caller notifies (honest disposition row)
//   ok=false, reason            → the resume is refused; the mandate's
//                                 effectiveness is revoked by this failure
// A task WITHOUT a mandate never reaches here (the hook checks first); a
// malformed one fails OPEN — legacy tolerance, it was created before stamps
// existed and blocking it would disturb existing behavior.
export function revalidateMandate(mandate, policy) {
  if (!mandate || typeof mandate !== "object" || !mandate.policyVersion) {
    return { ok: true, stampChanged: false };
  }
  const stampChanged = policyVersionOf(policy) !== mandate.policyVersion;
  if (!stampChanged) return { ok: true, stampChanged: false };
  const notify = { ok: true, stampChanged: true };
  const refuse = (reason) => ({ ok: false, reason, stampChanged: true });
  if (mandate.via === "edge") {
    return policy.admission.edge === "ignore" ? refuse("edge_now_ignored") : notify;
  }
  // via === "admission": the matched rule is both authorization AND route.
  const sender = String(mandate.trigger?.sender ?? "");
  const listedNow = sender !== "" && policy.allowed.includes(sender);
  if (mandate.strength === "inferred") {
    // Spec order: needs auto mode AND its matched rules still enabled.
    if (policy.mode !== "auto") return refuse("mode_no_longer_auto");
    if (mandate.ruleId && !policy.rules.some((r) => r.id === mandate.ruleId)) {
      return refuse("rule_no_longer_present");
    }
    if (mandate.row === "bot") {
      if (!policy.bots.includes(sender)) return refuse("bot_no_longer_listed");
    } else if (mandate.row === "listed_unaddressed") {
      if (!listedNow) return refuse("sender_no_longer_listed");
      if (policy.admission.listed_unaddressed === "ignore") return refuse("cell_no_longer_admits");
    } else if (mandate.row === "unlisted_unaddressed") {
      if (policy.admission.unlisted_unaddressed === "ignore") return refuse("cell_no_longer_admits");
    }
    return notify;
  }
  // explicit via admission: the matched rule is still the route; a listed
  // sender keeps its explicit basis by remaining on the list; an unlisted-
  // addressed-cell sender needs that cell to still say explicit.
  if (mandate.ruleId && !policy.rules.some((r) => r.id === mandate.ruleId)) {
    return refuse("rule_no_longer_present");
  }
  if (mandate.trigger?.listed === true) {
    if (!listedNow) return refuse("sender_no_longer_listed");
  } else if (policy.admission.unlisted_addressed !== "explicit") {
    return refuse("cell_no_longer_explicit");
  }
  return notify;
}

// ── Disposition (入站去向账) ─────────────────────────────────────────────────

// Fates (spec: admitted / filtered / would_accept / cap_refused — each with a
// structured reason code). The ring is per bot source, in ONE JSON file; a
// failed write degrades to a console warn and never touches the inbound path.
export const DISPOSITION_FATES = ["admitted", "cap_refused", "filtered", "would_accept"];

const DISPOSITION_FILE = () =>
  path.join(process.env.PLATFORM_DATA_DIR || process.cwd(), "signal-dispositions.json");

function dispositionCap() {
  const n = Number(process.env.FLEET_SIGNAL_DISPOSITION_RING);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}

const dispositionCache = new Map(); // botId → entries[] (write-through cache)

function loadDispositions(botId) {
  if (dispositionCache.has(botId)) return dispositionCache.get(botId);
  let all;
  try {
    all = JSON.parse(fs.readFileSync(DISPOSITION_FILE(), "utf8"));
  } catch {
    all = {};
  }
  for (const [k, v] of Object.entries(all)) {
    if (Array.isArray(v)) dispositionCache.set(k, v);
  }
  if (!dispositionCache.has(botId)) dispositionCache.set(botId, []);
  return dispositionCache.get(botId);
}

let writeTimer = null;
function writeDispositionsFile() {
  try {
    const out = {};
    for (const [k, v] of dispositionCache) out[k] = v;
    fs.mkdirSync(path.dirname(DISPOSITION_FILE()), { recursive: true });
    fs.writeFileSync(DISPOSITION_FILE(), JSON.stringify(out), "utf8");
  } catch (e) {
    console.warn(`[turn-mandate] disposition write failed (observation degrades, inbound unaffected): ${e.message}`);
  }
}

function scheduleFlush() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeDispositionsFile();
  }, 150);
  writeTimer.unref?.();
}

// Test seam: flush the debounced write NOW (synchronous).
export function flushDispositionsForTests() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  writeDispositionsFile();
}

// Record one inbound fate. Fire-and-forget by design (design: 异步写入，记账
// 失败只降级观测、不阻断入站与唤醒). `FLEET_SIGNAL_DISPOSITION=off` stops all
// writes — the rollback switch.
export function recordDisposition(botId, entry) {
  if (String(process.env.FLEET_SIGNAL_DISPOSITION ?? "").toLowerCase() === "off") return;
  if (!entry || !DISPOSITION_FATES.includes(entry.fate)) return;
  const ring = loadDispositions(botId);
  ring.push({ at: Date.now(), ...entry });
  while (ring.length > dispositionCap()) ring.shift(); // bounded ring: oldest flips
  scheduleFlush();
}

// Test seam: drop the cache (the file is the truth on disk).
export function resetDispositionCacheForTests() {
  dispositionCache.clear();
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}
