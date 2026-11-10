// Pack ↔ viewer relation (polish-material-market-tabs 1.x).
//
// The market used to say nothing about the viewer's own state: an installed
// pack and a never-seen pack rendered identically, so the only way to find out
// was to switch to 我的 and cross-check by hand. This derives the two facts the
// card can honestly state — the installed snapshot's version, and whether the
// listed version is newer — from data both sides already have.
//
// Rules (spec: agent-catalog, the card relation clause):
//   • unknown on EITHER side ⇒ nothing is shown (unknown ≠ zero, unknown ≠ "not
//     installed": a failed install read must not tell a subscriber they own
//     nothing);
//   • the state is informational — it never gates subscribe/install;
//   • comparison is numeric on the published version, never on a timestamp.

export interface PackRelation {
  /** The locally installed snapshot's version, or null when not installed /
   *  unknown. */
  installedVersion: number | null;
  /** The listed version when it is strictly newer than the installed one. */
  updateVersion: number | null;
}

const asVersion = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : null;

export function packRelation(
  listedVersion: number | null | undefined,
  installedVersion: number | null | undefined,
): PackRelation {
  const installed = asVersion(installedVersion);
  if (installed === null) return { installedVersion: null, updateVersion: null };
  const listed = asVersion(listedVersion);
  return {
    installedVersion: installed,
    updateVersion: listed !== null && listed > installed ? listed : null,
  };
}

/** packId → installed version, for the market listing to look up per card.
 *  Rows without a usable version are skipped rather than coerced to 0. */
export function installedVersionMap(
  rows: { packId?: string | null; version?: number | null }[] | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows ?? []) {
    const id = typeof row?.packId === "string" ? row.packId.trim() : "";
    const version = asVersion(row?.version);
    if (id && version !== null) out[id] = version;
  }
  return out;
}
