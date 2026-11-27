// Official starter → workspace document seeds (add-agent-builder-workspace
// 8.2). The marketplace's official blueprint segment IS the shared list the
// design note asked for ("清单与货架侧共定") — no second list, no new endpoint:
// the public GET /api/packs/official already answers it, and GET /api/packs/:id
// carries the manifest a seed projects from. The projection is a pure client
// function: manifest fields land in the document where the validator expects
// them, everything the document vocabulary has no bucket for is dropped
// loudly-softly (absent, not renamed) — a seed must validate clean.

import type { BlueprintContent } from "@/lib/blueprint-api";

export interface StarterSummary {
  id: string;
  name: string;
  description?: string;
  category?: string;
  version?: number;
}

export async function listOfficialStarters(): Promise<StarterSummary[]> {
  const r = await fetch("/api/packs/official");
  if (!r.ok) return [];
  const d = (await r.json().catch(() => ({}))) as { templates?: StarterSummary[] };
  return (d.templates ?? []).map((t) => ({ ...t, category: t.category ?? "fleet" }));
}

interface PackManifestShape {
  name?: string;
  description?: string;
  agents?: { id?: string; name?: string; persona?: string }[];
  fleet?: BlueprintContent["fleet"];
  mcpServers?: BlueprintContent["mcpServers"];
  skills?: BlueprintContent["skills"];
}

interface PackDetailShape {
  pack?: { manifest?: PackManifestShape };
  manifest?: PackManifestShape;
}

// manifest → document seed. The manifest IS the provisioner contract, so the
// fleet/agents sections ride verbatim (same shape the cast path emits); the
// boundary comes from the pack's name/one-liner — a document needs a scene
// name and the pack display name is the honest one.
export function manifestToDocSeed(manifest: PackManifestShape | null | undefined): BlueprintContent | null {
  if (!manifest || typeof manifest !== "object") return null;
  const agents = Array.isArray(manifest.agents) ? manifest.agents : [];
  const fleet = manifest.fleet;
  const hasFleet = !!(fleet && Array.isArray(fleet.members) && fleet.members.length > 0);
  if (!hasFleet && agents.length === 0) return null;
  const name = typeof manifest.name === "string" ? manifest.name : "";
  if (!name.trim()) return null;
  const seed: BlueprintContent = {
    kind: "team",
    boundary: { name, oneLine: typeof manifest.description === "string" ? manifest.description : "", outOfScope: "" },
    dataSources: [],
    skills: Array.isArray(manifest.skills) ? manifest.skills : [],
    agents: agents.map((a, i) => ({
      id: typeof a.id === "string" && a.id.trim() ? a.id : `agent-${i + 1}`,
      name: typeof a.name === "string" ? a.name : "",
      persona: typeof a.persona === "string" ? a.persona : "",
    })),
    mcpServers: Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [],
    monitoring: {},
    acceptance: [],
    board: {},
  };
  if (hasFleet) seed.fleet = fleet;
  return seed;
}

export async function fetchStarterSeed(packId: string): Promise<BlueprintContent | null> {
  const r = await fetch(`/api/packs/${encodeURIComponent(packId)}`);
  if (!r.ok) return null;
  const d = (await r.json().catch(() => null)) as PackDetailShape | null;
  const manifest = d?.pack?.manifest ?? d?.manifest ?? null;
  return manifestToDocSeed(manifest);
}
