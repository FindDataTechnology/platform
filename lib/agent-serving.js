// ── Agent serving deploy library (openspec: add-a2a-agent-serving, D3/D4) ───
//
// Composes registry-native assets for a pack role that carries a serving
// contract and pushes them to the mcp-gateway-registry:
//   • each of the role's skills → a registry skill entry under
//     `packs/<packId>/<skill>` with group visibility (the registry is already
//     the skills distribution plane; the runner pulls content from there);
//   • the role → ONE registry agent entry (supported_protocol "a2a") whose
//     `metadata` carries only the small deployment descriptor — persona,
//     MCP references, skill paths, contract echo. The full manifest and skill
//     bodies never ride in the agent entry (design D3: no size blowups).
//
// The registered `url` is the runner backend; once the registry's A2A reverse
// proxy is enabled (ops precondition 1.5) the registry stores it as the proxy
// backend and advertises the gateway route instead.
//
// `fetchImpl(path, init)` receives registry-relative paths so tests can stub
// the wire without a server; the default impl prefixes REGISTRY_URL.

const EFFECTIVE_WITHIN_SECS = 300; // runner poll interval bound (design D4)

// The registry's A2A reverse proxy (1.30.0, #1734) maps /agent/{path}/** onto
// the registered URL's ORIGIN and drops its path — one agent per origin. A
// multi-tenant runner therefore serves each agent on its own port, assigned
// deterministically from the agent key so the deploy side (which registers
// the URL) and the runner (which binds the listener) agree without talking.
export function agentPortFor(agentKey, { base = 8791, span = 32 } = {}) {
  let h = 0;
  for (const ch of String(agentKey)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return base + (h % span);
}

function pick(fetchImpl, registryUrl, token) {
  if (fetchImpl) return fetchImpl;
  const base = String(registryUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("deployToRegistry: registryUrl (or fetchImpl) is required");
  return (path, init = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
}

async function registryCall(doFetch, method, path, body) {
  const res = await doFetch(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`registry ${method} ${path} failed (${res.status}): ${JSON.stringify(detail).slice(0, 400)}`), {
      status: 502,
    });
  }
  return res.json().catch(() => ({}));
}

// Upsert: PUT the canonical path; create via POST when it does not exist yet.
async function upsert(doFetch, putPath, postPath, payload) {
  const put = await doFetch(putPath, { method: "PUT", body: JSON.stringify(payload) });
  if (put.ok) return put.json().catch(() => ({}));
  if (put.status === 404) return registryCall(doFetch, "POST", postPath, payload);
  const detail = await put.json().catch(() => ({}));
  throw Object.assign(
    new Error(`registry PUT ${putPath} failed (${put.status}): ${JSON.stringify(detail).slice(0, 400)}`),
    { status: 502 },
  );
}

export function listServingAgents(manifest) {
  return (manifest?.agents ?? []).filter((a) => a?.serving !== undefined);
}

// The role's effective skill subset: its declaration, else the whole pack's.
function roleSkills(manifest, agent) {
  const declared = agent?.resources?.skills;
  if (Array.isArray(declared)) {
    const byName = new Map((manifest.skills ?? []).map((s) => [s.name, s]));
    return declared.map((name) => byName.get(name)).filter(Boolean);
  }
  return manifest.skills ?? [];
}

function roleMcp(manifest, agent) {
  const declared = agent?.resources?.mcpServers;
  if (Array.isArray(declared)) {
    const byName = new Map((manifest.mcpServers ?? []).map((m) => [m.registryName, m]));
    return declared.map((name) => byName.get(name)?.registryName ?? name);
  }
  return (manifest.mcpServers ?? []).map((m) => m.registryName);
}

// Compose the AgentCard fields for the registry entry: manual card fields
// override; absent fields derive from the role's display identity. v1 always
// streams (the adapter implements message/stream), so streaming is forced on.
export function composeAgentCard(manifest, agent) {
  const card = agent.serving?.card ?? {};
  const tags = [...new Set([...(manifest.tags ?? []), ...(agent.tags ?? [])])].slice(0, 10);
  return {
    name: card.name ?? agent.name,
    description: card.description ?? `${manifest.name} · ${manifest.description || agent.name}`,
    tags,
    capabilities: { streaming: true, ...(card.capabilities ?? {}) },
    skills: card.skills ?? [],
  };
}

// The small deployment descriptor the runner materializes from (metadata).
export function composeDescriptor({ packId, version, manifest, agent, skillPaths }) {
  const paths = skillPaths ?? roleSkills(manifest, agent).map((s) => `packs/${packId}/${s.name}`);
  return {
    protocol: "a2a",
    packId,
    packVersion: version,
    agentId: agent.id,
    agentName: agent.name,
    persona: agent.persona,
    skills: paths,
    mcpServers: roleMcp(manifest, agent),
  };
}

export async function deployToRegistry({
  packId,
  version,
  manifest,
  runnerBaseUrl,
  packsPublicBase,
  registryUrl,
  token,
  fetchImpl,
  skillGroups = String(process.env.AGENT_SERVING_SKILL_GROUPS || "pack-deployers")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
}) {
  if (!manifest?.name || !packId || !Number.isInteger(Number(version))) {
    throw Object.assign(new Error("packId, version, and manifest are required"), { status: 400 });
  }
  if (!runnerBaseUrl) throw Object.assign(new Error("runnerBaseUrl is required (AGENT_SERVING_RUNNER_URL)"), { status: 500 });
  // The registry fetches skill_md_url ANONYMOUSLY at registration (live
  // finding 2026-09-30): pack skills need a publicly-readable raw-md URL,
  // served by the pack gateway's public route (gateway/packs.js). The same
  // body is synthesized WITH frontmatter there — the registry parses it for
  // metadata, the inline skill_md_content we also send is the storage truth.
  if (!packsPublicBase) throw Object.assign(new Error("packsPublicBase is required (AGENT_SERVING_PACKS_URL — the pack gateway's public origin)"), { status: 500 });

  const serving = listServingAgents(manifest);
  if (serving.length === 0) {
    const ids = (manifest.agents ?? []).map((a) => a?.id).filter(Boolean).join(", ") || "(no agents)";
    throw Object.assign(
      new Error(`no agent in this pack carries a serving contract — nothing to deploy (agents: ${ids})`),
      { status: 400 },
    );
  }

  const doFetch = pick(fetchImpl, registryUrl, token);
  const deployed = [];
  // The registry stores skills under a NAME-derived path (the pack-scoped
  // path we send is advisory — live finding 2026-09-30). The descriptor must
  // reference the ACTUAL stored path, which the upsert response carries.
  const actualSkillPath = new Map();

  for (const agent of serving) {
    for (const skill of roleSkills(manifest, agent)) {
      // Skills are keyed by NAME registry-wide (the pack-scoped path is
      // advisory): resolve the ACTUAL stored path by name first, so an
      // in-place upgrade PUTs the row it means to update instead of falling
      // through to POST and hitting the name conflict.
      let putPath = `/api/skills/packs/${packId}/${skill.name}`;
      try {
        const byName = await doFetch(`/api/skills/${encodeURIComponent(skill.name)}`);
        if (byName.ok) {
          const doc = await byName.json();
          // The stored path carries the /skills/ prefix; the API route adds
          // it — strip it, or the PUT targets /api/skills/skills/<name>.
          if (doc?.path) putPath = `/api/skills/${String(doc.path).replace(/^\/+skills\//, "")}`;
        }
      } catch { /* lookup miss → pack-path upsert below */ }
      const stored = await upsert(
        doFetch,
        putPath,
        "/api/skills",
        {
          path: `packs/${packId}/${skill.name}`,
          name: skill.name,
          description: skill.description,
          skill_md_url: `${String(packsPublicBase).replace(/\/+$/, "")}/api/packs/${packId}/versions/${version}/skills/${skill.name}.md`,
          skill_md_content: skill.content,
          visibility: "group",
          allowed_groups: skillGroups,
        },
      );
      actualSkillPath.set(skill.name, String(stored?.path ?? `packs/${packId}/${skill.name}`).replace(/^\/+skills\//, ""));
    }

    const path = `/packs/${packId}/${agent.id}`;
    const card = composeAgentCard(manifest, agent);
    const descriptor = composeDescriptor({
      packId,
      version,
      manifest,
      agent,
      skillPaths: roleSkills(manifest, agent).map((s) => actualSkillPath.get(s.name) ?? `packs/${packId}/${s.name}`),
    });
    const origin = new URL(runnerBaseUrl); // per-agent port (see agentPortFor)
    const payload = {
      path,
      name: card.name,
      description: card.description,
      url: `${origin.protocol}//${origin.hostname}:${agentPortFor(path)}`, // one agent per origin (registry #1734)
      version: String(version),
      provider: { organization: "paas-pack", url: registryUrl || undefined },
      capabilities: card.capabilities,
      streaming: true,
      skills: card.skills,
      tags: card.tags,
      supported_protocol: "a2a",
      default_input_modes: ["text"],
      default_output_modes: ["text"],
      preferred_transport: "jsonrpc",
      visibility: "public",
      metadata: descriptor,
    };
    await upsert(doFetch, `/api/agents${path}`, "/api/agents/register", payload);
    // The registry's registration security scan FETCHES the backend card; the
    // runner hasn't polled the new entry yet, so the scan fails and DISABLES
    // the agent (live finding 2026-09-30) — the runner's list filter would
    // then never see it (chicken-and-egg). Re-enable right after the upsert:
    // the scan's disable lands during the register call, so this wins.
    try {
      await doFetch(`/api/agents${path}/toggle?enabled=true`, { method: "POST" });
    } catch { /* keep going — the ops flow can toggle manually */ }
    deployed.push({ agentId: agent.id, agentPath: path, skills: descriptor.skills, card });
  }

  return {
    deployed,
    agentPath: deployed[0]?.agentPath,
    skills: [...new Set([...actualSkillPath.values()])],
    effectiveWithinSecs: EFFECTIVE_WITHIN_SECS,
  };
}
