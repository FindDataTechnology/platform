// ── Marketplace repository projection (add-pack-marketplace-git-channel)
//
// Projects the facet listing into a CodeBuddy/WorkBuddy plugin marketplace
// repository: a root `.codebuddy-plugin/marketplace.json` plus, per listed
// pack, a plugin directory carrying the pack's skills as skill directories
// and its agents as agent documents. This exists because that client family
// states its URL-typed marketplaces are catalog-only — it fetches
// marketplace.json and a relative entry's plugin.json, and cannot recursively
// mirror arbitrary plugin files over HTTP. A repository is the only form in
// which skills actually travel.
//
// Shared rules, not copies:
//   - admission comes from loadListedPacks (marketplace-json.js) — the same
//     function the Claude-format endpoint uses, so the two surfaces can never
//     disagree about who is listed;
//   - path safety comes from lib/skill-files.js (safePackagePath), the same
//     rule the publish validator and the zip upload path enforce.
//
// Boundary (one, stated once): the plugin body carries NO MCP server
// configuration and NO credential material. MCP references appear as
// connection guidance in the plugin README only. The repository is public and
// anonymous-fetchable, so an embedded server config would install broken (no
// key) and would leak nothing but noise; guidance is the honest shape.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isScriptFilePath, safePackagePath } from "../lib/skill-files.js";
import { loadListedPacks } from "./marketplace-json.js";
import { LANE, CAPABILITIES, selectLane } from "./cli/mcp-auth-capability.js";

// The manifest directory this client family reads. The client accepts
// `.codebuddy-plugin/`, `.workbuddy-plugin/` and `.claude-plugin/`
// interchangeably; one form is written on purpose — three copies invite
// "which one is real" drift.
export const MANIFEST_DIR = ".codebuddy-plugin";
export const MANIFEST_NAME = "marketplace.json";

export const DEFAULT_OWNER = { name: "FindData · 谦面" };
export const DEFAULT_MARKET_NAME = "facet";

// Credential shapes that must never appear in exported bytes. The generator
// refuses rather than sanitizes: a match means a pack somehow carried a key,
// which is a publish-gate bug, not something to quietly strip. Defined once in
// credential-pattern.js so the runtime projection face can share it without
// importing this exporter (and, through it, facet/cli/ which is not shipped in
// the image); re-exported below for existing importers (scripts/, tests).
import { CREDENTIAL_RE } from "./credential-pattern.js";

export class MarketplaceRepoError extends Error {
  constructor(message, { code = "EXPORT_REJECTED", detail = null } = {}) {
    super(message);
    this.name = "MarketplaceRepoError";
    this.code = code;
    this.detail = detail;
  }
}

const registryBase = (env = process.env) =>
  (env.FACET_REGISTRY_BASE || env.REGISTRY_URL || "https://mcp.finddatatech.cloud").replace(/\/+$/, "");

// The plugin slug and skill directory names must survive a filesystem and a
// URL: pack ids are already slug-shaped (registry-assigned), skill names come
// from the manifest and are validated at publish time — this is a second lock
// on the same door, not a new rule.
function safeSegment(value, what) {
  const s = String(value ?? "");
  if (!s || s === "." || s === "..") {
    throw new MarketplaceRepoError(`${what} is empty or a traversal segment: ${JSON.stringify(value)}`, { code: "BAD_SEGMENT" });
  }
  if (s.includes("/") || s.includes("\\") || s.includes("\0") || /^[A-Za-z]:/.test(s)) {
    throw new MarketplaceRepoError(`${what} is not a single path segment: ${JSON.stringify(value)}`, { code: "BAD_SEGMENT" });
  }
  return s;
}

function assertNoCredential(relPath, text) {
  if (typeof text !== "string") return;
  if (CREDENTIAL_RE.test(text)) {
    throw new MarketplaceRepoError(
      `credential-shaped string found in ${relPath} — a pack must never carry a key`,
      { code: "CREDENTIAL_IN_CONTENT" },
    );
  }
}

// Synthesized frontmatter, the same shape the raw skill route serves (pack
// skills are body-only; the name/description live in the manifest).
function renderSkillMd(skill) {
  return [
    "---",
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description ?? "")}`,
    "---",
    "",
    String(skill.content ?? ""),
  ].join("\n");
}

// One agent → one markdown document with frontmatter the client reads as an
// agent definition. Persona becomes the body; the pack's declared resources
// are stated in plain prose (that client has no equivalent structured field —
// pretending otherwise would be a silent drop).
function renderAgentMd(agent) {
  const lines = [
    "---",
    `name: ${JSON.stringify(agent.name)}`,
    `description: ${JSON.stringify(agent.description ?? agent.name)}`,
    "---",
    "",
    String(agent.persona ?? ""),
  ];
  const res = agent.resources ?? {};
  const notes = [];
  if (Array.isArray(res.skills) && res.skills.length > 0) notes.push(`本角色使用技能：${res.skills.join("、")}`);
  if (Array.isArray(res.mcpServers) && res.mcpServers.length > 0) notes.push(`本角色引用 MCP：${res.mcpServers.join("、")}`);
  if (notes.length > 0) lines.push("", "## 资源", "", ...notes);
  return lines.join("\n");
}

// ── Per-client connect blocks (add-universal-keyless-mcp-auth D5 / tasks 4.1-4.2)
//
// The same pack needs a different connection block per client, because the
// connection lane differs per client and NOT because the pack differs. The lane
// is computed from the capability table — the market artifact must never state
// a lane that the table does not evidence, or the artifact becomes the next
// "documentation said it works" trap.
//
// Three shapes, one per lane:
//   L1 native  → an `oauth.clientId` block, no secret anywhere
//   L2 brokered→ a static `Authorization` header with a PLACEHOLDER value plus
//                the command that fills it (the token is short-lived and
//                per-user, so it can never be baked into a public artifact)
//   L3 key     → the `--key` command
//
// Nothing here may contain a real credential: the placeholder text is a fetch
// instruction, and assertNoCredential runs over every emitted file anyway.

// Built by concatenation so the literal stays literal: a bare "${...}" in a
// string reads as a template placeholder to linters and to whoever copies it.
const PLACEHOLDER_BEARER = "$" + "{FACET_ACCESS_TOKEN}";

function connectBlockFor(server, client, { registry }) {
  const endpoint = `${registry}/${server.registryName}/mcp`;
  const pick = selectLane(client, { hasBrowser: true });
  const lane = pick.lane;
  const base = {
    client,
    server: server.registryName,
    endpoint,
    lane,
    laneReason: pick.reason,
    ...(server.requiredGroup ? { requiredGroup: server.requiredGroup } : {}),
  };

  if (lane === LANE.NATIVE) {
    const clientId = pick.record?.clientId ?? null;
    return {
      ...base,
      config: { type: "http", url: endpoint, oauth: { ...(clientId ? { clientId } : {}), scope: "openid gateway:access offline_access" } },
      how: `在 ${client} 的 MCP 配置里加入上面的块；客户端会自己拉起授权，配置文件内不含任何密钥。`,
      credentialShape: "none",
    };
  }
  if (lane === LANE.BROKERED) {
    return {
      ...base,
      config: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${PLACEHOLDER_BEARER}` } },
      how:
        "先跑 `npx @finddatatechnology/facet auth <packRef> --target " + client + " --write-mcp`" +
        "（它会完成授权并把短命令牌写入客户端配置），再把上面的 Authorization 值替换成命令输出的值；" +
        "过期后跑 `facet auth --refresh` 静默续期。",
      credentialShape: "short-lived access token in a static header",
    };
  }
  return {
    ...base,
    config: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${PLACEHOLDER_BEARER}` } },
    how: `跑 \`npx @finddatatechnology/facet connect\` 铸取调用键，再用 --key 写入（headless/CI 用）。`,
    credentialShape: "caller key (wgk-)",
  };
}

/**
 * Build the `connect/` directory contents for one pack:
 *   connect/<client>.json — machine-usable block the CLI can merge
 *   connect/README.md     — one command per client
 * Emitted for every client that has a capability record with usable evidence;
 * a client whose record is missing or stale is listed as "待复验" and gets no
 * block (writing an unevidenced block is the exact mistake we are avoiding).
 */
function connectFiles(pack, { registry, manifest }) {
  const servers = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [];
  if (servers.length === 0) return new Map();
  const files = new Map();
  const rows = [];
  for (const client of CAPABILITIES.map((c) => c.client)) {
    const blocks = servers.map((s) => connectBlockFor(s, client, { registry }));
    const first = blocks[0];
    files.set(`connect/${client}.json`, JSON.stringify({ client, pack: pack.id, blocks }, null, 2) + "\n");
    rows.push({ client, lane: first.lane, laneReason: first.laneReason, how: first.how, blocks });
  }
  const lines = [
    "# 连接指引（按客户端）",
    "",
    "本套件声明了 MCP 引用。**每个客户端走哪条连接道，由机器实证的能力表决定**，不按文档猜：",
    "",
    "| 客户端 | 连接道 | 说明 |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.client} | ${r.lane} | ${r.laneReason} |`),
    "",
  ];
  for (const r of rows) {
    lines.push(`## ${r.client}（${r.lane}）`, "", r.how, "");
    for (const b of r.blocks) {
      lines.push(`### ${b.server}`, "", "```json", JSON.stringify(b.config, null, 2), "```", "");
    }
  }
  files.set("connect/README.md", lines.join("\n"));
  return files;
}

function renderReadme(pack, { registry, manifest }) {
  // First prose line (overhaul-market-catalog-presentation 4.10): the declared
  // v2 promise wins — it IS the one-sentence contract external readers (humans
  // and AI scrapers alike) scan first; without one the description stands, so
  // every legacy README renders byte-identically.
  const declaredPromise = typeof manifest?.promise === "string" ? manifest.promise.trim() : "";
  const lines = [
    `# ${pack.name}`,
    "",
    declaredPromise || pack.description || "",
    "",
  ];
  const skills = manifest.skills ?? [];
  if (skills.length > 0) {
    lines.push("## 技能", "", ...skills.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""}`), "");
  }
  const agents = manifest.agents ?? [];
  if (agents.length > 0) {
    lines.push("## 智能体", "", ...agents.map((a) => `- ${a.name}${a.description ? ` — ${a.description}` : ""}`), "");
  }
  const servers = manifest.mcpServers ?? [];
  if (servers.length > 0) {
    lines.push(
      "## MCP 连接指引",
      "",
      "本插件声明以下 MCP 引用（**不随插件自动连接**——插件本体不携带任何服务器配置或凭据）：",
      "",
    );
    for (const s of servers) {
      lines.push(`- **${s.registryName}** — 端点 \`${registry}/${s.registryName}/mcp\`${s.requiredGroup ? `（需要组：${s.requiredGroup}）` : ""}`);
    }
    lines.push(
      "",
      "连接方式：支持 MCP OAuth 的客户端可直接对该端点授权；否则用谦面 CLI 铸取调用键后写入本机配置：",
      "",
      "```",
      "npx @finddatatechnology/facet connect",
      "npx @finddatatechnology/facet install <packRef> --target workbuddy --write-mcp",
      "```",
      "",
    );
  }
  // Funnel hook (add-marketplace-projection-fanout, design D6): prose only —
  // the manifest keeps its machine contract untouched.
  lines.push(
    "---",
    "",
    "装好只是开始。想让这套能力 **7×24 常驻**（定时运行、多岗协作、产出直接交付），到萬星开一支智能体团队：<https://finddatatech.cloud>",
    "",
  );
  return lines.join("\n");
}

// Build the file map for one plugin directory: relPath → content. Paths are
// relative to the plugin root (plugins/<packId>/).
function pluginFiles(pack, row, { registry }) {
  const manifest = row.manifest ?? {};
  const files = new Map();

  // `skills` is declared explicitly when the pack carries any: the client
  // discovers `<root>/skills` by convention anyway, but the marketplaces it
  // ships with state it, and the client's own plugin loader validates the
  // manifest — declaring it removes a class of "installed but empty" outcomes.
  const hasSkills = Array.isArray(manifest.skills) && manifest.skills.length > 0;
  const pluginJson = {
    name: safeSegment(pack.id, "pack id"),
    description: pack.description || pack.name || "",
    version: String(row.version ?? pack.version ?? "0.0.0"),
    author: DEFAULT_OWNER,
    ...(hasSkills ? { skills: ["./skills"] } : {}),
  };
  files.set(`${MANIFEST_DIR}/plugin.json`, JSON.stringify(pluginJson, null, 2) + "\n");

  // Display v2 sidecar (overhaul-market-catalog-presentation 4.10): the
  // structured display fields ride a DEDICATED file because marketplace.json
  // and plugin.json field sets are pinned by the external clients' loaders —
  // a client that does not know facet.json parses and installs exactly as
  // before. Values are verbatim from the manifest (no rewrite, no locale
  // projection — the market face already owns that). Undeclared pack emits NO
  // sidecar: absence is the byte-identical default.
  const FACET_V2_KEYS = ["identity", "promise", "audience", "outcomes", "examples", "domain"];
  const sidecar = {};
  for (const key of FACET_V2_KEYS) {
    if (manifest[key] !== undefined && manifest[key] !== null) sidecar[key] = manifest[key];
  }
  if (Object.keys(sidecar).length > 0) {
    files.set("facet.json", JSON.stringify({ packId: pack.id, version: String(row.version ?? pack.version ?? "0.0.0"), ...sidecar }, null, 2) + "\n");
  }

  for (const skill of manifest.skills ?? []) {
    const name = safeSegment(skill.name, "skill name");
    files.set(`skills/${name}/SKILL.md`, renderSkillMd(skill));
    const aux = skill.files && typeof skill.files === "object" && !Array.isArray(skill.files) ? skill.files : {};
    for (const [rawRel, body] of Object.entries(aux)) {
      const rel = safePackagePath(String(rawRel));
      if (!rel) {
        throw new MarketplaceRepoError(
          `skill '${name}' carries an unsafe auxiliary path: ${JSON.stringify(rawRel)}`,
          { code: "UNSAFE_PATH", detail: { skill: name, file: rawRel } },
        );
      }
      if (typeof body !== "string") {
        throw new MarketplaceRepoError(
          `skill '${name}' auxiliary file ${rel} is not text (binary content cannot be exported)`,
          { code: "NON_TEXT_FILE", detail: { skill: name, file: rel } },
        );
      }
      files.set(`skills/${name}/${rel}`, body);
    }
  }

  for (const agent of manifest.agents ?? []) {
    const id = safeSegment(agent.id, "agent id");
    files.set(`agents/${id}.md`, renderAgentMd(agent));
  }

  files.set("README.md", renderReadme(pack, { registry, manifest }));
  // Per-client connect blocks. Emitted only when the pack declares MCP
  // references — a pack with none must not grow an empty `connect/` tree that
  // suggests it needs a connection it does not.
  for (const [rel, text] of connectFiles(pack, { registry, manifest })) files.set(rel, text);
  return files;
}

/**
 * Build the whole repository in memory: { manifest, plugins: Map<id, files> }.
 * `plugins` maps pack id → relPath → content (paths relative to the plugin
 * root). Nothing is written here — see writeRepo().
 */
export function buildMarketplaceRepo(registry, { viewer = null, env = process.env, owner = DEFAULT_OWNER, name = DEFAULT_MARKET_NAME } = {}) {
  const registryUrl = registryBase(env);
  const packs = loadListedPacks(registry, { viewer, env });

  const plugins = new Map();
  const entries = [];
  for (const pack of packs) {
    // One `viewer` answering for every listed pack would be wrong: the listing
    // already applied the caller's visibility, and an anonymous export must
    // re-check each pack under the anonymous viewer (a private pack that
    // slipped into a listing through a stale cache must not be exported).
    const row = registry.getVersionVisible(pack.id, pack.version, viewer);
    if (!row) {
      throw new MarketplaceRepoError(
        `listed pack ${pack.id} v${pack.version} is not readable by the exporting viewer`,
        { code: "ENTRY_UNREADABLE", detail: { packId: pack.id, version: pack.version } },
      );
    }
    const id = safeSegment(pack.id, "pack id");
    const files = pluginFiles(pack, row, { registry: registryUrl });
    for (const [rel, text] of files) assertNoCredential(`plugins/${id}/${rel}`, text);
    plugins.set(id, files);
    entries.push({
      name: id,
      // Relative source: the client resolves it against the manifest's own
      // directory, and the files are present in the same clone — the whole
      // point of the repository form.
      source: `./plugins/${id}`,
      description: pack.description || pack.name || "",
      version: String(row.version ?? pack.version),
    });
  }

  const manifest = {
    name,
    owner,
    plugins: entries,
  };
  assertNoCredential(`${MANIFEST_DIR}/${MANIFEST_NAME}`, JSON.stringify(manifest));
  return { manifest, plugins };
}

/**
 * Validate a built repo before it may be published. Every rule here is a
 * "never publish this" — the caller must keep the previous snapshot on any
 * failure (last-good).
 */
export function validateMarketplaceRepo({ manifest, plugins }) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") problems.push("manifest is not an object");
  const entries = Array.isArray(manifest?.plugins) ? manifest.plugins : null;
  if (!entries) problems.push("manifest.plugins is not an array");

  const seen = new Set();
  for (const e of entries ?? []) {
    if (!e || typeof e.name !== "string" || !e.name) {
      problems.push(`entry without a name: ${JSON.stringify(e)}`);
      continue;
    }
    if (seen.has(e.name)) problems.push(`duplicate entry name: ${e.name}`);
    seen.add(e.name);
    if (typeof e.source !== "string" || !e.source.startsWith("./plugins/")) {
      problems.push(`entry ${e.name}: source must be a relative ./plugins/ path`);
    }
    if (typeof e.version !== "string" || !e.version) problems.push(`entry ${e.name}: missing version`);
    const files = plugins.get(e.name);
    if (!files) {
      problems.push(`entry ${e.name}: plugin directory missing`);
      continue;
    }
    if (!files.has(`${MANIFEST_DIR}/plugin.json`)) problems.push(`entry ${e.name}: ${MANIFEST_DIR}/plugin.json missing`);
    for (const rel of files.keys()) {
      if (!safePackagePath(rel)) problems.push(`entry ${e.name}: escaping path ${rel}`);
      if (rel.startsWith("..") || path.isAbsolute(rel)) problems.push(`entry ${e.name}: escaping path ${rel}`);
    }
  }

  // Reverse check: a plugin directory that is not in the manifest would keep
  // distributing content after the pack was unlisted.
  for (const id of plugins.keys()) {
    if (!seen.has(id)) problems.push(`orphan plugin directory not in the manifest: ${id}`);
  }

  if (problems.length > 0) {
    throw new MarketplaceRepoError(`marketplace repo failed validation:\n- ${problems.join("\n- ")}`, {
      code: "SNAPSHOT_INVALID",
      detail: problems,
    });
  }
  return true;
}

/**
 * Write a validated repo into `outDir` (creating/overwriting files). Callers
 * write to a staging directory and swap — this function does not delete.
 */
export function writeMarketplaceRepo({ manifest, plugins }, outDir) {
  validateMarketplaceRepo({ manifest, plugins });
  mkdirSync(path.join(outDir, MANIFEST_DIR), { recursive: true });
  writeFileSync(path.join(outDir, MANIFEST_DIR, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  for (const [id, files] of plugins) {
    for (const [rel, text] of files) {
      const target = path.join(outDir, "plugins", id, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text, "utf8");
    }
  }
  return {
    entries: (manifest.plugins ?? []).length,
    files: [...plugins.values()].reduce((n, m) => n + m.size, 0) + 1,
  };
}

export { CREDENTIAL_RE, isScriptFilePath };
