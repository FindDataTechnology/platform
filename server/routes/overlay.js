// Focus overlay API (add-focus-overlay, design D3).
//
// GET /api/agent/overlay?preset=<id> — the single source the web 资源微调
// panel composes its view from: the stored preference diff, the role's
// effective set (derived ± overlay, name lists only), and the addable
// universes (enabled/visible servers, locally available skills).
//
// PUT /api/agent/overlay — validates + stores the diff, then rides the
// serialized runtime-mutation path: rejected while a turn streams (the
// set_preset guard), and when the adjusted preset is the live one both patch
// files are rewritten and the idle child restarted so the NEXT session
// composes adjusted — the same sequence a preset switch rides. Adjustments
// are deployment-global (v1 ceiling, like preset selection): every client
// sees the same set, and `overlay_changed` tells them to refresh.
//
// Auth: the standard HTTP identity gate answers 401 before these run when
// auth is enabled; with auth off the requester is the machine owner — the
// same semantics as every roster-level route.

import { readFileSync } from "node:fs";
import path from "node:path";
import { getFileSkills } from "../skills.js";
import * as dshProfile from "../../dsh-profile.js";
import * as registryCredentials from "../../registry-credentials.js";

const MCP_CONFIG_PATH = path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");

// The operator's mcp.json server names (the baseline's operator layer).
function mcpJsonNames() {
  try {
    return Object.keys(JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8")).mcpServers ?? {});
  } catch {
    return [];
  }
}

// PACK_BASELINE_MCP names (mirrors dsh-profile's private baselineMcpNames).
function baselineNames() {
  return (process.env.PACK_BASELINE_MCP || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

// The addable-server universe: every server the composing identity could
// already use — mcp.json (operator layer) plus DB rows that are enabled,
// visible to the runtime owner's groups, and credential-resolvable. This is
// the availability/group/credential-filtered map writeMcpPatch captures
// before focus, computed name-only here (no patch write for a GET).
function availableMcpNames(ctx) {
  const names = new Set(mcpJsonNames());
  // The composing identity's inputs — same semantics the patch writer applies
  // (null = no snapshot yet / auth off ⇒ no group filtering).
  const groups = ctx.runtimeOwnerGroups ?? null;
  if (ctx.db.isDbReady()) {
    let liveToken = null;
    try {
      liveToken = registryCredentials.liveToken(ctx.runtimeOwnerEmail ?? null);
    } catch { liveToken = null; }
    for (const row of ctx.extensionStore.listMcpServers()) {
      if (row.enabled === false) continue;
      if (row.requiredGroups?.length && groups !== null &&
          !groups.some((g) => row.requiredGroups.includes(g))) continue;
      let resolvable = true;
      try {
        resolvable = !registryCredentials.isRegistryRef(row.config) || !!liveToken;
      } catch { /* an unknown ref shape composes as-is — the writer decides */ }
      if (resolvable) names.add(row.name);
    }
  }
  return names;
}

export function registerOverlayRoutes(ctx) {
  const { app, db, broadcast } = ctx;

  // Effective set + universes for one focused role. The overlay applies to
  // pack personas and custom presets (add-custom-presets — a custom preset is
  // a focused role like any other); a shipped preset keeps the availability
  // semantics, so the route rejects one (the panel never offers it).
  app.get("/api/agent/overlay", async (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Overlay management is disabled (database unavailable)" });
    }
    const preset = String(req.query.preset || "").trim();
    if (!preset) return res.status(400).json({ error: "preset is required" });
    const scope = await dshProfile.deriveScope(preset);
    if (!scope.packId && scope.source !== "custom") {
      return res.status(400).json({ error: `preset "${preset}" is not a focused role` });
    }
    const overlay = db.getFocusOverlay(preset);
    const available = availableMcpNames(ctx);

    // Effective MCP names — the same composition writeMcpPatch performs:
    // operator baseline ∪ resolvable PACK_BASELINE_MCP ∪ pack refs, then the
    // overlay's add (from available) and remove.
    const effectiveMcp = new Set(mcpJsonNames());
    for (const name of baselineNames()) if (available.has(name)) effectiveMcp.add(name);
    for (const name of scope.mcpKeep ?? []) if (available.has(name)) effectiveMcp.add(name);
    if (overlay) {
      for (const name of overlay.addMcp ?? []) if (available.has(name)) effectiveMcp.add(name);
      for (const name of overlay.removeMcp ?? []) effectiveMcp.delete(name);
    }

    // Effective skills — the deployment's baseline file skills (fixed for
    // every mode, never overlay-adjustable) shown separately, plus the role's
    // set: a pack persona's declared ∩ owned (or the whole-pack owned set
    // when undeclared); a custom preset's references ∩ the whole enabled
    // universe (composition-time truth); both ± overlay — the same effective
    // list the compose root builds (adds draw from every enabled materialized
    // row, any pack or the user root).
    const allSkillRows = db.listCustomSkills().filter((s) => s.enabled !== false);
    const owned = new Set(
      (scope.source === "custom" ? allSkillRows : allSkillRows.filter((s) => s.originPackId === scope.packId))
        .map((s) => s.name),
    );
    let roleSkills = Array.isArray(scope.skillsDecl)
      ? scope.skillsDecl.filter((n) => owned.has(n))
      : [...owned];
    if (overlay) {
      const removed = new Set(overlay.removeSkills ?? []);
      roleSkills = roleSkills.filter((n) => !removed.has(n));
      const availableSkill = new Set(allSkillRows.map((s) => s.name));
      for (const name of overlay.addSkills ?? []) {
        if (availableSkill.has(name) && !roleSkills.includes(name)) roleSkills.push(name);
      }
    }
    const baselineSkills = getFileSkills().map((s) => s.name);
    const addableSkills = [...new Set(allSkillRows.map((s) => s.name))];

    res.json({
      preset,
      overlay,
      effective: {
        mcpServers: [...effectiveMcp],
        skills: roleSkills,
        baselineSkills,
      },
      addableMcp: [...available].filter((n) => !effectiveMcp.has(n)),
      addableSkills: addableSkills.filter((n) => !roleSkills.includes(n) && !baselineSkills.includes(n)),
    });
  });

  // Store a diff. Validation rejects a malformed shape naming the field and a
  // name present in both add and remove for a dimension — the client resolves
  // the ambiguity, never the composer.
  app.put("/api/agent/overlay", async (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Overlay management is disabled (database unavailable)" });
    }
    const { preset, overlay } = req.body || {};
    if (!preset || typeof preset !== "string") {
      return res.status(400).json({ error: "preset is required" });
    }
    const scope = await dshProfile.deriveScope(preset);
    if (!scope.packId && scope.source !== "custom") {
      return res.status(400).json({ error: `preset "${preset}" is not a focused role` });
    }
    const parsed = db.parseFocusOverlay(overlay);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    // The set_preset guard: an adjustment never interleaves with a turn it
    // was not visible to.
    if (ctx.isStreaming) {
      return res.status(409).json({ error: "Cannot adjust resources while the agent is responding" });
    }

    const apply = async () => {
      db.setFocusOverlay(preset, parsed.overlay);
      // The adjusted preset composes with its overlay at its next switch/boot
      // regardless; when it is the LIVE preset the rewrite + idle restart
      // make the next session of THIS runtime compose adjusted (the preset
      // switch's own sequence). ctx.currentPreset holds the roster/dash form
      // of a dotted id (custom presets) — compare through the mapping.
      if (dshProfile.rosterPresetId(preset) === ctx.currentPreset) {
        await dshProfile.writeMcpPatch({
          mcpOverlay: ctx.runtimeMcpOverlay ?? null,
          userGroups: ctx.runtimeOwnerGroups ?? null,
          ownerEmail: ctx.runtimeOwnerEmail,
          agentPreset: preset,
        });
        await dshProfile.writeSkillsPatch({ agentPreset: preset });
        if (ctx.dshBridge?.isReady?.() && !ctx.isStreaming) {
          await ctx.dshBridge.restart({});
        }
      }
      // Deployment-global: every client's view refreshes from the same diff.
      broadcast({ type: "overlay_changed", preset, overlay: db.getFocusOverlay(preset) });
    };
    if (ctx.runExclusiveRuntimeMutation) await ctx.runExclusiveRuntimeMutation(apply);
    else await apply();
    res.json({ ok: true, overlay: db.getFocusOverlay(preset) });
  });
}
