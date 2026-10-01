// ── Bundle materialization (add-a2a-agent-serving 4.2, design D2) ───────────
//
// Composes one PRIVATE DSH_HOME per deployed role. The file formats that
// USED to be mirrored here (presets overlay, settings.yaml, .credentials.yaml)
// now come from dsh-profile.js's parameterized writers directly
// (add-dsh-matrix-lock design D6): one composition pipeline, two execution
// targets, zero format drift — a dsh-profile format change IS the change.
// What remains local: the skills root layout, the override-by-id skills
// patch and the insert-only MCP patch (cordis loader contract, not mirrors
// of platform writers), and the seeded scaffold copy.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  composeAgentPreset,
  ensureCredentialsStore,
  resolveShippedPresetRoot,
  rosterPresetId,
  writeLlmProfile,
  writePresetsPatch,
} from "../dsh-profile.js";

function writeIfChanged(file, content) {
  let current = null;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    /* absent */
  }
  if (current !== content) writeFileSync(file, content);
}

function shippedStandardTemplate() {
  const root = resolveShippedPresetRoot();
  if (!root) return null;
  try {
    return readFileSync(path.join(root, "standard", "agent.cordis.yml"), "utf8");
  } catch {
    return null;
  }
}

// Materialize `<homeRoot>/<agentKey>/` for one deployed role. `bundle` is the
// registry agent entry; the descriptor is entry.metadata. `skillContents`
// maps descriptor.skills paths → SKILL.md bodies (fetched by the caller).
// Returns { home, presetId, patchPaths } — the spawn inputs for the child.
export async function materializeAgentHome({ homeRoot, agentKey, entry, skillContents, mcpServers, template, seedHome }) {
  const descriptor = entry.metadata;
  const home = path.join(homeRoot, agentKey);
  const profileDir = path.join(home, "profiles", "platform");

  // 0. Seed the profile scaffold from the image's baked home (Dockerfile's
  //    /opt/dsh-home): scaffold files copied, node_modules SYMLINKED — the
  //    dsh-base bundle install is hundreds of MB and is never duplicated per
  //    agent; patches and state live in this home beside the scaffold.
  if (seedHome) {
    const srcProfile = path.join(seedHome, "profiles", "platform");
    if (existsSync(srcProfile)) {
      mkdirSync(profileDir, { recursive: true });
      for (const ent of readdirSync(srcProfile, { withFileTypes: true })) {
        if (ent.name === "node_modules") continue;
        const target = path.join(profileDir, ent.name);
        if (!existsSync(target)) copyFileSync(path.join(srcProfile, ent.name), target);
      }
      const nm = path.join(srcProfile, "node_modules");
      const nmTarget = path.join(profileDir, "node_modules");
      if (!existsSync(nmTarget) && existsSync(nm)) {
        try {
          symlinkSync(nm, nmTarget, "dir");
        } catch { /* unsupported FS — the child's boot error will name it */ }
      }
    }
  }

  // 1. Skills: flat compose root — dsh-skill-filesystem's customSkillDirs is a
  //    flat root list (the same constraint the platform's persona compose
  //    roots dance around); here the root is the whole role scope.
  const skillsRoot = path.join(home, "skills");
  rmSync(skillsRoot, { recursive: true, force: true });
  for (const skillPath of descriptor.skills ?? []) {
    const name = String(skillPath).split("/").pop();
    const body = skillContents[skillPath];
    if (typeof body !== "string") {
      throw new Error(`skill content unavailable for ${skillPath} (cannot compose ${agentKey})`);
    }
    const dir = path.join(skillsRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), body);
  }

  // 2. Persona preset: composed from the shipped standard composition exactly
  //    like the platform's generated presets (the "same composition, two
  //    execution targets" promise). Falls back to initialize-without-preset
  //    with a loud warning when the template is unresolvable.
  const tpl = template ?? shippedStandardTemplate();
  let presetId = null;
  if (tpl) {
    // The dsh preset plugin's id regex is lowercase-only (path containment);
    // marketplace pack ids are case-mixed base64url — normalize, or the
    // roster silently drops the preset and every turn fails to mount it.
    presetId = rosterPresetId(`srv-${descriptor.packId}-${descriptor.agentId}`).toLowerCase();
    const presetDir = path.join(home, ".agent-presets", presetId);
    mkdirSync(presetDir, { recursive: true });
    const name = entry.name || descriptor.agentName || presetId;
    writeIfChanged(path.join(presetDir, "preset.yml"), yaml.dump({ name, description: entry.description || name, order: 60 }));
    writeIfChanged(
      path.join(presetDir, "agent.cordis.yml"),
      composeAgentPreset(tpl, `${descriptor.persona || name}\n\nYou are serving as a standing A2A agent service; answer in text.`),
    );
  } else {
    console.warn(`[agent-runner] shipped standard composition unresolvable; ${agentKey} boots without its persona`);
  }

  // 3. Presets overlay — the deployment composer's own writer, aimed at this
  //    private home (add-dsh-matrix-lock D6): disables the stock sdk server,
  //    inserts the platform bridge + a roster that adds this role's user
  //    root. requireRoster:false — the child needs the platform SDK server
  //    row even when no preset root resolves at all (bare composition).
  mkdirSync(profileDir, { recursive: true });
  const presetsPatchPath = await writePresetsPatch({
    dirs: { dshHome: home, profileName: "platform" },
    default: presetId || "standard",
    extraRoots: presetId ? [{ path: path.join(home, ".agent-presets"), trust: "user" }] : [],
    requireRoster: false,
  });

  writeFileSync(
    path.join(profileDir, "skills.patch.yml"),
    // Override-by-id: skill-filesystem exists in the base bundle (unlike the
    // mcp inserts below). includeDefaultRoots keeps built-in discovery.
    yaml.dump([{ id: "skill-filesystem", config: { customSkillDirs: [skillsRoot] } }]),
  );

  const patchPaths = [presetsPatchPath, path.join(profileDir, "skills.patch.yml")].filter(Boolean);
  if (mcpServers.length > 0) {
    writeFileSync(
      path.join(profileDir, "mcp.patch.yml"),
      yaml.dump([{ insert: mcpServers }]),
    );
    patchPaths.push(path.join(profileDir, "mcp.patch.yml"));
  }

  // LLM wiring — the deployment composer's writers into the PRIVATE home:
  // settings.yaml carries the llm-pi-ai provider routes (env route + the
  // Models page's user providers), .credentials.yaml carries their keys (the
  // layer dsh-credentials-local reads when the child env is scrubbed). Both
  // derive from the runner's own deployment config, so a key rotation lands
  // on the next materialization.
  try {
    await writeLlmProfile({ dirs: { dshHome: home, profileName: "platform" } });
    await ensureCredentialsStore({ dirs: { dshHome: home, profileName: "platform" } });
  } catch (e) {
    console.warn(`[agent-runner] LLM profile unavailable for ${agentKey}; the child may boot without chat: ${e?.message || e}`);
  }

  return { home, presetId, patchPaths, skillsRoot };
}

// One dsh-mcp-client loader entry per registry server — the http branch of
// dsh-profile's toMcpClientEntry, verbatim shape.
export function mcpEntry(name, { url, token }) {
  return {
    id: `mcp-${name}`,
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: name,
      failOnStartupError: false,
      transport: "streamable-http",
      url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
  };
}

// Directory key for one registry agent entry: its path is unique and stable
// across in-place upgrades ("packs/<packId>/<agentId>"); filesystem-safe once
// slashes map to dirs.
export function agentKeyFor(entry) {
  return String(entry.path || "")
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-");
}
