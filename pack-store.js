// pack-store.js
// Business logic for the pack marketplace's cell side (add-pack-marketplace):
// creator drafts, and the materialization of a subscribed pack's version
// snapshot into this cell — skills into the custom-skills store (hot-reloaded
// via skill-materialize), MCP references through the existing registry-market
// install path (subscriber's own credential; never a secret in the pack), and
// agent personas picked up by the catalog's pack source (which turns them into
// local persona presets through the existing catalog machinery).
//
// Conflict policy is uniform and one-directional: packs never overwrite
// foreign content. A skill or agent id owned by anyone else is skipped with a
// reported reason; the pack's own rows are replaced on reinstall/upgrade; MCP
// server configurations are shared utilities — reused when present, never
// removed on uninstall.

import * as db from "./db.js";
import * as skillMaterialize from "./skill-materialize.js";
import * as extensionStore from "./extension-store.js";
import * as registryCredentials from "./registry-credentials.js";
import { validatePackManifest } from "./lib/pack-manifest.js";

function notFound(msg) {
  return Object.assign(new Error(msg), { status: 404 });
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export function listDrafts() {
  return db.listPackDrafts();
}

export function getDraft(id) {
  const draft = db.getPackDraft(id);
  if (!draft) throw notFound("Draft not found");
  return draft;
}

export function createDraft({ name, description, tags, entries }) {
  if (!name || !String(name).trim()) {
    throw Object.assign(new Error("Draft name required"), { status: 400 });
  }
  return db.createPackDraft({ name: String(name).trim(), description, tags, entries });
}

export function updateDraft(id, patch) {
  getDraft(id);
  return db.updatePackDraft(id, patch);
}

export function deleteDraft(id) {
  if (!db.deletePackDraft(id)) throw notFound("Draft not found");
  return { ok: true };
}

// ── Install (subscribe / upgrade) ────────────────────────────────────────────

// Who owns an agent id besides the installing pack (conflict check). Returns
// { kind: "pack", name } for another installed pack, { kind: "custom", name }
// for a custom preset holding the id (add-custom-presets D6 — the market's
// one-directional never-overwrite-foreign-content policy treats custom
// presets as owners too), or null when the id is free.
function agentOwner(agentId, excludePackId) {
  for (const installed of db.listInstalledPacks()) {
    if (installed.packId === excludePackId) continue;
    if ((installed.manifest?.agents ?? []).some((a) => a?.id === agentId)) {
      return { kind: "pack", name: installed.name };
    }
  }
  const preset = db.getUserPreset(agentId);
  if (preset) return { kind: "custom", name: preset.name };
  return null;
}

// Materialize one MCP reference through the market install path. Returns a
// report item; never throws (an unresolvable reference must not block the
// rest of the pack — spec: pack-installation).
async function installMcpRef(ref, { user }) {
  const name = ref.registryName;
  const item = { name, status: "unavailable" };
  const entry = await extensionStore.findMarketMcpEntry(name);
  if (!entry) {
    return { ...item, reason: "not in the market catalog (renamed or removed on the registry)" };
  }
  if (entry.origin !== "registry") {
    return { ...item, reason: "not a registry server (packs may only reference registry entries)" };
  }
  if (!extensionStore.visibleToUser(entry, user)) {
    return { ...item, reason: `requires group: ${(entry.groups ?? []).join(", ")}` };
  }
  if (extensionStore.getMcpServer(name)) {
    return { name, status: "reused" };
  }
  const cred = registryCredentials.status(user?.email ?? null);
  if (!cred.connected) {
    return { ...item, reason: "connect the MCP market first — no live registry credential", code: "credential-required" };
  }
  // Registry-origin installs are credential-shaped (registry-sso-credentials):
  // strip the template's placeholder auth and reference the stored credential.
  const { headers: _placeholderHeaders, ...rest } = entry.configTemplate ?? {};
  const config = { ...rest, credentialRef: registryCredentials.REGISTRY_CREDENTIAL_REF };
  extensionStore.addMcpServer({
    name,
    config,
    enabled: true,
    requiredGroups: entry.groups?.length ? entry.groups : null,
  });
  return { name, status: "installed" };
}

// Install (or upgrade to) a pack version snapshot. `manifest` arrives via the
// browser (design D8) so it is re-validated here — the same rules the gateway
// enforced at publish. Returns { report, installed, effects } where `effects`
// tells the route which downstream refreshes to fire.
export async function installPack({ packId, version, manifest, user, hooks = {} }) {
  if (!packId || !manifest?.name || !Number.isInteger(Number(version))) {
    throw Object.assign(new Error("packId, version, and manifest are required"), { status: 400 });
  }
  const errors = validatePackManifest(manifest);
  if (errors.length > 0) {
    throw Object.assign(new Error("Invalid manifest"), { status: 400, details: errors });
  }
  const ver = Number(version);
  const report = { skills: [], mcpServers: [], agents: [] };
  const effects = { mcpChanged: false, catalogChanged: false };

  for (const skill of manifest.skills ?? []) {
    const existing = db.getCustomSkill(skill.name);
    if (existing && existing.originPackId !== packId) {
      report.skills.push({
        name: skill.name,
        status: "skipped",
        reason: "a skill with this name already exists and is not owned by this pack",
      });
      continue;
    }
    let row;
    if (existing) {
      db.updateCustomSkill(skill.name, { description: skill.description, content: skill.content });
      row = db.stampSkillPackVersion(skill.name, ver);
    } else {
      row = db.addCustomSkill({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        originPackId: packId,
        originPackVersion: ver,
      });
    }
    skillMaterialize.writeSkill(row);
    report.skills.push({ name: skill.name, status: existing ? "replaced" : "installed" });
  }

  for (const ref of manifest.mcpServers ?? []) {
    const item = await installMcpRef(ref, { user });
    report.mcpServers.push(item);
    if (item.status === "installed") effects.mcpChanged = true;
  }

  for (const agent of manifest.agents ?? []) {
    const owner = agentOwner(agent.id, packId);
    if (owner) {
      report.agents.push({
        id: agent.id,
        name: agent.name,
        status: "skipped",
        reason: owner.kind === "custom"
          ? `agent id is held by custom preset "${owner.name}"`
          : `agent id is owned by installed pack "${owner.name}"`,
      });
      continue;
    }
    report.agents.push({ id: agent.id, name: agent.name, status: "installed" });
    effects.catalogChanged = true;
  }

  const installed = db.upsertInstalledPack({ packId, name: manifest.name, version: ver, manifest, report });

  // Downstream refreshes: MCP configs reach dsh through the profile patch;
  // pack agents reach the picker through the catalog's pack source, and their
  // persona presets regenerate from it.
  if (effects.mcpChanged) {
    hooks.onMcpChanged?.();
  }
  if (effects.catalogChanged) {
    hooks.onCatalogChanged?.();
  }
  return { report, installed, effects };
}

// ── Uninstall (unsubscribe) ──────────────────────────────────────────────────

// What an uninstall would remove, before it happens — the confirmation UI's
// data. MCP configurations are never listed as removed: they are shared
// utilities other packs and manual installs may reference.
export function uninstallPreview(packId) {
  const installed = db.getInstalledPack(packId);
  if (!installed) throw notFound("Pack not installed");
  const manifest = installed.manifest ?? {};
  const modifiedSkills = [];
  for (const s of manifest.skills ?? []) {
    const row = db.getCustomSkill(s.name);
    if (row?.originPackId === packId && row.content !== s.content) modifiedSkills.push(s.name);
  }
  return {
    packId,
    name: installed.name,
    version: installed.version,
    skills: (manifest.skills ?? []).map((s) => s.name),
    modifiedSkills,
    agents: (manifest.agents ?? []).map((a) => ({ id: a.id, name: a.name })),
    mcpServersKept: (manifest.mcpServers ?? []).map((m) => m.registryName),
  };
}

// Remove pack-owned skills and agent entries. Refuses (409) when a pack skill
// was modified after installation unless `force` — the warning is a server-side
// gate, not just a UI nicety.
export function uninstallPack({ packId, force = false, hooks = {} }) {
  const preview = uninstallPreview(packId);
  if (preview.modifiedSkills.length > 0 && !force) {
    throw Object.assign(
      new Error(`Modified pack skill(s) will be lost: ${preview.modifiedSkills.join(", ")}`),
      { status: 409, modifiedSkills: preview.modifiedSkills },
    );
  }
  const manifest = db.getInstalledPack(packId).manifest ?? {};
  db.deleteCustomSkillsByPack(packId);
  // Pack skills materialize under the pack's own root (add-pack-agent-
  // scoping): remove the root wholesale. Names skipped at install (foreign
  // owner) never materialized here, so their dirs in other roots survive.
  skillMaterialize.removePackSkills(packId);
  const hadAgents = (manifest.agents ?? []).length > 0;
  db.deleteInstalledPack(packId);
  // The catalog's pack source drops the entries; syncing now prunes their
  // persona presets and resets a stale selection.
  if (hadAgents) hooks.onCatalogChanged?.();
  return {
    packId,
    removedSkills: preview.skills,
    removedAgents: preview.agents.map((a) => a.id),
    modifiedSkillsLost: preview.modifiedSkills,
    mcpServersKept: preview.mcpServersKept,
  };
}
