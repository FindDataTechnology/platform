// Custom preset API (add-custom-presets, design D4).
//
// GET/POST/PUT/DELETE /api/agent/presets — the roster of user-composed
// persona presets. Persona-only: the validator rejects endpoint/model/
// credential-shaped fields exactly like the pack agent validator (a preset is
// a conversational role, never a forwarded endpoint). Ids are server-assigned
// under the reserved `user.` prefix — the author names the preset, the cell
// names the id.
//
// Every mutation rides the serialized runtime-mutation path: rejected while a
// turn streams (the set_preset guard), then catalog refresh (regenerate the
// preset roster; idle restart) + `catalog_changed` broadcast — the same
// sequence a pack install rides. Editing the LIVE preset additionally
// rewrites both patch files (references changed ⇒ the focused set changed);
// deleting the selected preset switches back to the user's own mode first
// (the stale-selection self-heal), so the child never restarts onto a pruned
// preset id.
//
// Auth: the standard HTTP identity gate answers 401 before these run when
// auth is enabled; with auth off the requester is the machine owner. The
// roster is deployment-global state (v1 ceiling, like preset selection and
// overlays) — any authenticated user may manage it.

import { readFileSync } from "node:fs";
import path from "node:path";
import * as db from "../../db.js";
import * as catalog from "../../catalog.js";
import * as skillMaterialize from "../../skill-materialize.js";
import * as dshProfile from "../../dsh-profile.js";
import * as extensionStore from "../../extension-store.js";
import { composePackDraftFromPreset } from "../../preset-pack-bridge.js";

const MCP_CONFIG_PATH = path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");

// Mirrors the pack manifest's limits where the fields coincide (name, persona,
// tags) — one authoring surface, one set of bounds. `maxRefs` bounds each
// reference dimension: the editor renders chips, not essays.
const LIMITS = {
  maxNameChars: 60,
  maxPersonaChars: 16 * 1024,
  maxTags: 10,
  maxTagChars: 24,
  maxRefs: 50,
  maxIconChars: 64,
};

// Keys a preset must NOT carry — persona-only, the same boundary pack agent
// entries enforce (lib/pack-manifest.js AGENT_FORBIDDEN_KEYS).
const FORBIDDEN_KEYS = ["baseUrl", "model", "apiKey", "apiKeyEnv", "local", "url"];

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function parseNameList(input, field) {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: `${field} must be an array of names` };
  if (input.length > LIMITS.maxRefs) {
    return { ok: false, error: `${field} may list at most ${LIMITS.maxRefs} entries` };
  }
  for (const n of input) {
    if (typeof n !== "string" || !NAME_RE.test(n)) {
      return { ok: false, error: `${field} must contain names matching [A-Za-z0-9._-], 1-64 chars` };
    }
  }
  return { ok: true, value: [...new Set(input)] };
}

// Validate + normalize a client-submitted preset. `partial` (PUT) validates
// only the fields present; a full body (POST) requires name + persona and
// defaults both reference dimensions to empty. Returns { ok: true, value } or
// { ok: false, error }.
function validatePresetBody(body, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be an object" };
  }
  const forbidden = FORBIDDEN_KEYS.filter((k) => body[k] !== undefined);
  if (forbidden.length > 0) {
    return { ok: false, error: `custom presets are persona-only (found forbidden key(s): ${forbidden.join(", ")})` };
  }
  const out = {};
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > LIMITS.maxNameChars) {
      return { ok: false, error: `name must be a non-empty string of at most ${LIMITS.maxNameChars} characters` };
    }
    out.name = body.name.trim();
  }
  if (body.persona !== undefined || !partial) {
    if (typeof body.persona !== "string" || !body.persona.trim() || body.persona.length > LIMITS.maxPersonaChars) {
      return { ok: false, error: `persona must be a non-empty string of at most ${LIMITS.maxPersonaChars} characters` };
    }
    out.persona = body.persona;
  }
  for (const field of ["skills", "mcpServers"]) {
    if (body[field] !== undefined) {
      const parsed = parseNameList(body[field], field);
      if (!parsed.ok) return parsed;
      out[field] = parsed.value;
    } else if (!partial) {
      out[field] = [];
    }
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > LIMITS.maxTags) {
      return { ok: false, error: `tags must be an array of at most ${LIMITS.maxTags} strings` };
    }
    for (const t of body.tags) {
      if (typeof t !== "string" || !t.trim() || t.trim().length > LIMITS.maxTagChars) {
        return { ok: false, error: `each tag must be a non-empty string of at most ${LIMITS.maxTagChars} characters` };
      }
    }
    out.tags = [...new Set(body.tags.map((t) => t.trim()))];
  }
  if (body.icon !== undefined) {
    if (body.icon !== null && (typeof body.icon !== "string" || body.icon.length > LIMITS.maxIconChars)) {
      return { ok: false, error: `icon must be a string of at most ${LIMITS.maxIconChars} characters` };
    }
    out.icon = body.icon;
  }
  return { ok: true, value: out };
}

function operatorMcpNames() {
  try {
    return Object.keys(JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8")).mcpServers ?? {});
  } catch {
    return [];
  }
}

// The management page's view: every row plus its composition-time markers.
// Unavailable references name themselves (a pack skill whose pack left, a
// server since uninstalled) so the state is visible without a probe; a
// shadowed id (the operator's file or the cloud holds the same id — the
// merged catalog entry then lacks the customPreset marker) composes full
// under the overriding entry's persona, and the page marks it.
function presetView(row) {
  const skillNames = new Set(
    db.listCustomSkills().filter((s) => s.enabled !== false).map((s) => s.name),
  );
  const serverNames = new Set([
    ...operatorMcpNames(),
    ...db.listExtensionConfigs().filter((c) => c.type === "mcp" && c.enabled !== false).map((c) => c.name),
  ]);
  const entry = catalog.getAgentEntry(row.id);
  return {
    ...row,
    unavailableSkills: row.skills.filter((n) => !skillNames.has(n)),
    unavailableMcpServers: row.mcpServers.filter((n) => !serverNames.has(n)),
    shadowed: !!entry && entry.customPreset !== true,
  };
}

export function registerCustomPresetRoutes(ctx) {
  const { app, db, broadcast } = ctx;

  const dbGate = (_req, res) => {
    if (!db.isDbReady()) {
      res.status(503).json({ error: "Custom presets are disabled (database unavailable)" });
      return false;
    }
    return true;
  };

  app.get("/api/agent/presets", (req, res) => {
    if (!dbGate(req, res)) return;
    res.json({ presets: db.listUserPresets().map(presetView) });
  });

  app.get("/api/agent/presets/:id", (req, res) => {
    if (!dbGate(req, res)) return;
    const row = db.getUserPreset(req.params.id);
    if (!row) return res.status(404).json({ error: "Preset not found" });
    res.json({ preset: presetView(row) });
  });

  app.post("/api/agent/presets", async (req, res) => {
    if (!dbGate(req, res)) return;
    const parsed = validatePresetBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    // The set_preset guard: a roster change never interleaves with a turn it
    // was not visible to.
    if (ctx.isStreaming) {
      return res.status(409).json({ error: "Cannot manage presets while the agent is responding" });
    }
    const apply = async () => {
      const row = db.createUserPreset(parsed.value);
      broadcast({ type: "catalog_changed" });
      // Regenerate the roster's generated presets (the new entry gets one)
      // and restart the idle child so `presets/list` lists it.
      await ctx.syncCatalogAgentPresets?.();
      res.status(201).json({ preset: presetView(row) });
    };
    if (ctx.runExclusiveRuntimeMutation) await ctx.runExclusiveRuntimeMutation(apply);
    else await apply();
  });

  app.put("/api/agent/presets/:id", async (req, res) => {
    if (!dbGate(req, res)) return;
    const existing = db.getUserPreset(req.params.id);
    if (!existing) return res.status(404).json({ error: "Preset not found" });
    const parsed = validatePresetBody(req.body, { partial: true });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (ctx.isStreaming) {
      return res.status(409).json({ error: "Cannot manage presets while the agent is responding" });
    }
    const id = req.params.id;
    const apply = async () => {
      const row = db.updateUserPreset(id, parsed.value);
      broadcast({ type: "catalog_changed" });
      // Regenerates the preset file (persona text) + idle restart.
      await ctx.syncCatalogAgentPresets?.();
      // The edited preset composes with its new references at its next
      // switch/boot regardless; when it is the LIVE preset the rewrite +
      // idle restart make the next session of THIS runtime compose the new
      // set (the same sequence an overlay adjustment rides). ctx.currentPreset
      // holds the roster/dash form of the dotted id — compare through the
      // mapping, and derive the patches under the roster form too (it is what
      // the runtime was switched with).
      if (dshProfile.rosterPresetId(id) === ctx.currentPreset) {
        await dshProfile.writeMcpPatch({
          mcpOverlay: ctx.runtimeMcpOverlay ?? null,
          userGroups: ctx.runtimeOwnerGroups ?? null,
          ownerEmail: ctx.runtimeOwnerEmail,
          agentPreset: ctx.currentPreset,
        });
        await dshProfile.writeSkillsPatch({ agentPreset: ctx.currentPreset });
        if (ctx.dshBridge?.isReady?.() && !ctx.isStreaming) {
          await ctx.dshBridge.restart({});
        }
      }
      res.json({ preset: presetView(row) });
    };
    if (ctx.runExclusiveRuntimeMutation) await ctx.runExclusiveRuntimeMutation(apply);
    else await apply();
  });

  app.delete("/api/agent/presets/:id", async (req, res) => {
    if (!dbGate(req, res)) return;
    const existing = db.getUserPreset(req.params.id);
    if (!existing) return res.status(404).json({ error: "Preset not found" });
    if (ctx.isStreaming) {
      return res.status(409).json({ error: "Cannot manage presets while the agent is responding" });
    }
    const id = req.params.id;
    // When the deleted preset is LIVE, switch AWAY first — the child must
    // never restart onto an id whose preset directory is about to disappear.
    // The fallback is the user's own (pre-focus) mode, exactly what switching
    // back to the built-in agent restores; the switch itself rewrites both
    // patches full and persists the choice. It runs BEFORE the serialized
    // delete because it takes the exclusive mutation lock itself.
    if (dshProfile.rosterPresetId(id) === ctx.currentPreset) {
      const fallback = db.getPreference("agent.preset.own") || dshProfile.DEFAULT_AGENT_PRESET;
      const switched = await ctx.switchPresetTo?.(fallback);
      if (!switched?.ok) {
        // The roster-less / broken-switch corner: still delete, but leave
        // the runtime alone — the boot-time preset guard self-heals the
        // stale id on the next restart (knownPresetIds validation).
        console.warn(`[custom-presets] fallback switch to '${fallback}' failed (${switched?.error}); relying on boot-time self-heal`);
      }
    }
    const apply = async () => {
      db.deleteUserPreset(id);
      // The compose root and the stored overlay diff are this preset's own
      // artifacts — pruned with it. Materialized skills it referenced belong
      // to their packs/the user root and stay.
      skillMaterialize.removeCustomPresetSkills(id);
      db.setFocusOverlay(id, null);
      broadcast({ type: "catalog_changed" });
      // Prunes the generated preset (departed entry) and resets a stale
      // agent label to the built-in agent through `agent_changed`.
      await ctx.syncCatalogAgentPresets?.();
      res.json({ ok: true });
    };
    if (ctx.runExclusiveRuntimeMutation) await ctx.runExclusiveRuntimeMutation(apply);
    else await apply();
  });

  // ── Preset → pack-draft bridge (add-preset-to-pack-bridge) ────────────────
  //
  // The one export-shaped affordance the preset surface offers (spec:
  // custom-presets — "stay cell-local" amended). Gate parity with
  // POST /api/pack-drafts: creating a draft through the preset surface must
  // not bypass the MCP manage gate hand-authoring rides; a rejection leaves
  // nothing behind. The preset itself is untouched and no runtime state is
  // involved, so neither the streaming guard nor roster mutation applies.
  app.post("/api/agent/presets/:id/pack-draft", async (req, res) => {
    if (!dbGate(req, res)) return;
    if (!ctx.requireMcpManage(req, res)) return;
    const row = db.getUserPreset(req.params.id);
    if (!row) return res.status(404).json({ error: "Preset not found" });
    try {
      const { draft, report } = await composePackDraftFromPreset(row, {
        skills: db.listCustomSkills(),
        extensions: db.listExtensionConfigs(),
        operatorNames: operatorMcpNames(),
        findMarketEntry: (name) => extensionStore.findMarketMcpEntry(name),
      });
      const created = db.createPackDraft(draft);
      res.status(201).json({ draft: created, report });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}
