// Publish checklist (complete-creator-loop D1). The FOUR gates that decide a
// publish already exist and already block it — two client pre-checks
// (tool-surface closure, vocabulary), one server answer (official en-coverage),
// and the manifest validator. What was missing is a single place that says
// "here is what is left, and here is where to fix it": before this, the two
// client gates only spoke at the moment you pressed publish, as one sentence
// naming the offenders, with no way to jump to them.
//
// This module is pure aggregation, in lib/ so node --test can pin it. It adds
// NO gate: every row it emits is a condition some other layer already enforces
// (design D1 — a second implementation of four rules would drift from them the
// way the two tab tables did before unify-line-board-tabs).

export type ChecklistGate = "toolsFace" | "vocabulary" | "enCoverage" | "manifest";

export interface ChecklistRow {
  /** Which gate this row comes from — the grouping key in the panel. */
  gate: ChecklistGate;
  /** Stable per-row id for test ids and React keys. */
  id: string;
  /** The offending name/path, shown verbatim so the reader can find it. */
  subject: string;
  /** True when the creating surface has a field to jump to for this subject. */
  locatable: boolean;
}

export interface ChecklistInput {
  /** MCP references picked on the draft. */
  mcpPicked: string[];
  /** Per-server allowlist; an empty list means "not decided yet". */
  mcpTools: Record<string, string[] | undefined>;
  /** Per-server reason for a deliberate full surface. */
  fullSurfaceReasons: Record<string, string | undefined>;
  /** Declared vocabulary slugs (empty when the fetch failed — then no
   *  vocabulary rows at all, since we cannot judge without the table). */
  vocabularySlugs: string[];
  domainPicks: string[];
  audiencePicks: string[];
  /** Advisory coverage from the server's one denominator. Missing/null means
   *  the read failed: no coverage rows rather than an invented verdict. */
  coverage: { total: number; covered: number; missing: string[] } | null;
}

/** Servers whose tool surface is undecided: no allowlist AND no non-blank
 *  full-surface reason. Mirrors the publish-time pre-check verbatim. */
export function undecidedFaceServers(input: ChecklistInput): string[] {
  return input.mcpPicked.filter((registryName) => {
    if ((input.mcpTools[registryName] ?? []).length > 0) return false;
    if (!(registryName in input.fullSurfaceReasons)) return true;
    return (input.fullSurfaceReasons[registryName] ?? "").trim().length === 0;
  });
}

/** Picks that are outside the declared vocabulary. Judged only when the
 *  vocabulary actually loaded — an empty table means "unknown", not "all bad". */
export function outOfVocabularyPicks(input: ChecklistInput): string[] {
  if (input.vocabularySlugs.length === 0) return [];
  const allowed = new Set(input.vocabularySlugs);
  const bad = [...input.domainPicks, ...input.audiencePicks].filter((v) => !allowed.has(v));
  return [...new Set(bad)];
}

/**
 * The checklist the creator sees before publishing. Empty array = nothing
 * outstanding in the four gates this surface can judge locally.
 */
export function buildChecklist(input: ChecklistInput): ChecklistRow[] {
  const rows: ChecklistRow[] = [];

  for (const server of undecidedFaceServers(input)) {
    rows.push({ gate: "toolsFace", id: `toolsFace:${server}`, subject: server, locatable: true });
  }

  for (const value of outOfVocabularyPicks(input)) {
    rows.push({ gate: "vocabulary", id: `vocabulary:${value}`, subject: value, locatable: true });
  }

  // Coverage rows: only the ones the workbench can actually point at. A path
  // without a field (e.g. a guide step that no longer exists) is still listed —
  // the creator should know it is missing — but marked unlocatable rather than
  // rendering a jump that goes nowhere.
  for (const path of input.coverage?.missing ?? []) {
    rows.push({ gate: "enCoverage", id: `enCoverage:${path}`, subject: path, locatable: true });
  }

  return rows;
}

/** A server refusal, mapped into the same row shape so the panel never has two
 *  vocabularies for one problem (spec: every refusal is locatable). */
export function rowsFromRefusal(refusal: {
  code?: string;
  message?: string;
  missing?: string[];
}): ChecklistRow[] {
  if (refusal.code === "official_en_coverage_incomplete" && refusal.missing?.length) {
    return refusal.missing.map((path) => ({
      gate: "enCoverage" as const,
      id: `enCoverage:${path}`,
      subject: path,
      locatable: true,
    }));
  }
  // Any other refusal (manifest shape, limits, a gate added later) becomes one
  // unlocatable row carrying the server's own words — we do not paraphrase and
  // we do not pretend to know which field it means.
  const message = (refusal.message ?? "").trim();
  if (!message) return [];
  return [{ gate: "manifest", id: `manifest:${message}`, subject: message, locatable: false }];
}

/** Grouped, in a fixed gate order so the panel's reading order is stable. */
export const GATE_ORDER: ChecklistGate[] = ["toolsFace", "vocabulary", "enCoverage", "manifest"];

export function groupChecklist(rows: ChecklistRow[]): { gate: ChecklistGate; rows: ChecklistRow[] }[] {
  return GATE_ORDER.map((gate) => ({ gate, rows: rows.filter((r) => r.gate === gate) })).filter(
    (group) => group.rows.length > 0,
  );
}
