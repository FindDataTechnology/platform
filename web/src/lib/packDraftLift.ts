// ── Draft → manifest assembly helpers (overhaul-market-catalog-presentation
// 4.7/4.8) ──────────────────────────────────────────────────────────────────
//
// The two rules this module owns, both unit-testable WITHOUT a DOM:
//   1. 不写翻译不产生空 i18n 键 — the workbench's en track serializes ONLY
//      non-empty values; all-or-nothing groups (tags, guide) appear only when
//      EVERY slot is filled, because the validator (and the market read)
//      require exact index alignment — a half-filled group must not be written
//      as an array of empty strings.
//   2. 保存零静默改写 — out-of-vocabulary picks are preserved byte-for-byte in
//      the draft; only PUBLISH consults the vocabulary (4.8), so an author
//      importing a legacy bundle loses nothing on the save path.
//
// Lives beside the compiler (PackDraftsView imports compileDraftManifest);
// kept pure so scripts/ can type-strip-import it.

export interface EnTrackInput {
  name?: string;
  description?: string;
  notes?: string;
  promise?: string;
  /** one input per zh tag, index-aligned. */
  tags?: string[];
  /** one {title, body} pair per zh guide step, index-aligned (three steps). */
  guideSteps?: { title?: string; body?: string }[];
  /** skill name → en description. */
  skills?: Record<string, string>;
  /** agent id → en display name. */
  agents?: Record<string, string>;
  /** bot id → en display name. */
  bots?: Record<string, string>;
  /** registryName → en description (the MCP annotation lane). */
  mcpServers?: Record<string, string>;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Build the i18n.en overlay block from the workbench inputs. Returns null when
// NOTHING was translated — the caller then omits the `i18n` key entirely.
export function assembleEnOverlay(input: EnTrackInput): Record<string, unknown> | null {
  const block: Record<string, unknown> = {};

  for (const key of ["name", "description", "notes", "promise"] as const) {
    const v = trimmed(input[key]);
    if (v) block[key] = v;
  }

  // tags: aligned array — all or nothing (the validator's equal-length rule).
  const tags = (input.tags ?? []).map(trimmed);
  if (tags.length > 0 && tags.every((t) => t !== "")) block.tags = tags;

  // guide: every declared step's every field — all or nothing (one language
  // per card group; a half-translated guide would read as two languages).
  const steps = (input.guideSteps ?? []).map((st) => ({ title: trimmed(st?.title), body: trimmed(st?.body) }));
  if (steps.length > 0 && steps.every((st) => st.title !== "" && st.body !== "")) {
    block.guide = { steps };
  }

  for (const [group, map] of [
    ["skills", input.skills],
    ["agents", input.agents],
    ["bots", input.bots],
    ["mcpServers", input.mcpServers],
  ] as const) {
    const entries = Object.entries(map ?? {})
      .map(([id, v]) => [id, trimmed(v)] as const)
      .filter(([, v]) => v !== "");
    if (entries.length > 0) {
      block[group] =
        group === "skills" || group === "mcpServers"
          ? Object.fromEntries(entries.map(([id, v]) => [id, { description: v }]))
          : Object.fromEntries(entries.map(([id, v]) => [id, { name: v }]));
    }
  }

  return Object.keys(block).length > 0 ? block : null;
}

// 4.8 vocabulary check for the PUBLISH face only (save never rewrites).
// Returns the offending values in author order; empty = publish may proceed.
export function outOfVocabulary(picked: unknown, vocabulary: string[]): string[] {
  if (!Array.isArray(picked)) return [];
  return picked.filter((v) => typeof v !== "string" || !v.trim() || !vocabulary.includes(v.trim()));
}
