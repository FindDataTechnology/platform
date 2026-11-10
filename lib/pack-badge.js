// Pack type badge derivation (add-ai-native-lexicon): one computed badge per
// market entry, derived from manifest STRUCTURE at read time — authors neither
// set nor override it. Precedence: blueprint (fleet/cluster organization
// block) → facade (facade block or any agent carrying a serving contract) →
// assistant (agents, no organization/facade) → toolkit (no agents).
//
// Two call shapes share this derivation:
//   deriveBadge(manifest)              — a parsed manifest object
//   badgeFromFlags({ has_fleet, has_cluster, is_facade, has_serving, agent_count })
//                                      — SQL-projected flags from the list query
// Both MUST stay projections of the same precedence; tests pin the matrix.

export function deriveBadge(manifest) {
  const m = manifest && typeof manifest === "object" ? manifest : {};
  if (m.fleet != null || m.cluster != null) return "blueprint";
  const agents = Array.isArray(m.agents) ? m.agents : [];
  if (m.facade != null || agents.some((a) => a && typeof a === "object" && a.serving != null)) {
    return "facade";
  }
  if (agents.length > 0) return "assistant";
  return "toolkit";
}

export function badgeFromFlags(row) {
  if (row.has_fleet || row.has_cluster) return "blueprint";
  if (row.is_facade || row.has_serving) return "facade";
  if (Number(row.agent_count) > 0) return "assistant";
  return "toolkit";
}
