// The published CLI facts, single-sourced across the shell: the intro view
// renders the install form, the footer carries only the help pointer
// (facet-platform spec: "the intro view carries the published package name
// and install form, and the footnote carries only the `facet help` pointer"),
// and the docs view (add-facet-docs-view) renders per-target directories and
// native MCP config paths from FACET_TARGETS.
//
// Drift guard: scripts/test-facet-docs-facts.mjs imports this module AND the
// CLI itself (facet/cli/facet.js), asserting the two target tables are equal —
// the docs cannot drift from the shipped CLI. When the CLI's table changes,
// change this one in the same commit or the unit suite goes red.
export const FACET_CLI_PACKAGE = "@finddatatechnology/facet";
export const FACET_INSTALL_COMMAND = `npx ${FACET_CLI_PACKAGE} install`;
// Discovery comes before install (fix-supply-machine-faces 5.x): a user who
// does not know an id starts here, and the printed id feeds install verbatim.
export const FACET_LIST_COMMAND = `npx ${FACET_CLI_PACKAGE} list`;
export const FACET_SEARCH_COMMAND = `npx ${FACET_CLI_PACKAGE} search`;
export const FACET_HELP_COMMAND = `npx ${FACET_CLI_PACKAGE} help`;
export const FACET_CONNECT_COMMAND = `npx ${FACET_CLI_PACKAGE} connect`;

// Defaults the CLI itself uses (facet/cli/facet.js DEFAULT_BASE/DEFAULT_REGISTRY).
export const FACET_MARKET_URL = "https://facet.finddatatech.cloud";
export const FACET_REGISTRY_URL = "https://mcp.finddatatech.cloud";

// The deep-guide links point into the public repository that ships
// docs/ecosystem/*.md (and docs/creating-packs.md) with the OSS snapshot.
const DOCS_REPO_BASE = "https://github.com/FindDataTechnology/platform/blob/main/docs";
export const FACET_CLIENT_GUIDE_URL = (target: string) => `${DOCS_REPO_BASE}/ecosystem/${target}.md`;
export const FACET_CREATING_GUIDE_URL = `${DOCS_REPO_BASE}/creating-packs.md`;
/** The capability matrix's own guide. Its OWN constant on purpose: the link used
 *  to be built through FACET_CLIENT_GUIDE_URL plus a no-op `.replace()` that
 *  rewrote "client-matrix.md" to itself, which looked like a fix and changed
 *  nothing (fix-supply-machine-faces 7.2). */
export const FACET_CLIENT_MATRIX_URL = `${DOCS_REPO_BASE}/ecosystem/client-matrix.md`;

export type FacetTargetId = "claude-code" | "cursor" | "zcode" | "codex" | "gemini-cli" | "workbuddy" | "qwen" | "opencode" | "qoder" | "trae";

// One row per editor target. The target ids, skills directories, and MCP
// config paths mirror facet/cli/facet.js SKILLS_SUBDIR / MCP_TARGETS
// (userFile(), tilde-collapsed); the unit test enforces the mirror.
export type FacetTargetFacts = {
  id: FacetTargetId;
  /** Skills directory (user level), tilde-collapsed for display. */
  skillsDir: string;
  /** Native MCP configuration file the CLI writes (user level). */
  mcpFile: string;
};

export const FACET_TARGETS: FacetTargetFacts[] = [
  { id: "claude-code", skillsDir: "~/.claude/skills", mcpFile: "~/.claude.json" },
  { id: "cursor", skillsDir: "~/.cursor/skills", mcpFile: "~/.cursor/mcp.json" },
  { id: "zcode", skillsDir: "~/.zcode/skills", mcpFile: "~/.zcode/cli/config.json" },
  { id: "codex", skillsDir: "~/.codex/skills", mcpFile: "~/.codex/config.toml" },
  { id: "gemini-cli", skillsDir: "~/.gemini/skills", mcpFile: "~/.gemini/settings.json" },
  // WorkBuddy keeps both under .workbuddy — verified on a real install
  // (2026-10-30): a probe skill under ~/.workbuddy/skills was picked up by the
  // client (source "userSettings"); the same probe under ~/.codebuddy/skills
  // was not. MCP resolves via getMcpConfigPath() = <configDir>/mcp.json.
  { id: "workbuddy", skillsDir: "~/.workbuddy/skills", mcpFile: "~/.workbuddy/mcp.json" },
  // qwen-code: skills at ~/.qwen/skills, MCP at ~/.qwen/settings.json in the
  // same {httpUrl, headers} shape as gemini-cli (verified on a real 0.25.2
  // install 2026-11-27).
  { id: "qwen", skillsDir: "~/.qwen/skills", mcpFile: "~/.qwen/settings.json" },
  // opencode auto-discovers ~/.claude/skills too, but this target writes its
  // native location (verified against a real 1.17.3 install 2026-11-27).
  { id: "opencode", skillsDir: "~/.config/opencode/skills", mcpFile: "~/.config/opencode/opencode.json" },
  // qoder installs through its own CLI (`skills install --scope user`,
  // `qodercli mcp add-json --scope user`), so there is no file the CLI writes
  // directly; the paths below are where those commands land (2026-11-27).
  { id: "qoder", skillsDir: "~/.qoder/skills", mcpFile: "~/.qoder/mcp.json" },
  // trae-agent has no MCP configuration of its own — skills are plain markdown
  // a config points at (see NO_MCP_TARGETS). mcpFile is empty for that reason.
  { id: "trae", skillsDir: "~/.trae/skills", mcpFile: "" },
];

// ── Capability matrix (add-facet-client-matrix, F2.2) ─────────────────────────
// The docs view's matrix rows derive from the same facts table — one source,
// drift fails the unit test. Cells state the CLI's write surface (code fact)
// plus the client's proven acceptance tier from the 2026-10-12 walkthroughs.

export type FacetCapabilityTier = "full" | "config-only" | "none";

export type FacetCapabilityFacts = {
  id: FacetTargetId;
  /** Project-level MCP config file the CLI writes, if the target has one. */
  mcpProjectFile: string | null;
  /** Claude-plugin marketplace form availability (claude-code only today). */
  marketplace: boolean;
  /** Real-environment verification tier from the recorded walkthroughs. */
  verified: FacetCapabilityTier;
  /** Model-call key (sk-) LLM config the CLI can write, and how far it is proven.
   *  "full" = `facet key provision --target` writes it AND a real model turn came
   *  back; "config-only" = the CLI writes the file but a real turn is not yet
   *  proven here (deployment gap / broken local binary), stated honestly;
   *  "none" = the target has no LLM-config write path (facet-key-provisioning
   *  non-goal: only claude-code / codex / gemini-cli are wired). */
  llmConfig: FacetCapabilityTier;
};

export const FACET_CAPABILITIES: FacetCapabilityFacts[] = [
  { id: "claude-code", mcpProjectFile: "<dir>/.mcp.json", marketplace: true, verified: "full", llmConfig: "full" },
  { id: "cursor", mcpProjectFile: "<dir>/.cursor/mcp.json", marketplace: false, verified: "config-only", llmConfig: "none" },
  { id: "zcode", mcpProjectFile: null, marketplace: false, verified: "full", llmConfig: "none" },
  { id: "codex", mcpProjectFile: null, marketplace: false, verified: "config-only", llmConfig: "config-only" },
  { id: "gemini-cli", mcpProjectFile: null, marketplace: false, verified: "config-only", llmConfig: "config-only" },
  { id: "workbuddy", mcpProjectFile: "<dir>/.workbuddy/mcp.json", marketplace: true, verified: "config-only", llmConfig: "none" },
  { id: "qwen", mcpProjectFile: null, marketplace: false, verified: "config-only", llmConfig: "config-only" },
  { id: "opencode", mcpProjectFile: null, marketplace: false, verified: "full", llmConfig: "config-only" },
  { id: "qoder", mcpProjectFile: null, marketplace: false, verified: "config-only", llmConfig: "none" },
  { id: "trae", mcpProjectFile: null, marketplace: false, verified: "config-only", llmConfig: "none" },
];

// ── Native MCP entry shapes (overhaul-facet-shell-ia-and-space 5.3) ──────────
// The docs used to answer "how do I connect this client" with a link into the
// public repository — a URL that times out on many customer networks, on the
// exact page a stuck user opens last. The in-site answer is the client's own
// configuration snippet, rendered from THIS table rather than hand-written
// copy: the shapes mirror `MCP_TARGETS` in facet/cli/facet.js, and
// scripts/test-facet-docs-facts.mjs asserts the two stay equal, so the page
// cannot teach a shape the CLI does not write.
export type McpShape = {
  /** File format the client reads. */
  format: "json" | "toml";
  /** JSON container path to the server map (`mcp.servers` is two segments). */
  container: string[];
  /** Key carrying the endpoint — gemini-cli declares `httpUrl`, the rest `url`. */
  urlKey: "url" | "httpUrl";
  /** Whether the entry declares an explicit transport type. */
  declaresType: boolean;
  /** Keys the CLI also writes (docs must print them or the shape drifts). */
  extraKeys?: string[];
};

/** Targets facet installs skills for but which have no MCP entry to write
 *  (trae ships plain markdown for a harness with no MCP config). Declared
 *  explicitly so a new skills-only target must say so instead of drifting. */
export const NO_MCP_TARGETS: readonly string[] = ["trae"];

export const FACET_MCP_SHAPES: Record<FacetTargetId, McpShape> = {
  "claude-code": { format: "json", container: ["mcpServers"], urlKey: "url", declaresType: true },
  cursor: { format: "json", container: ["mcpServers"], urlKey: "url", declaresType: false },
  zcode: { format: "json", container: ["mcp", "servers"], urlKey: "url", declaresType: true },
  "gemini-cli": { format: "json", container: ["mcpServers"], urlKey: "httpUrl", declaresType: false },
  codex: { format: "toml", container: ["mcp_servers"], urlKey: "url", declaresType: false },
  workbuddy: { format: "json", container: ["mcpServers"], urlKey: "url", declaresType: true },
  qwen: { format: "json", container: ["mcpServers"], urlKey: "httpUrl", declaresType: false },
  opencode: { format: "json", container: ["mcp"], urlKey: "url", declaresType: true, extraKeys: ["enabled"] },
  // qoder has no file writer — its CLI owns the file. Shape declared for the
  // docs snippet only, matching the JSON qodercli writes.
  qoder: { format: "json", container: ["mcpServers"], urlKey: "url", declaresType: true },
};

const PLACEHOLDER_URL = "https://mcp.finddatatech.cloud/mcp";
const PLACEHOLDER_KEY = "wgk-调用键";

/** The snippet the docs show for one client. Placeholders are visibly
 *  placeholders (the caller key is minted per viewer, never shipped here). */
export function mcpSample(id: FacetTargetId): string {
  const shape = FACET_MCP_SHAPES[id];
  const name = "<server-name>";
  if (shape.format === "toml") {
    return [
      `[${shape.container[0]}.${name}]`,
      `${shape.urlKey} = "${PLACEHOLDER_URL}"`,
      `http_headers = { Authorization = "Bearer ${PLACEHOLDER_KEY}" }`,
    ].join("\n");
  }
  const entry: Record<string, string> = {};
  if (shape.declaresType) entry.type = "http";
  entry[shape.urlKey] = PLACEHOLDER_URL;
  const body = {
    ...entry,
    headers: { Authorization: `Bearer ${PLACEHOLDER_KEY}` },
  };
  let node: unknown = { [name]: body };
  for (const key of [...shape.container].reverse()) node = { [key]: node };
  return JSON.stringify(node, null, 2);
}
