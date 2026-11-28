// ── Task flow: declaration, station resolution, acceptance (add-task-flow) ───
//
// The DATA and JUDGEMENT layer: a flow is a declared list of stations; each
// station names a target and an acceptance predicate. Nothing here renders, and
// nothing here executes — the engine runs tasks, this layer decides what a
// station means and whether a card has earned its way into "done".
//
// Two disciplines inherited from this repo, both load-bearing:
//
//   1. The target-kind set is IMPORTED from the engine, never restated. Two
//      copies of "which kinds exist" drift, and the drift's symptom is that one
//      kind silently stops being usable — no error, no log.
//
//   2. Persona-backed detection goes through the fleet layer's predicate, not
//      `=== "persona"`. When `auditor` was added on 2026-11-10, a dozen
//      scattered equality checks missed it and every miss was a silent
//      degradation (fleets-db.js:24 records the incident).

import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_TARGET_TYPES } from "../task-engine.js";
import { isPersonaBackedTargetKind } from "./routes/fleets-db.js";
import { normalizeAcceptance, TRIAL_ASSERTION_KINDS, JUDGE_ASSERTION_CAP } from "./blueprint-validate.js";

// Station target kinds = the engine's target kinds, verbatim. Exported so the
// write face and the tests read the same set the engine will accept.
export const STATION_TARGET_KINDS = Object.freeze([...SUPPORTED_TARGET_TYPES]);

// Card-level machine assertions, ON TOP of the platform's shared kind set.
//
// Why an extension at all: the shared closed set (blueprint-validate.js) is
// written for FLEET TRIAL runs — post-materialized / first-round-fired /
// report-landed / escalate-bounded all describe a fleet booting. A knowledge-
// work card produces a file and runs a command; none of those four can express
// it, and declaring one would be a lie the evaluator then has to fail.
//
// The SHAPE and the judge tier are still the shared ones (`normalizeAcceptance`,
// `llm-judged` + rubric + JUDGE_ASSERTION_CAP) — only the kind vocabulary is
// widened, and unknown kinds still fail closed. This is recorded in the change
// design as the one place the shared vocabulary was extended.
export const CARD_ASSERTION_KINDS = Object.freeze([
  ...TRIAL_ASSERTION_KINDS,
  "artifact-exists",
  "command-succeeds",
  "output-contains",
  // Portable run cards read real files and a real exit code. These two kinds
  // are the only vocabulary extension; evaluation still lives in this file.
  "file-contains",
  "exit-code",
]);

// The normalizer rejects anything outside TRIAL_ASSERTION_KINDS, so card-only
// kinds are validated here and then merged with the shared normalizer's output.
// Both tiers are checked against the same per-kind cap.
export function normalizeCardAcceptance(acceptance) {
  const errors = [];
  const list = Array.isArray(acceptance) ? acceptance : [];
  const extension = [];
  const shared = [];
  list.forEach((item, i) => {
    const kind = item?.kind;
    if (!CARD_ASSERTION_KINDS.includes(kind)) {
      errors.push({ error: `acceptance[${i}] declares unsupported assertion kind '${kind ?? "(none)"}' (supported: ${CARD_ASSERTION_KINDS.join(", ")})` });
      return;
    }
    if (TRIAL_ASSERTION_KINDS.includes(kind)) shared.push(item);
    else extension.push(item);
  });
  // The shared tier keeps its own validation (rubric non-empty, judge cap).
  const normalizedShared = normalizeAcceptance(shared);
  errors.push(...(normalizedShared.errors ?? []));
  const asserted = (normalizedShared.assertions ?? []).map((a) => ({ ...a }));
  for (const item of extension) {
    const id = typeof item.id === "string" && item.id.trim() ? item.id : `a${asserted.length + 1}`;
    if (item.target !== undefined && typeof item.target !== "string") {
      errors.push({ error: `acceptance '${id}' target must be a string when present` });
    }
    // Each card kind has its own required field. A command may have no named
    // target on a portable card (the harness invocation IS the command), an
    // output check needs the needle, and the file kinds need both a path and
    // the value to look for. Requiring the wrong field rejects correct
    // declarations — which is what the first version of this helper did.
    if (item.kind === "output-contains" && (typeof item.expect !== "string" || !item.expect.trim())) {
      errors.push({ error: `acceptance '${id}' (output-contains) needs an expect string` });
    }
    if (item.kind === "file-contains" && (typeof item.target !== "string" || !item.target.trim())) {
      errors.push({ error: `acceptance '${id}' (file-contains) needs a target path` });
    }
    if (item.kind === "file-contains" && (typeof item.expect !== "string" || !item.expect.trim())) {
      errors.push({ error: `acceptance '${id}' (file-contains) needs an expect string` });
    }
    if (item.kind === "artifact-exists" && (typeof item.target !== "string" || !item.target.trim())) {
      errors.push({ error: `acceptance '${id}' (artifact-exists) needs a target path` });
    }
    if (item.kind === "exit-code" && !Number.isFinite(Number(item.expect))) {
      errors.push({ error: `acceptance '${id}' (exit-code) needs a numeric expect` });
    }
    asserted.push({ id, kind: item.kind, target: item.target ?? null, expect: item.expect ?? null });
  }
  const judged = asserted.filter((a) => a.kind === "llm-judged");
  if (judged.length > JUDGE_ASSERTION_CAP) {
    errors.push({ error: `this flow station declares ${judged.length} llm-judged assertions, over the cap of ${JUDGE_ASSERTION_CAP} (each one is a model call) — merge or drop some` });
  }
  return { assertions: asserted, errors };
}

// A station id is a slug — it is addressed by humans in URLs and by the flow
// layer in dependency keys, so whitespace and path separators are refused
// rather than normalized (a normalized id is an id two callers disagree about).
const STATION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Validate a flow declaration. Pure — no IO, no storage.
 *
 * Returns { ok, errors, errors[] } where each error names the offending field
 * and the legal values. A declaration that fails MUST NOT be partially written:
 * the caller writes nothing unless ok.
 */
export function validateFlowDeclaration(declaration) {
  const errors = [];
  const fail = (field, error) => errors.push({ field, error });

  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    return { ok: false, errors: [{ field: "(root)", error: "flow declaration must be an object" }] };
  }

  const id = declaration.flowId ?? declaration.id;
  if (typeof id !== "string" || !STATION_ID_RE.test(id)) {
    fail("flowId", `flowId must match ${STATION_ID_RE} (lowercase slug, 1-64 chars)`);
  }

  const name = declaration.name;
  if (typeof name !== "string" || name.trim() === "") {
    fail("name", "name must be a non-empty string");
  }

  const stations = declaration.stations;
  if (!Array.isArray(stations) || stations.length === 0) {
    fail("stations", "a flow needs at least one station");
  } else {
    const seen = new Set();
    stations.forEach((s, i) => {
      const at = `stations[${i}]`;
      if (!s || typeof s !== "object" || Array.isArray(s)) {
        fail(at, "station must be an object");
        return;
      }
      const sid = s.stationId ?? s.id;
      if (typeof sid !== "string" || !STATION_ID_RE.test(sid)) {
        fail(`${at}.stationId`, `stationId must match ${STATION_ID_RE}`);
      } else if (seen.has(sid)) {
        // The duplicate is named by VALUE: "duplicate station id" alone makes
        // the author re-read the whole list to find which one.
        fail(`${at}.stationId`, `duplicate station id '${sid}'`);
      } else {
        seen.add(sid);
      }
      if (s.label != null && typeof s.label !== "string") {
        fail(`${at}.label`, "label must be a string when present");
      }
      const target = s.target;
      if (!target || typeof target !== "object") {
        fail(`${at}.target`, "station needs a target { kind, ref }");
      } else {
        const kind = target.kind;
        if (!STATION_TARGET_KINDS.includes(kind)) {
          // Position names ("fleet-member", "岗位") are a distinct mistake from
          // a typo, and they deserve a distinct sentence: a post is not a kind,
          // it materializes into one of these.
          fail(
            `${at}.target.kind`,
            kind === "fleet-member" || kind === "member"
              ? `'${kind}' is a position, not a target kind — a fleet post materializes into one of ${STATION_TARGET_KINDS.join("|")}`
              : `target.kind must be one of ${STATION_TARGET_KINDS.join("|")}`,
          );
        }
        if (target.ref != null && typeof target.ref !== "string") {
          fail(`${at}.target.ref`, "target.ref must be a string when present");
        }
      }
      // Acceptance is optional, but when declared it goes through the platform's
      // assertion normalizer (shape + judge tier + cost cap), widened only by
      // the card-level machine kinds above. Its error strings already name the
      // entry, so they are surfaced verbatim rather than re-worded.
      if (s.acceptance != null) {
        const normalized = normalizeCardAcceptance(s.acceptance);
        for (const e of normalized.errors ?? []) {
          fail(`${at}.acceptance`, e.error ?? String(e));
        }
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Normalize a validated declaration into the stored shape. Key order and
 * defaults live here so the write face and the reader cannot disagree about
 * what an omitted field means.
 */
export function normalizeFlowDeclaration(declaration) {
  const stations = (declaration.stations ?? []).map((s) => ({
    stationId: s.stationId ?? s.id,
    label: s.label ?? null,
    target: { kind: s.target.kind, ref: s.target.ref ?? null },
    acceptance: s.acceptance == null ? [] : (normalizeCardAcceptance(s.acceptance).assertions ?? []),
  }));
  return {
    flowId: declaration.flowId ?? declaration.id,
    name: declaration.name,
    stations,
  };
}

/**
 * Resolve a station's target into an executable assignment.
 *
 * Returns { ok: true, target: { kind, ref, personaBacked } } or
 * { ok: false, reason } naming exactly what is missing. There is no default:
 * an unresolvable station is a vacant post, not a task to be handed to whatever
 * runtime happens to be live.
 *
 * `exists` is injected — { persona(ref) -> bool, a2a(ref) -> bool,
 * cluster(ref) -> bool, tool(ref) -> bool }. A missing checker is treated as
 * "cannot prove it exists", which refuses rather than assumes.
 */
export function resolveStationTarget(station, { exists = {} } = {}) {
  const target = station?.target;
  if (!target || typeof target !== "object") {
    return { ok: false, reason: "station has no target" };
  }
  const { kind, ref } = target;
  if (!STATION_TARGET_KINDS.includes(kind)) {
    return { ok: false, reason: `unknown target kind '${kind}' (supported: ${STATION_TARGET_KINDS.join("|")})` };
  }
  if (!ref) {
    return { ok: false, reason: `station target ${kind} has no ref` };
  }
  const checker = exists[kind];
  if (typeof checker !== "function") {
    return { ok: false, reason: `cannot resolve target kind '${kind}': no existence checker supplied` };
  }
  if (!checker(ref)) {
    return { ok: false, reason: `${kind} '${ref}' does not exist in this cell` };
  }
  return {
    ok: true,
    target: {
      kind,
      ref,
      // `auditor` is persona-backed: routing it through the persona lane keeps
      // it working exactly like `persona`, and is why this is a predicate call
      // and not a `=== "persona"` comparison.
      personaBacked: isPersonaBackedTargetKind(kind),
    },
  };
}

/**
 * Stamp a station's acceptance onto a card at dispatch time.
 *
 * The predicate must exist BEFORE the executor starts — an executor that
 * supplies its own criteria at completion is grading its own homework, and the
 * whole point of this change is that `done` stops meaning "the executor says
 * so". Once stamped, later edits to the flow declaration do not reach this
 * card: they apply to cards dispatched afterwards. That asymmetry is deliberate
 * and is why this is stored on the record rather than looked up at accept time.
 *
 * Returns the flow attribution to write; `existing` is the card's current flow
 * field (null for a card entering a flow for the first time).
 */
export function stampAcceptance(flowAttribution, station) {
  const now = new Date().toISOString();
  return {
    ...(flowAttribution ?? {}),
    stationId: station.stationId,
    // A COPY, not the declaration's array. Sharing it would mean a later edit
    // to the flow silently rewrites criteria on cards that were already
    // dispatched — the exact "graded after the fact" failure the stamp exists
    // to prevent (caught by the independence test).
    acceptance: JSON.parse(JSON.stringify(station.acceptance ?? [])),
    stakedAt: now,
  };
}

/**
 * Reassign a card to another station (or another flow's station).
 *
 * This is an IN-PLACE rewrite, the same semantics fleet-reconcile established
 * for carrier changes ("换身体不换会话"): the task id, its bound session and its
 * execution history all stay put. A "takeover" is not a move — a move would
 * break resume, and the next process would look for a task that no longer
 * exists.
 *
 * Everything happens on a COPY of the attribution: a station that cannot be
 * resolved leaves the card exactly where it was. A half-applied reassignment
 * would leave the card in neither station, which is worse than a refusal.
 *
 * Returns { ok, flow } or { ok: false, reason }.
 */
export function reassignCard({ current, station, resolve = null }) {
  if (!station?.stationId) return { ok: false, reason: "target station is required" };
  if (resolve) {
    const r = resolve(station);
    if (!r?.ok) return { ok: false, reason: r?.reason ?? "target station cannot be resolved" };
  }
  const next = stampAcceptance(
    {
      ...(current ?? {}),
      // A reassignment is a fresh start at a new station: the previous station's
      // verdict does not travel. It stays in the card's history (and in the
      // reassignment trail), but it must not be read as a verdict on THIS work.
      verdict: null,
    },
    station,
  );
  return { ok: true, flow: next };
}


/**
 * Collect the evidence a station's predicates are judged against.
 *
 * Deliberately narrow: this reads the executor's OBSERVABLE output, never its
 * prose. The shape is the engine's OWN history entry, not an invented one —
 * measured on a real turn (2026-11-19): `{state, success, text, duration}`.
 * A predicate that read a field the engine does not write (an `exitCode` that
 * never exists) would be a check nobody can ever pass, which is worse than no
 * check at all — it reads as "the work failed" forever.
 */
export function evidenceFromExecution({ history = [], artifacts = [], facts = {} } = {}) {
  const last = Array.isArray(history) ? history[history.length - 1] : null;
  return {
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    // The engine's own verdict on the turn. `success` is what a `done` entry
    // carries; a failed/interrupted entry carries false.
    success: last?.success === true,
    state: typeof last?.state === "string" ? last.state : null,
    // The turn's output text — what a tool round returns, what a persona turn
    // said. `output-contains` reads this.
    output: typeof last?.text === "string" ? last.text : "",
    facts: facts ?? {},
  };
}


/**
 * Evaluate a station's acceptance against evidence the executor produced.
 *
 * Three outcomes, never two:
 *   "pass"      every declared assertion passed
 *   "fail"      at least one declared assertion failed (items detail which)
 *   "no-criteria" the station declared nothing — NOT a pass
 *
 * Machine assertions and judge assertions are reported in separate lists so a
 * reader can tell "the machine checked it" from "a model read it". Collapsing
 * them would make the strongest claim in this whole change — that done means
 * verified — unfalsifiable.
 *
 * `judge` is injected: (rubric, evidence) -> boolean. Absent judge = a judge
 * assertion is "unevaluated", which fails closed: an unrun check is not a pass.
 */
export function evaluateAcceptance(acceptance, evidence, { judge = null } = {}) {
  const declared = Array.isArray(acceptance) ? acceptance : [];
  if (declared.length === 0) {
    return { outcome: "no-criteria", machine: [], judged: [], failed: [], unknown: [] };
  }

  const machine = [];
  const judged = [];
  const failed = [];
  const unknown = [];

  for (const a of declared) {
    const id = a?.id ?? "(unnamed)";
    if (a?.kind === "llm-judged") {
      if (typeof judge !== "function") {
        const item = { id, kind: "llm-judged", outcome: "unknown", reason: "no judge supplied" };
        judged.push(item);
        unknown.push(item);
        continue;
      }
      const passed = judge(a.rubric, evidence) === true;
      const item = { id, kind: "llm-judged", outcome: passed ? "pass" : "fail" };
      judged.push(item);
      if (!passed) failed.push(item);
      continue;
    }
    // Machine assertions read evidence directly — an executor's prose can
    // never satisfy one. `null` means the check could not be evaluated; it is
    // unknown, never a pass and never a fabricated failure.
    const verdict = machineAssertionPasses(a, evidence);
    const outcome = verdict === null ? "unknown" : verdict ? "pass" : "fail";
    const item = { id, kind: a?.kind ?? "unknown", outcome };
    machine.push(item);
    if (outcome === "fail") failed.push(item);
    if (outcome === "unknown") unknown.push(item);
  }

  return {
    outcome: failed.length > 0 ? "fail" : unknown.length > 0 ? "unknown" : "pass",
    machine,
    judged,
    failed,
    unknown,
  };
}

// Machine assertion kinds come from the ONE normalizer that defines them
// (`blueprint-validate.js`). Each branch reads EVIDENCE — an executor's prose
// can never satisfy one.
//
// `artifact-exists` / `command-succeeds` / `output-contains` are the shape a
// task-produced card can offer; the fleet-post assertions (post-materialized,
// first-round-fired, report-landed) are satisfied by the task/run facts the
// caller feeds in. Anything else fails closed: a check nobody can run is not a
// check that passed.
function machineAssertionPasses(assertion, evidence) {
  const ev = evidence ?? {};
  const facts = ev.facts ?? {};
  switch (assertion?.kind) {
    case "artifact-exists": {
      const path = assertion.target;
      const artifacts = Array.isArray(ev.artifacts) ? ev.artifacts : [];
      return artifacts.some((a) => a?.path === path && (a?.bytes ?? 0) > 0);
    }
    case "command-succeeds":
      // "The turn ran and ended successfully." The engine records exactly this
      // as `success` on the history entry; there is no shell and no exit code.
      return ev.success === true;
    case "output-contains": {
      const needle = assertion.expect;
      if (typeof needle !== "string" || typeof ev.output !== "string") return null;
      return ev.output.includes(needle);
    }
    // Portable kinds: read a real file / a real exit code. A path outside the
    // declared workspace or an unreadable file is unknown, not a failure.
    case "file-contains": {
      const root = typeof facts.workspace === "string" && facts.workspace ? facts.workspace : process.cwd();
      const text = readInside(root, assertion.target);
      if (text === null) return null;
      return typeof assertion.expect === "string" && text.includes(assertion.expect);
    }
    case "exit-code": {
      if (!Number.isFinite(Number(facts.exitCode))) return null;
      return Number(facts.exitCode) === Number(assertion.expect);
    }
    case "post-materialized":
      return facts.postMaterialized === true;
    case "first-round-fired":
      return facts.firstRoundFired === true;
    case "report-landed":
      return facts.reportLanded === true;
    case "escalate-bounded":
      return Number.isFinite(facts.escalations) && facts.escalations <= Number(assertion.expect);
    default:
      return null;
  }
}

// Read a card artifact inside its workspace. Any escape or read failure is
// `null` — the check could not run, which is unknown rather than a pass.
function readInside(root, rel) {
  if (typeof rel !== "string" || !rel) return null;
  const base = path.resolve(root);
  const absolute = path.resolve(base, rel);
  if (absolute !== base && !absolute.startsWith(base + path.sep)) return null;
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}
