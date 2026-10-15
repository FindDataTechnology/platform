// ── ACP workspace materialization (add-harness-materializer D2/D5) ───────────
//
// The serving plane's half of the pack materializer: a deployment whose
// harness is an ACP binary gets its pack content in the layout THAT harness
// natively reads — a private workspace, never a DSH_HOME (the pre-slice④
// runner composed a dsh home no ACP process ever opened, and the pack's
// persona/skills/MCP silently never reached the agent). The 谦面 CLI
// (facet/cli) owns the local-install half over the same manifest fields; the
// two halves converge on the pack manifest, not on shared code (different
// surfaces: a user's ~/.claude vs a runner-private workspace plus the ACP
// session wire).
//
// Layout discipline mirrors compose.js's home discipline: the persona file
// and the skills root are overwritten per materialization (an upgrade
// replaces the pack's own content), the data workspace is never removed, and
// the tree falls under the same uid-ownership guard — a runner-written tree
// is owned by the child runtime's identity, whatever harness that is.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureHomeOwnership } from "./compose.js";

// The SAME suffix the dsh persona preset row carries (compose.js — one
// composition voice across harnesses). Both literals must stay in lockstep;
// the materializer suite trips the drift by reading compose.js's source.
const SERVING_SUFFIX = "\n\nYou are serving as a standing A2A agent service; answer in text.";

// The layout each harness name maps to (design D5). Names are the SAME keys
// AGENT_RUNNER_ACP_COMMANDS allowlists — a harness this runner hosts but no
// layout maps serves bare with the gap named, never pretending content
// landed. v1 maps the one ACP harness in production; the table is the only
// thing a new harness layout touches.
const LAYOUTS = new Map([["acp-claude-code", "claude-code"]]);

export function acpLayoutFor(harnessName) {
  return LAYOUTS.get(String(harnessName || "")) ?? null;
}

// Materialize `<homeRoot>/ws/<agentKey>/` for one ACP-harness deployment.
// `entry` is the registry agent entry (descriptor = entry.metadata),
// `skillContents` maps descriptor.skills paths → SKILL.md bodies (fetched by
// the caller, exactly as the dsh path fetches). Returns
// { workspace, dataDir, dataQuotaMb, unmapped, layout } — `unmapped` names
// the declared content parts that found no native mapping (bare layouts
// only; a mapped layout either lands content or throws).
export function materializeAcpWorkspace({ homeRoot, agentKey, entry, skillContents, harnessName, log = console }) {
  const descriptor = entry.metadata ?? {};
  const workspace = path.join(homeRoot, "ws", agentKey);
  ensureHomeOwnership(workspace);
  mkdirSync(workspace, { recursive: true });
  const layout = acpLayoutFor(harnessName);

  // Data workspace: harness-NEUTRAL (the env channel any process reads), so
  // it materializes for every layout — bare included. Same shape and same
  // never-remove discipline as the dsh home's data dir.
  let dataDir = null;
  let dataQuotaMb = null;
  if (descriptor.workspace?.enabled === true) {
    dataDir = path.join(workspace, "data");
    mkdirSync(dataDir, { recursive: true });
    const quotaMb = Number(descriptor.workspace.quotaMb);
    if (Number.isInteger(quotaMb) && quotaMb > 0) dataQuotaMb = quotaMb;
  }

  if (!layout) {
    const unmapped = [];
    if (descriptor.persona || entry.name || descriptor.agentName) unmapped.push("persona");
    if ((descriptor.skills ?? []).length > 0) unmapped.push("skills");
    if ((descriptor.mcpServers ?? []).length > 0) unmapped.push("mcpServers");
    if (unmapped.length > 0) {
      log.warn(`[agent-runner] harness '${harnessName}' has no native layout for ${unmapped.join(", ")} — serving bare (cwd/env/model only)`);
    }
    return { workspace, dataDir, dataQuotaMb, unmapped, layout: null };
  }

  // claude-code layout (verified against claude-code-acp src/acp-agent.ts,
  // 2026-10-15): the SDK loads project setting sources
  // (settingSources ["user","project","local"]), so CLAUDE.md in the session
  // cwd IS the persona channel; skills land as native Agent Skills under
  // .claude/skills/<name>/SKILL.md — a near-identity copy of the pack rows.
  const name = entry.name || descriptor.agentName || null;
  const persona = descriptor.persona || name;
  if (persona) {
    writeFileSync(path.join(workspace, "CLAUDE.md"), `${persona}${SERVING_SUFFIX}`);
  } else {
    log.warn(`[agent-runner] no persona for ${agentKey}; the ACP harness runs on its bare preset`);
  }

  const skillsRoot = path.join(workspace, ".claude", "skills");
  rmSync(skillsRoot, { recursive: true, force: true });
  for (const skillPath of descriptor.skills ?? []) {
    const skillName = String(skillPath).split("/").pop();
    const body = skillContents?.[skillPath];
    if (typeof body !== "string") {
      throw new Error(`skill content unavailable for ${skillPath} (cannot compose ${agentKey})`);
    }
    const dir = path.join(skillsRoot, skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), body);
  }

  return { workspace, dataDir, dataQuotaMb, unmapped: [], layout };
}

// One ACP wire row per registry MCP reference — the http branch of the
// installed SDK's schema (0.14.1 McpServerHttp: {type:"http", name, url,
// headers}, where headers is an ARRAY of {name,value} entries — NOT a record;
// claude-code-acp maps the entries onto its SDK's header map). URL source
// and token discipline are mcpEntry's: the runner's registry credential
// rides the Authorization header, the same credential the dsh loader row
// uses.
export function acpMcpServers(names, registryClient, token) {
  return (names ?? []).map((name) => ({
    type: "http",
    name: String(name),
    url: registryClient.mcpUrlFor(name),
    headers: token ? [{ name: "Authorization", value: `Bearer ${token}` }] : [],
  }));
}

// The per-deployment credential override for an ACP spawn (design D4). The
// standing credential arrives through the runner's acpEnv; the deployer's
// billing key replaces it through these two vars — BOTH, because the
// standing credential sets API_KEY and AUTH_TOKEN and the SDK may prefer
// either; overriding one would leave the agent authenticating (and billing)
// on the other. Pure on purpose: the policy is testable without a process.
export function acpCredentialEnv(billingKeyValue) {
  if (typeof billingKeyValue !== "string" || !billingKeyValue) return null;
  return { ANTHROPIC_API_KEY: billingKeyValue, ANTHROPIC_AUTH_TOKEN: billingKeyValue };
}

// The fail-closed refusal for deployment secrets on an ACP harness (design
// D4): the process env is not a controlled channel for an arbitrary ACP
// binary (proc-visible, no file discipline), and the pre-slice④ behavior —
// pinning them into a DSH_HOME the harness never opens — silently lost
// them. Structured so the manager's error is distinguishable from a secret
// FETCH failure: the code names the missing channel, not the ref.
export function acpSecretsRefusal(secretRefs, harnessName) {
  const names = Object.keys(secretRefs ?? {});
  if (names.length === 0) return null;
  return Object.assign(
    new Error(
      `deployment secrets declared (${names.join(", ")}) but harness '${harnessName}' has no controlled secrets channel — ` +
      `deploy this agent on the dsh harness or drop the secrets`,
    ),
    { code: "HARNESS_SECRETS_UNSUPPORTED", harness: harnessName, secrets: names },
  );
}
