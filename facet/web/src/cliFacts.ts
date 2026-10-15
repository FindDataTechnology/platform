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

export type FacetTargetId = "claude-code" | "cursor" | "zcode" | "codex" | "gemini-cli";

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
};

export const FACET_CAPABILITIES: FacetCapabilityFacts[] = [
  { id: "claude-code", mcpProjectFile: "<dir>/.mcp.json", marketplace: true, verified: "full" },
  { id: "cursor", mcpProjectFile: "<dir>/.cursor/mcp.json", marketplace: false, verified: "config-only" },
  { id: "zcode", mcpProjectFile: null, marketplace: false, verified: "full" },
  { id: "codex", mcpProjectFile: null, marketplace: false, verified: "config-only" },
  { id: "gemini-cli", mcpProjectFile: null, marketplace: false, verified: "config-only" },
];
