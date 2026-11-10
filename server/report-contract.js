// Report contract (enforce-report-contract).
//
// The fleet's own template says it in words: 34 of 35 posts carry
// 「收尾必 report_status」. Production ran 516 turns in 24h and filed 119
// reports (0.23/turn) — three quarters of the rounds that DID run delivered
// nothing, and settlement never noticed: `ok` meant "the loop ended", not "the
// post did its job".
//
// HOW THE CONTRACT IS KNOWN (this took a production check to get right):
//   the persona text does NOT come from the platform catalog — that catalog is
//   empty in a live cell (`getChatAgentEntries()` returned 0) and every preset
//   resolves to null there. The text the runtime actually runs is composed into
//   `dsh/profiles/<name>/presets.patch.yml` (`config.plugins[].config.prefix`)
//   by writePresetsPatchSync. So the contract is decided ONCE, at composition
//   time, in the same process that later settles the turns — and published here.
//   Settlement then reads a published fact: no per-turn regex over 4KB of prose,
//   no 380KB YAML parse, no cross-process file read.
export const REPORT_CONTRACT_RE = /必\s*report_status|收尾必|必须.{0,8}report_status/;

// Does this persona text require a report every round?
// true  → the post owes a report_status call on every successful round
// false → it does not (e.g. a content post that only runs when delegated)
export function declaresReportContract(personaText) {
  if (!personaText || typeof personaText !== "string") return false;
  return REPORT_CONTRACT_RE.test(personaText);
}

// presetId → "required" | null, published by the profile composer.
const contracts = new Map();

export function clearReportContracts() {
  contracts.clear();
}

export function setReportContracts(entries) {
  contracts.clear();
  for (const [id, verdict] of Object.entries(entries ?? {})) {
    if (id) contracts.set(id, verdict === "required" ? "required" : null);
  }
}

// Build the map from the composer's preset definitions ({ id, persona }[]) and
// publish it. Returns what was published so the composer can log the count.
export function publishReportContracts(defs = []) {
  const map = {};
  for (const d of defs) {
    if (!d?.id) continue;
    map[d.id] = declaresReportContract(d.persona) ? "required" : null;
  }
  setReportContracts(map);
  return map;
}

// Unknown preset → null (no contract). An unknown post must never be accused of
// skipping a duty it may not have declared — the same degrade-open rule the rest
// of this codebase uses for attribution.
export function reportContractFor(presetId) {
  if (!presetId) return null;
  return contracts.get(presetId) ?? null;
}

// The three-state judgement (design D3), kept as one testable predicate:
//   • only a SUCCESSFUL round can break a delivery contract (a failed or
//     interrupted round never got the chance);
//   • only a post that DECLARED the contract can break it;
//   • `reported` must be false — a completed report_status counts, a rejected
//     one does not (the downstream never received it).
export function isMissingReport({ status = null, reportContract = null, reported = false } = {}) {
  if (status !== "ok") return false;
  if (reportContract !== "required") return false;
  return reported !== true;
}
