// ── Bundle materialization (add-a2a-agent-serving 4.2, design D2) ───────────
//
// Composes one PRIVATE DSH_HOME per deployed role. The file formats that
// USED to be mirrored here (presets overlay, settings.yaml, .credentials.yaml)
// now come from dsh-profile.js's parameterized writers directly
// (add-dsh-matrix-lock design D6): one composition pipeline, two execution
// targets, zero format drift — a dsh-profile format change IS the change.
// What remains local: the skills root layout, the override-by-id skills
// patch and the insert-only MCP patch (cordis loader contract, not mirrors
// of platform writers), and the seeded scaffold copy. The notify overlay
// (writeNotifyPatch) is a dsh-profile writer again — it swaps the preset
// bridge row for its bot_notify subclass (add-agent-notifications D1).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import yaml from "js-yaml";

// The child's credentials file is read by agent skills with shell one-liners
// (grep/sed/awk). js-yaml's default lineWidth folds a long secret into a BLOCK
// SCALAR (`git_pat: >-` with the value on the next line) — a one-line reader
// then returns an empty string, and the 2026-10-12 credential-leak incident
// started exactly there (the skill re-read the raw file to debug and echoed
// the full PAT). Dumping with lineWidth -1 keeps every scalar on ONE line, so
// the file is unambiguous for both YAML parsers and shell readers. forceQuotes
// keeps it that way regardless of which writer touched the file last: another
// path (dsh-profile.js ensureCredentialsStore, called above at the preset
// compose) writes the same file, and mixing bare/quoted scalars there would
// make "is my value quoted?" depend on history. One invariant, both writers.
const YAML_DUMP_OPTS = { lineWidth: -1, forceQuotes: true };
import {
  ensureCredentialsStore,
  rosterPresetId,
  writeLlmProfile,
  writeNotifyPatch,
  writePresetsPatch,
  writeToolFilterPatch,
} from "../dsh-profile.js";
// The deploy gate's shape definition, re-checked here before pinning
// (add-deployment-secrets: one definition, two enforcement points — the
// descriptor arrives from the registry, so the runner never assumes it was
// validated).
import { SECRET_NAME_RE, maskSecretRef } from "../lib/agent-serving.js";

// ── Home ownership guard (fix-agent-serving-stability 3.1) ───────────────────
// The home tree must be owned by the identity the child runtime runs as: a
// root-context write into a uid-1000 volume (or a root-era volume meeting a
// uid-1000 runner) leaves restrictive files (0600 credentials, 0700 dirs)
// that the child hits with EACCES on its own skills — the agent bricks on
// every pack update until someone chowns by hand. The verdict on the home
// ROOT is the tripwire: ours by construction or by target → proceed; a
// foreign owner → a privileged runner repairs the whole tree, an
// unprivileged one refuses loudly with the fix in hand.
export function homeOwnershipVerdict({ exists, uid, euid, targetUid }) {
  if (!exists) return "ours"; // fresh home — this process owns what it writes
  if (uid === euid || uid === targetUid) return "ours";
  return euid === 0 ? "repair" : "refuse";
}

// Shared with compose-acp.js (add-harness-materializer D2): every runner-
// written tree — dsh home or ACP workspace — falls under the same discipline.
export function ensureHomeOwnership(home, log) {
  if (process.platform !== "linux") return; // dev hosts carry no uid discipline
  const targetUid = Number(process.env.AGENT_RUNNER_HOME_UID ?? 1000);
  const targetGid = Number(process.env.AGENT_RUNNER_HOME_GID ?? targetUid);
  let st;
  try {
    st = statSync(home);
  } catch {
    return; // absent home — the guard below materializes under our own uid
  }
  const euid = typeof process.geteuid === "function" ? process.geteuid() : 0;
  const verdict = homeOwnershipVerdict({ exists: true, uid: st.uid, euid, targetUid });
  if (verdict === "ours") return;
  if (verdict === "repair") {
    // chown -R does not follow the node_modules symlink (it chowns the link
    // itself at most), so the shared dsh bundle is never touched.
    execFileSync("chown", ["-R", `${targetUid}:${targetGid}`, home], { stdio: "ignore" });
    (log ?? console).log(`[agent-runner] home ownership repaired to ${targetUid}:${targetGid} — ${home} was uid ${st.uid} (a differently-privileged generation)`);
    return;
  }
  throw Object.assign(
    new Error(
      `refusing to compose into ${home}: the home is owned by uid ${st.uid} but the runner runs as ${euid} and cannot repair it. ` +
      `Run once as root: chown -R ${targetUid}:${targetGid} ${home} (or the whole ${path.dirname(home)} volume), or start the runner under the volume's identity.`,
    ),
    { code: "FOREIGN_HOME_OWNERSHIP" },
  );
}

// Materialize `<homeRoot>/<agentKey>/` for one deployed role. `bundle` is the
// registry agent entry; the descriptor is entry.metadata. `skillContents`
// maps descriptor.skills paths → SKILL.md bodies (fetched by the caller).
// Returns { home, presetId, patchPaths } — the spawn inputs for the child.
export async function materializeAgentHome({ homeRoot, agentKey, entry, skillContents, mcpServers, mcpTools = null, seedHome }) {
  const descriptor = entry.metadata;
  const home = path.join(homeRoot, agentKey);
  const profileDir = path.join(home, "profiles", "platform");
  ensureHomeOwnership(home);

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

  // 2. Persona preset: a declarative definition the preset overlay composes
  //    from the platform-owned standard composition (the "same composition,
  //    two execution targets" promise — the persona row swap now happens
  //    inside writePresetsPatchSync, 0.2.0 D7.2).
  let presetId = null;
  let extraPresets = [];
  {
    // The registry's roster alphabet is lowercase-only (the old containment
    // regex, kept for id hygiene); marketplace pack ids are case-mixed
    // base64url — normalize, or the roster row id would be unstable.
    const name = entry.name || descriptor.agentName || null;
    const persona = descriptor.persona || name;
    if (persona) {
      presetId = rosterPresetId(`srv-${descriptor.packId}-${descriptor.agentId}`).toLowerCase();
      extraPresets = [
        {
          id: presetId,
          name: name || presetId,
          description: entry.description || name || presetId,
          order: 60,
          persona: `${persona}\n\nYou are serving as a standing A2A agent service; answer in text.`,
        },
      ];
    } else {
      console.warn(`[agent-runner] no persona for ${agentKey}; the child boots on the bare standard preset`);
    }
  }

  // 3. Presets overlay — the deployment composer's own writer, aimed at this
  //    private home (add-dsh-matrix-lock D6): disables the stock sdk server,
  //    inserts the platform bridge, the preset registry, and this role's
  //    persona preset row (plus the always-present standard row).
  mkdirSync(profileDir, { recursive: true });
  const presetsPatchPath = await writePresetsPatch({
    dirs: { dshHome: home, profileName: "platform" },
    default: presetId || "standard",
    extraPresets,
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

  // Tool allowlists (add-mcp-tool-scoping D1/D6): the shared writer aims at
  // this private home — tool-filter.json + the scope module land beside the
  // preset bridge the presets overlay already copied, so the deployed role
  // filters tools with the cell's exact mechanism (one composition pipeline,
  // two execution targets). Empty/null = no filtering, legacy deployments.
  writeToolFilterPatch(mcpTools ?? descriptor.mcpTools ?? null, { dirs: { dshHome: home, profileName: "platform" } });

  // 3b. Notify overlay (add-agent-notifications D1/D3): swaps the preset
  //     bridge row for its notify subclass, so this child's roster gains the
  //     `bot_notify` tool. LAST in patch order — it disables the row the
  //     presets overlay inserted. The relay credential and the bound channel
  //     stay on the runner; nothing here reads them.
  const notifyPatchPath = writeNotifyPatch({ dirs: { dshHome: home, profileName: "platform" } });
  if (notifyPatchPath) patchPaths.push(notifyPatchPath);

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

  // 4. Data workspace (facet-mcp-foundation-v1 3.1): when the descriptor
  //    declares one, `<home>/data/` is CREATED here and never removed — the
  //    upgrade path above rmSync's ONLY skillsRoot, undeploy leaves the whole
  //    home on disk, so workspace data is durable exactly like the rest of
  //    the DSH_HOME. Zero declaration ⇒ zero change: no dir, no env, no keys.
  let dataDir = null;
  let dataQuotaMb = null;
  if (descriptor.workspace?.enabled === true) {
    dataDir = path.join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    const quotaMb = Number(descriptor.workspace.quotaMb);
    if (Number.isInteger(quotaMb) && quotaMb > 0) dataQuotaMb = quotaMb;
  }

  return { home, presetId, patchPaths, skillsRoot, dataDir, dataQuotaMb };
}

// The child-visible workspace env (facet-mcp-foundation-v1 3.1): AGENT_DATA_DIR
// points at the private data workspace, and a declared quota rides along for
// tools that want to self-limit. No dataDir (legacy deployment) → the env
// passes through untouched — not even an empty marker key.
export function workspaceChildEnv(spec, env = {}) {
  if (!spec?.dataDir) return env;
  return {
    ...env,
    AGENT_DATA_DIR: spec.dataDir,
    ...(spec.dataQuotaMb != null ? { AGENT_DATA_QUOTA_MB: String(spec.dataQuotaMb) } : {}),
  };
}

// Overwrite the private home's LLM credential refs with the agent's own
// billing key (add-agent-platform-ops D2). The child's env is scrubbed, so
// the credentials FILE is the only channel that reaches it; everything else
// in the doc (user-provider refs) stays intact. Providers read the ref named
// by their route (`settings.yaml` `apiKeyEnv`, e.g.
// LLM_PROVIDER_KEY_FINDDATA) — pinning only a generic LLM_API_KEY left the
// deployer's key inert — so every named ref is overwritten too.
export async function applyBillingKey(home, keyValue) {
  const credentialsPath = path.join(home, ".credentials.yaml");
  let doc = {};
  try {
    doc = yaml.load(readFileSync(credentialsPath, "utf8")) ?? {};
  } catch { /* absent/malformed → recreate */ }
  doc.version = 1;
  doc.refs = doc.refs && typeof doc.refs === "object" ? doc.refs : {};
  doc.refs.LLM_API_KEY = keyValue;
  for (const ref of apiKeyEnvRefs(home)) doc.refs[ref] = keyValue;
  writeFileSync(credentialsPath, yaml.dump(doc, YAML_DUMP_OPTS), { mode: 0o600 });
}

// Every `apiKeyEnv` string in the private home's llm-pi-ai patch row — the
// env-var names the provider routes resolve through the credentials store.
// (0.2.0 D7.1: the routes ride the profile patch row, not home-root
// settings.yaml.)
function apiKeyEnvRefs(home) {
  const refs = new Set();
  try {
    const rows = yaml.load(readFileSync(path.join(home, "profiles", "platform", "cordis.patch.yml"), "utf8")) ?? [];
    const llmRow = (Array.isArray(rows) ? rows : []).find((r) => r?.id === "llm-pi-ai");
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (k === "apiKeyEnv" && typeof v === "string" && v) refs.add(v);
        else walk(v);
      }
    };
    walk(llmRow);
  } catch { /* no patch row → LLM_API_KEY alone */ }
  return refs;
}

// Pin the agent's deployment secrets into the private credentials file
// (add-deployment-secrets D4). Same read-modify-write shape as applyBillingKey:
// the child's environment is scrubbed, so this file is the only channel that
// reaches it. Declared names are lowercase identifiers (validated at deploy
// time; re-checked here before ANY write), so they namespace cleanly beside
// the uppercase provider refs. The whole set lands in one write — callers
// fetch every value first and composition fails before this is reached when
// one is missing, so a partial secret set is never installed.
export function applyDeploymentSecrets(home, secrets) {
  const entries = Object.entries(secrets ?? {});
  if (entries.length === 0) return;
  for (const [name] of entries) {
    if (!SECRET_NAME_RE.test(name)) {
      throw new Error(`deployment secret name '${name}' is not a valid name ([a-z0-9_]{1,32})`);
    }
  }
  const credentialsPath = path.join(home, ".credentials.yaml");
  let doc = {};
  try {
    doc = yaml.load(readFileSync(credentialsPath, "utf8")) ?? {};
  } catch { /* absent/malformed → recreate */ }
  doc.version = 1;
  doc.refs = doc.refs && typeof doc.refs === "object" ? doc.refs : {};
  for (const [name, value] of entries) doc.refs[name] = String(value);
  writeFileSync(credentialsPath, yaml.dump(doc, YAML_DUMP_OPTS), { mode: 0o600 });
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

// ── Pod co-hosting (add-dsh-pod-adapter) ──────────────────────────────────────
//
// One dsh process may host every serving agent of ONE pack deployment (the
// co-hosting key; cross-pack/cross-owner never shares a process). The pod's
// cost is the process floor (~100-180MB measured) regardless of member count
// — the arithmetic that makes hundreds of long-tail agents viable.

// Filesystem + children-map key for one pack's pod. Sanitized with the same
// alphabet as agentKeyFor, so a pack id with hostile characters cannot escape
// the home root.
export function podKeyFor(packId) {
  return `pod-${String(packId || "").replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

// Eligibility (design D2): fail-open to solo — an ineligible pack's members
// each keep their dedicated child; a deployment is never refused for pod
// ineligibility. Structural gates only (the runtime-capabilities gate runs
// after spawn, in the manager):
//   • billing key: applyBillingKey OVERWRITES the whole credential route set,
//     so two different keys cannot coexist in one home — all members must
//     share one billing_key_ref or none declare one;
//   • secrets: same-named deployment secrets must reference the same value
//     across members (otherwise the merged pin is last-write-wins = wrong);
//   • persona: every member must resolve its own preset row — the per-member
//     exact tool face keys byPreset by preset id, so a persona-less member
//     would widen to the pack union;
//   • notify channel: the child's bot_notify calls carry no session identity,
//     so members with distinct bound channels could not be routed — one
//     shared channel (or none) only.
export function packPodEligibility(entries) {
  const keys = new Set();
  for (const entry of entries) {
    const ref = entry?.metadata?.billing_key_ref ?? null;
    if (ref != null) keys.add(ref);
  }
  if (keys.size > 1) {
    return { ok: false, reason: `distinct billing key refs (${[...keys].map((r) => maskSecretRef(r)).join(", ")})` };
  }
  const secretRefs = new Map(); // name → ref
  for (const entry of entries) {
    for (const [name, ref] of Object.entries(entry?.metadata?.secret_refs ?? {})) {
      const prev = secretRefs.get(name);
      if (prev !== undefined && prev !== ref) {
        return { ok: false, reason: `secret '${name}' pinned to two different refs across members` };
      }
      secretRefs.set(name, ref);
    }
  }
  for (const entry of entries) {
    const persona = entry?.metadata?.persona || entry?.name || entry?.metadata?.agentName;
    if (!persona) return { ok: false, reason: `member ${agentKeyFor(entry)} has no persona (no preset row to key its tool face)` };
  }
  const channels = new Set();
  for (const entry of entries) {
    const ch = entry?.metadata?.notify_channel ?? null;
    if (ch != null) channels.add(ch);
  }
  if (channels.size > 1) {
    return { ok: false, reason: `distinct notify channels across members (${[...channels].join(", ")})` };
  }
  return { ok: true, reason: null };
}

// The preset row id for one member inside a pack home — the SAME id the solo
// home would compose (`srv-<packId>-<agentId>`), so a pack migrating between
// solo and pod shapes keeps its conversation composition nameable.
export function packMemberPresetId(entry) {
  const descriptor = entry.metadata;
  return rosterPresetId(`srv-${descriptor.packId}-${descriptor.agentId}`).toLowerCase();
}

// Materialize `<homeRoot>/pod-<packId>/` for one pack deployment. Mirrors
// materializeAgentHome's shape but for N members: N persona preset rows, the
// union of skills (pack-scoped names are unique) and MCP references, secrets
// merged (eligibility guaranteed same-name-same-ref), ONE billing key (same
// discipline), and the pod tool filter — top-level union for the guard /
// register-shadow, per-preset exact faces for composition-time restrict.
// `memberSpecs`: [{ entry, skillContents: {path: body}, billingKeyValue,
// secrets: {name: value} }] — the manager fetches per member, exactly as it
// does for solo children, and this writer stays fetch-free.
// Returns { home, presetIds: Map<agentKey, presetId>, patchPaths, skillsRoot,
// dataDir, dataQuotaMb }.
export async function materializePackHome({ homeRoot, packId: _packId, memberSpecs, mcpServers, seedHome }) {
  if (!memberSpecs?.length) throw new Error("materializePackHome requires at least one memberSpec");
  const first = memberSpecs[0].entry;
  const descriptor = first.metadata;
  if (memberSpecs.some((s) => s.entry?.metadata?.packId !== descriptor.packId)) {
    throw new Error("materializePackHome: every memberSpec must belong to the same pack deployment");
  }
  const home = path.join(homeRoot, podKeyFor(descriptor.packId));
  const profileDir = path.join(home, "profiles", "platform");
  ensureHomeOwnership(home);

  // 0. Seed the profile scaffold from the image's baked home — same shape as
  //    the solo home (files copied, node_modules symlinked, never duplicated).
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

  // 1. Skills: union across members; a name written by two members carries
  //    the same pack-scoped skill (registry names are pack-unique), and the
  //    per-path bodies come from the same registry rows either way.
  const skillsRoot = path.join(home, "skills");
  rmSync(skillsRoot, { recursive: true, force: true });
  const skillBodies = new Map(); // name → body (first writer wins; identical rows)
  for (const spec of memberSpecs) {
    for (const skillPath of spec.entry.metadata?.skills ?? []) {
      const name = String(skillPath).split("/").pop();
      const body = spec.skillContents?.[skillPath];
      if (typeof body === "string" && !skillBodies.has(name)) skillBodies.set(name, body);
    }
  }
  for (const [name, body] of skillBodies) {
    const dir = path.join(skillsRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), body);
  }
  for (const spec of memberSpecs) {
    for (const skillPath of spec.entry.metadata?.skills ?? []) {
      if (typeof spec.skillContents?.[skillPath] !== "string") {
        throw new Error(`skill content unavailable for ${skillPath} (cannot compose pod ${podKeyFor(descriptor.packId)})`);
      }
    }
  }

  // 2. Persona presets: one row per member, the same ids solo homes compose.
  const presetIds = new Map(); // agentKey → presetId
  const extraPresets = [];
  for (const spec of memberSpecs) {
    const entry = spec.entry;
    const d = entry.metadata;
    const name = entry.name || d.agentName || null;
    const persona = d.persona || name;
    if (!persona) continue; // eligibility already refused this pack shape
    const presetId = packMemberPresetId(entry);
    presetIds.set(agentKeyFor(entry), presetId);
    extraPresets.push({
      id: presetId,
      name: name || presetId,
      description: entry.description || name || presetId,
      order: 60,
      persona: `${persona}\n\nYou are serving as a standing A2A agent service; answer in text.`,
    });
  }

  // 3. Presets overlay — N persona rows ride beside the always-present
  //    standard row; the process-level default only matters for sessions no
  //    host parked a preset for (pod sessions always park their member's).
  mkdirSync(profileDir, { recursive: true });
  const presetsPatchPath = await writePresetsPatch({
    dirs: { dshHome: home, profileName: "platform" },
    default: presetIds.values().next().value ?? "standard",
    extraPresets,
  });

  writeFileSync(
    path.join(profileDir, "skills.patch.yml"),
    yaml.dump([{ id: "skill-filesystem", config: { customSkillDirs: [skillsRoot] } }]),
  );

  const patchPaths = [presetsPatchPath, path.join(profileDir, "skills.patch.yml")].filter(Boolean);
  if (mcpServers?.length > 0) {
    writeFileSync(path.join(profileDir, "mcp.patch.yml"), yaml.dump([{ insert: mcpServers }]));
    patchPaths.push(path.join(profileDir, "mcp.patch.yml"));
  }

  // 3a. Pod tool filter: top-level UNION (the guard's upper bound — never
  //     narrower than a member's own allowlist) + per-preset exact faces.
  //     Members without allowlists contribute nothing (their exact face is
  //     the union, which readMcpToolFilterFor falls back to).
  const union = {};
  const byPreset = {};
  for (const spec of memberSpecs) {
    const tools = spec.entry.metadata?.mcpTools ?? null;
    if (!tools || typeof tools !== "object") continue;
    const presetId = presetIds.get(agentKeyFor(spec.entry));
    if (!presetId) continue;
    const memberMap = {};
    for (const [server, leafs] of Object.entries(tools)) {
      if (!Array.isArray(leafs)) continue;
      memberMap[server] = [...leafs];
      union[server] = [...new Set([...(union[server] ?? []), ...leafs])];
    }
    if (Object.keys(memberMap).length) byPreset[presetId] = { mcpTools: memberMap };
  }
  writeToolFilterPatch(
    Object.keys(union).length || Object.keys(byPreset).length ? { mcpTools: union, byPreset } : null,
    { dirs: { dshHome: home, profileName: "platform" } },
  );

  // 3b. Notify overlay — the pod's roster gains `bot_notify` exactly like a
  //     solo child (per-member bindings live manager-side).
  const notifyPatchPath = writeNotifyPatch({ dirs: { dshHome: home, profileName: "platform" } });
  if (notifyPatchPath) patchPaths.push(notifyPatchPath);

  // LLM wiring — same writers, same private-home discipline as solo.
  try {
    await writeLlmProfile({ dirs: { dshHome: home, profileName: "platform" } });
    await ensureCredentialsStore({ dirs: { dshHome: home, profileName: "platform" } });
  } catch (e) {
    console.warn(`[agent-runner] LLM profile unavailable for pod ${podKeyFor(descriptor.packId)}; the child may boot without chat: ${e?.message || e}`);
  }

  // 4. Billing key: eligibility guaranteed one shared ref — pin the one value.
  //    Secrets: merged set (same-name-same-ref guaranteed), one write.
  const billingKeyValue = memberSpecs.find((s) => typeof s.billingKeyValue === "string" && s.billingKeyValue)?.billingKeyValue ?? null;
  if (billingKeyValue) await applyBillingKey(home, billingKeyValue);
  const mergedSecrets = {};
  for (const spec of memberSpecs) Object.assign(mergedSecrets, spec.secrets ?? {});
  applyDeploymentSecrets(home, mergedSecrets);

  // 5. Data workspace: any member's declaration turns the pack-shared volume
  //    on (one pod = one cwd/env); the quota bound is the strictest declared.
  let dataDir = null;
  let dataQuotaMb = null;
  const quotas = [];
  for (const spec of memberSpecs) {
    const ws = spec.entry.metadata?.workspace;
    if (ws?.enabled === true && Number.isInteger(ws.quotaMb) && ws.quotaMb > 0) quotas.push(ws.quotaMb);
  }
  if (memberSpecs.some((s) => s.entry.metadata?.workspace?.enabled === true)) {
    dataDir = path.join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    if (quotas.length) dataQuotaMb = Math.max(...quotas);
  }

  return { home, presetIds, patchPaths, skillsRoot, dataDir, dataQuotaMb };
}
