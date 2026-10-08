// Preset → pack-draft conversion (add-preset-to-pack-bridge, design D1–D6).
//
// One-way bridge from a cell-local custom preset into an ordinary pack draft.
// Migratability is resolved HERE (server judgment, spec: pack-authoring), not
// in the client:
//   skills  — a custom_skills row with origin_pack_id NULL is the author's own
//             and is inlined verbatim (name/description/content); a row with
//             origin_pack_id set is another pack's content and is never
//             carried, only flagged naming the owning pack.
//   servers — a reference migrates only when the name resolves to a
//             registry-origin entry in the merged market catalog — the SAME
//             name-based admission rule pack installs use (installMcpRef).
//             The extension row's own origin column is NOT the judgment: no
//             code path writes "registry" there (pack installs and manual
//             entries both land "user"), which the e2e caught. mcp.json
//             operator servers and hand-entered configs that resolve to no
//             registry entry are flagged.
// The output draft is unremarkable: same shape POST /api/pack-drafts stores,
// no link back to the preset, no synchronization in either direction.

import { refreshRegistry } from "./registry-bridge.js";

// Pack agent ids are author-typed in the editor and must match
// [A-Za-z0-9._-] (1-64) outside the reserved "user." namespace (which is
// exactly where preset ids live). Conversion pre-fills a suggested id from
// the preset's display name; non-ASCII names (e.g. 中文) slug to empty and
// fall back — the author can always edit it.
export function suggestAgentId(name) {
  let slug = String(name || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
  if (slug.startsWith("user.")) slug = slug.slice(5); // reserved namespace (preset ids)
  return slug || "agent";
}

// Compose a pack-draft body plus a conversion report from one custom preset.
// deps (route wires the real sources; tests inject fakes):
//   skills          — enabled custom_skills rows (name, description, content, originPackId)
//   extensions      — extension_configs rows ({ name, type, enabled, origin })
//   operatorNames   — mcp.json operator server names (deployment-level, never market)
//   findMarketEntry — async (name) => market catalog entry | null
//   refresh         — optional pre-resolution refresh (default: registry single-flight;
//                     a failed refresh keeps the last-good snapshot and the
//                     flags tell the truth about what it held)
export async function composePackDraftFromPreset(preset, deps) {
  const {
    skills = [],
    extensions = [],
    operatorNames = [],
    findMarketEntry,
    refresh = refreshRegistry,
  } = deps;
  await refresh().catch(() => {});

  const report = {
    inlinedSkills: [],
    mcpServers: [],
    pendingSkills: [],
    pendingServers: [],
  };
  const draftSkills = [];
  const draftMcp = [];

  const skillByName = new Map(skills.filter((s) => s.enabled !== false).map((s) => [s.name, s]));
  for (const name of preset.skills ?? []) {
    const row = skillByName.get(name);
    if (!row) {
      report.pendingSkills.push({ name, reason: "unavailable" });
    } else if (row.originPackId) {
      report.pendingSkills.push({ name, reason: "pack", pack: row.originPackId });
    } else {
      draftSkills.push({ name: row.name, description: row.description || "", content: row.content || "" });
      report.inlinedSkills.push(row.name);
    }
  }

  const extByName = new Map(
    extensions.filter((c) => c.type === "mcp" && c.enabled !== false).map((c) => [c.name, c]),
  );
  const operatorSet = new Set(operatorNames);
  for (const name of preset.mcpServers ?? []) {
    if (operatorSet.has(name)) {
      report.pendingServers.push({ name, reason: "operator" });
      continue;
    }
    if (!extByName.has(name)) {
      report.pendingServers.push({ name, reason: "unavailable" });
      continue;
    }
    // The market catalog is the migratability source of truth: a registry
    // entry under this name is exactly what a pack's registryName reference
    // would install. No entry — never had one or it left — means replace.
    const entry = await findMarketEntry(name);
    if (entry?.origin === "registry") {
      draftMcp.push({ registryName: name });
      report.mcpServers.push(name);
    } else {
      report.pendingServers.push({ name, reason: "local" });
    }
  }

  const agent = {
    id: suggestAgentId(preset.name),
    name: preset.name,
    persona: preset.persona,
    serving: { protocol: "a2a" },
  };
  if (preset.tags?.length) agent.tags = preset.tags;
  if (preset.icon) agent.icon = preset.icon;

  return {
    draft: {
      name: preset.name,
      description: "",
      tags: preset.tags ?? [],
      entries: { skills: draftSkills, mcpServers: draftMcp, agents: [agent] },
    },
    report,
  };
}
