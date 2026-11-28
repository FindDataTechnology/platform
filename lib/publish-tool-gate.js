// ── Publish-time tool-declaration gate (add-mcp-tool-scoping D5) ─────────────
//
// The publish endpoint's second validation stage: every declared tool leaf
// name (pack-level allowTools ∪ per-role resources.mcpTools) is checked
// against the referenced registry server's known tool surface, and against
// the server's commercial surface when it is surface-registered. Shared by
// every publish face (壹座 gateway and the facet service ride the same
// route), and never consulted for manifests without declarations — legacy
// publishes are byte-identical in behavior.
//
// Data sources, in order:
//   serverInfo(name) → { toolList, commercialTools, endpoint } | null
//     null = the name is not a registry server (a local-binding reference —
//     exempt from both checks; the cell resolves it against local rows).
//   probe(endpoint) → Promise<string[] | null>
//     one bounded live tools/list for snapshot-staleness fallback: a name
//     missing from the registry's stored tool_list but present live PASSES
//     (registry snapshots lag — the business-mcp 9/24 lesson); a name in
//     neither fails the publish.
//
// Commercial closure (the finddata mcp-surface-contract consumer-side rule):
// when the entry carries a commercial NAME list (metadata.surface
// .commercial_tools), any declared tool outside it fails the publish
// regardless of probe results — internal tools exist but may not enter the
// commercial supply face. A surface-registered entry whose meta carries only
// counts (the pre-enrichment shape) skips the closure with an observable
// note rather than guessing.

// Collect every declared leaf name per referenced server: the pack-level
// allowTools plus each role's resources.mcpTools list for that server.
// Tolerates any malformed manifest shape (non-array mcpServers/agents, mixed
// entries): validation reports the shape, this collector must not throw on it.
export function declaredToolsByServer(manifest) {
  const byServer = new Map();
  const add = (server, names) => {
    if (!byServer.has(server)) byServer.set(server, new Set());
    for (const t of names) byServer.get(server).add(t);
  };
  const servers = Array.isArray(manifest?.mcpServers) ? manifest.mcpServers : [];
  const agents = Array.isArray(manifest?.agents) ? manifest.agents : [];
  for (const m of servers) {
    if (!m || typeof m.registryName !== "string") continue;
    if (Array.isArray(m.allowTools)) add(m.registryName, m.allowTools);
    for (const a of agents) {
      const roleList = a?.resources?.mcpTools?.[m.registryName];
      if (Array.isArray(roleList)) add(m.registryName, roleList);
    }
  }
  return byServer;
}

// ── Explicit tool face + tool-level closure (pack-tool-declaration-gate) ─────
//
// Two publish-only checks layered above the name gate. Neither belongs in
// validatePackManifest: that validator is shared with the install path, and
// legacy published versions (no declaration at all) must keep installing.
//
// 1. Every reference made a choice: a non-empty `allowTools` or
//    `fullSurface: true` plus a reason. Shape already enforces the mutual
//    exclusion and the reason; this is the "must be one of the two" rule.
// 2. Every `mcp__<server>__<tool>` named in a skill body sits inside that
//    server reference's `allowTools`. A full-surface reference is exempt (its
//    face is the whole surface by definition), and a reference with no
//    declaration is left to check 1 instead of restating it per tool.

// dsh-mcp-client's public naming convention. Server names and tool leaves are
// both `[A-Za-z0-9._-]`; the server segment is non-greedy so a leaf containing
// `__` stays whole.
const MCP_TOOL_REF_RE = /mcp__([A-Za-z0-9._-]+?)__([A-Za-z0-9._-]+)/g;

// Skill text names tools in two shapes: the explicit `mcp__server__tool`, and
// the shorthand run that follows it on the same line —
// `mcp__fd-paper-trading__list_strategy_templates / create_strategy / update_strategy`.
// The second and third names inherit the server. Parsing only the explicit form
// is what let a pack publish with `stop_strategy` named in its skills but absent
// from its own allowTools (2026-11-25: 柏讯·模拟交易套件 16/19 tools declared).
//
// The run must be a PURE sequence of ` / name` segments; the first segment that
// is not one ends it, so prose like ` / 见上文` does not absorb a word. A
// segment starting with `mcp__` is a NEW explicit reference (the outer regex
// records it under its own server), not a leaf of the current run — absorbing
// it leaked a bogus `mcp__fd` leaf onto whichever server preceded it.
const MCP_TOOL_RUN_RE = /^[ \t]*(?:\/[ \t]*`?(?!mcp__)[A-Za-z_][A-Za-z0-9_]*`?[ \t]*)+/;

// Everything the pack's skill bodies name, split by fence. `calls` are hits in
// live prose — explicit `mcp__<server>__<leaf>` plus the same-line ` / <leaf>`
// run — and are what the grant-face reconciliation judges. `examples` are the
// explicit hits inside fenced code blocks: documentation, not calls, so they
// only ever WARN (spec pack-tool-declaration-coherence: 围栏内的命中不判失败)
// and their runs are never absorbed. Shape-tolerant like every collector here.
export function skillsNamedToolsByServer(manifest) {
  const calls = new Map();
  const examples = new Map();
  const record = (map, server, tool, skillName) => {
    if (!map.has(server)) map.set(server, new Map());
    const tools = map.get(server);
    if (!tools.has(tool)) tools.set(tool, new Set());
    tools.get(tool).add(skillName);
  };
  const skills = Array.isArray(manifest?.skills) ? manifest.skills : [];
  for (const skill of skills) {
    if (typeof skill?.content !== "string") continue;
    const skillName = typeof skill.name === "string" ? skill.name : "(unnamed skill)";
    const lines = skill.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const fenced = inFence(lines, i);
      // Fresh RegExp per line (matchAll needs the global flag and no sticky
      // lastIndex carry-over); the source is a module constant.
      const refRe = new RegExp(MCP_TOOL_REF_RE.source, "g");
      for (const match of lines[i].matchAll(refRe)) {
        const server = match[1];
        record(fenced ? examples : calls, server, match[2], skillName);
        // A line inside a fenced block is an example, not a call: the explicit
        // name lands in `examples` (warned) and the run is not absorbed.
        if (fenced) continue;
        const run = MCP_TOOL_RUN_RE.exec(lines[i].slice(match.index + match[0].length));
        if (!run) continue;
        for (const part of run[0].matchAll(/\/[ \t]*`?([A-Za-z_][A-Za-z0-9_]*)/g)) {
          record(calls, server, part[1], skillName);
        }
      }
    }
  }
  return { calls, examples };
}

// Everything the pack's skill bodies NAME (fenced and not), as server → tool →
// skill names. The pack-authoring tool-level closure (toolClosureErrors) has no
// fence exemption — an example naming a tool the pack never grants is still
// instructive enough to fail that older check — so it needs the merged view.
export function namedMcpTools(manifest) {
  const { calls, examples } = skillsNamedToolsByServer(manifest);
  const all = new Map();
  for (const source of [calls, examples]) {
    for (const [server, tools] of source) {
      if (!all.has(server)) all.set(server, new Map());
      const row = all.get(server);
      for (const [tool, skillNames] of tools) {
        if (!row.has(tool)) row.set(tool, new Set());
        for (const s of skillNames) row.get(tool).add(s);
      }
    }
  }
  return all;
}

/** Was line `index` inside a ``` fence? Cheap scan; skill bodies are short. */
function inFence(lines, index) {
  let open = false;
  for (let i = 0; i < index; i += 1) {
    if (/^\s*```/.test(lines[i])) open = !open;
  }
  return open;
}

// ── Declaration coherence: what the skills NAME must be what the pack GRANTS ──
//
// The other collectors here answer "is every declared tool real?". This one
// answers the reverse and, until 2026-11-25, nobody did: a skill could tell the
// model to call `stop_strategy` while the pack never granted it. Nothing failed
// — the tool simply never appeared in the roster and the model said it did not
// have it — which is exactly the silent-degradation shape the publish gate
// exists to prevent.
//
// Scope: every (server, tool) a skill body names must be granted to that server
// by `allowTools` (or a role's `resources.mcpTools`). A skill naming a server the
// pack does not carry is also incoherent. Fenced code blocks are examples, not
// calls: their names are returned as `warnings` and never fail the publish
// (spec pack-tool-declaration-coherence); only prose hits produce errors.
export function skillDeclarationErrors(manifest) {
  const errors = [];
  const warnings = [];
  const pack = typeof manifest?.name === "string" && manifest.name ? manifest.name : "(unnamed pack)";
  const granted = declaredToolsByServer(manifest);
  const servers = new Set(
    (Array.isArray(manifest?.mcpServers) ? manifest.mcpServers : [])
      .map((m) => (m && typeof m.registryName === "string" ? m.registryName : null))
      .filter(Boolean)
  );

  const incoherent = (server, tool, skillNames) => {
    const where = `skill[${[...skillNames].join(", ")}] → ${server}__${tool}`;
    if (!servers.has(server)) {
      errors.push({
        error:
          `pack '${pack}' skill names '${server}__${tool}' but the pack carries no '${server}' reference`,
        entry: where,
        code: "skill_names_absent_server",
      });
      return;
    }
    const face = granted.get(server);
    // A reference with no declaration at all contributes the full surface, so
    // nothing can be "ungranted" against it (same rule as full-mode union).
    if (!face || face.size === 0) return;
    if (!face.has(tool)) {
      errors.push({
        error:
          `pack '${pack}' skill names '${server}__${tool}' but allowTools for '${server}' does not grant it ` +
          `— add it, or stop naming it`,
        entry: where,
        code: "skill_names_ungranted_tool",
      });
    }
  };

  const { calls, examples } = skillsNamedToolsByServer(manifest);
  for (const [server, tools] of calls) {
    for (const [tool, skillNames] of tools) incoherent(server, tool, skillNames);
  }
  // Fenced hits are examples: one warning each, granted or not, saying the hit
  // was not counted into the grant-face reconciliation.
  for (const [server, tools] of examples) {
    for (const [tool, skillNames] of tools) {
      warnings.push({
        error:
          `pack '${pack}' skill(s) [${[...skillNames].sort().join(", ")}] name '${server}__${tool}' ` +
          `inside a fenced code block — treated as an example and NOT reconciled against the grant face`,
        entry: `skill[${[...skillNames].join(", ")}] → ${server}__${tool}`,
        code: "skill_names_in_fence",
      });
    }
  }
  return { errors, warnings };
}

export function toolFaceErrors(manifest) {
  const errors = [];
  const pack = typeof manifest?.name === "string" && manifest.name ? manifest.name : "(unnamed pack)";
  const servers = Array.isArray(manifest?.mcpServers) ? manifest.mcpServers : [];
  servers.forEach((ref, i) => {
    if (!ref || typeof ref !== "object") return; // structural gate reports the entry
    const name = typeof ref.registryName === "string" ? ref.registryName : `mcpServers[${i}]`;
    const hasList = Array.isArray(ref.allowTools) && ref.allowTools.length > 0;
    if (hasList || ref.fullSurface === true) return;
    errors.push({
      error:
        `pack '${pack}' MCP reference '${name}' declares no tool face: ` +
        `declare its tool names in allowTools, or mark the reference fullSurface with a non-empty reason`,
      entry: `mcpServers:${name}`,
    });
  });
  return errors;
}

export function toolClosureErrors(manifest) {
  const errors = [];
  const pack = typeof manifest?.name === "string" && manifest.name ? manifest.name : "(unnamed pack)";
  const refs = new Map(
    (Array.isArray(manifest?.mcpServers) ? manifest.mcpServers : [])
      .filter((r) => r && typeof r.registryName === "string")
      .map((r) => [r.registryName, r]),
  );
  for (const [server, tools] of namedMcpTools(manifest)) {
    const ref = refs.get(server);
    // A server nobody declared is the server-level closure's concern; a
    // reference that declared nothing is the tool-face check's.
    if (!ref || ref.fullSurface === true) continue;
    if (!Array.isArray(ref.allowTools) || ref.allowTools.length === 0) continue;
    const allow = new Set(ref.allowTools);
    for (const [tool, skillNames] of tools) {
      if (allow.has(tool)) continue;
      const names = [...skillNames].sort().join(", ");
      errors.push({
        error:
          `pack '${pack}' skill(s) [${names}] name '${tool}' on MCP server '${server}', ` +
          `outside that reference's allowTools (add it to the declaration, or mark the reference fullSurface)`,
        entry: `mcpServers:${server}`,
      });
    }
  }
  return errors;
}

// Run the gate. Returns { errors: [{ error, entry? }], notes: string[] } —
// the errors shape matches validatePackManifest's so the editor renders both
// identically; notes are observability (skipped closure, probe fallbacks).
export async function toolGateErrors(manifest, serverInfo, {
  probe = null,
  logger = null,
  // Builtin capability surface (declare-builtin-capability-surface D1): the
  // server names the shipped platform.bundle.json itself launches. Without
  // this, a reference to a platform capability (propose_action and friends)
  // and a hallucinated name are indistinguishable — both fall through the
  // "not a registry entry" exemption below, publish green, and only surface
  // as `awaiting-local-binding` at install time (2026-11-08 live: the
  // optimizer team's proposal post could not bind after a green publish).
  isBuiltinServer = null,
  builtinRefMode = "warn",
} = {}) {
  const errors = [];
  const notes = [];
  const byServer = declaredToolsByServer(manifest);
  for (const [server, names] of byServer) {
    const entry = `mcpServers:${server}`;
    let info = null;
    try {
      info = serverInfo(server);
    } catch (err) {
      notes.push(`server info lookup failed for '${server}' (${err?.message || err})`);
    }
    if (!info) {
      const builtin = typeof isBuiltinServer === "function" ? isBuiltinServer(server) === true : null;
      if (builtin === true) {
        // A platform capability, not a market entry: it binds from the shipped
        // bundle, so its tool names are knowable only there — exempt as before.
        notes.push(`'${server}' is a bundled platform capability (not a market entry); its declarations ride as the builtin contract`);
        continue;
      }
      if (builtin === false && builtinRefMode !== "off") {
        const msg = `MCP server '${server}' is neither a registry entry nor a bundled platform capability — a reference like this can never bind at install time`;
        if (builtinRefMode === "enforce") {
          errors.push({ error: msg, entry });
        } else {
          notes.push(`${msg} (warn mode: published anyway)`);
          logger?.warn?.(`[publish-gate] ${msg}`);
        }
        continue;
      }
      // Not a registry server: a local-binding reference — exempt (spec:
      // its tool names are validated only where the local surface is
      // knowable, otherwise accepted as declared).
      notes.push(`'${server}' is not a registry entry; its declarations ride as the local binding contract`);
      continue;
    }
    const declared = [...names];
    // Commercial closure first: probe results are irrelevant to it.
    const commercial = info.commercialTools;
    if (Array.isArray(commercial)) {
      const out = declared.filter((t) => !commercial.includes(t));
      if (out.length > 0) {
        errors.push({
          error: `MCP server '${server}' is surface-registered; tools outside its commercial set may not enter a pack: ${out.join(", ")}`,
          entry,
        });
        continue;
      }
    } else if (commercial === "counts-only") {
      notes.push(`'${server}' carries surface counts but no commercial name list; closure skipped (enrich metadata.surface.commercial_tools)`);
    }
    // Existence: registry tool_list snapshot, then one live probe for misses.
    let known = Array.isArray(info.toolList) ? info.toolList : [];
    const missing = declared.filter((t) => !known.includes(t));
    if (missing.length === 0) continue;
    let probed = null;
    if (probe && info.endpoint) {
      try {
        probed = await probe(info.endpoint);
      } catch (err) {
        notes.push(`live probe of '${server}' threw (${err?.message || err})`);
      }
      if (probed === null) {
        notes.push(`live probe of '${server}' is unavailable (billing gate, auth, or network); the snapshot is unconfirmed, not confirmed-absent`);
      }
    }
    if (Array.isArray(probed)) {
      const stillMissing = missing.filter((t) => !probed.includes(t));
      notes.push(`snapshot staleness on '${server}': ${missing.length - stillMissing.length} name(s) confirmed by live probe`);
      if (stillMissing.length === 0) continue;
      errors.push({
        error: `MCP server '${server}' does not expose declared tool(s): ${stillMissing.join(", ")} (confirmed against the registry snapshot and a live probe)`,
        entry,
      });
    } else {
      // Probe unavailable: the names are UNCONFIRMED, never confirmed-absent.
      // Refusing stays (a declaration must be verifiable), but the message
      // names the actionable next step instead of asserting the tools are gone.
      errors.push({
        error:
          `MCP server '${server}' has no registry snapshot entry for declared tool(s): ${missing.join(", ")}; ` +
          `the live probe could not confirm them, so this is unresolved rather than absent — if the entry is self-reported (surface_source=self_report), restart the service so it re-reports its surface (check its /health last_surface_report); otherwise refresh the registry entry's tool_list snapshot (see docs/registry-maintenance.md §6) and publish again, or drop the names`,
        entry,
      });
    }
  }
  for (const note of notes) logger?.warn?.(`[publish-tool-gate] ${note}`);
  return { errors, notes };
}

// ── Minimal MCP Streamable-HTTP probe ────────────────────────────────────────
// One initialize + initialized + tools/list round against a server endpoint,
// bounded by timeout. Returns the tool NAME list, or null on any failure —
// the gate treats an unavailable probe as "snapshot is the verdict", never
// as evidence of existence.
export async function probeMcpToolNames(endpoint, { timeoutMs = 5000, fetchImpl = null, headers = {} } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let lastError = null;
  try {
    const base = String(endpoint).replace(/\/+$/, "");
    const post = async (body, session) => {
      const res = await doFetch(base, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(session ? { "Mcp-Session-Id": session } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // Classify the failure: callers must be able to tell "the billing
        // gate blocked the public route" from "this credential is not valid
        // for the upstream" — they have different fixes.
        let kind = `HTTP ${res.status}`;
        try {
          const txt = await res.text();
          const code = JSON.parse(txt)?.detail?.error;
          if (code) kind = `HTTP ${res.status} ${code}`;
          else if (res.status === 401 || res.status === 403) kind = `HTTP ${res.status} (not authorized for this endpoint — the upstream wants its own credential, not the registry token)`;
        } catch { /* body already consumed or unparsable */ }
        throw new Error(kind);
      }
      const sid = res.headers.get("mcp-session-id");
      // Streamable-HTTP may answer plain JSON or SSE-framed (one data: line
      // per JSON-RPC frame); accept both — strip the event framing, then the
      // first parseable {...} line wins.
      const text = await res.text();
      for (const line of text.split("\n")) {
        let trimmed = line.trim();
        if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          return { json: JSON.parse(trimmed), session: sid || session || null };
        } catch { /* multi-line or keepalive framing — try the next line */ }
      }
      throw new Error("no JSON-RPC frame in response");
    };
    const init = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "paas-publish-tool-gate", version: "1" },
      },
    });
    if (init.json?.error) throw new Error(`initialize: ${init.json.error.message || "rejected"}`);
    // The notification the protocol requires before requests; servers that
    // run stateless simply ignore it.
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.session).catch(() => {});
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.session);
    if (list.json?.error) throw new Error(`tools/list: ${list.json.error.message || "rejected"}`);
    const tools = list.json?.result?.tools;
    if (!Array.isArray(tools)) throw new Error("malformed tools/list result");
    return tools.map((t) => t?.name).filter((n) => typeof n === "string");
  } catch (err) {
    lastError = err;
    return null;
  } finally {
    clearTimeout(timer);
    if (lastError) {
      // Surfaced at warn level by the caller's logger; the gate's own error
      // text stays actionable without leaking this string into user-facing
      // validation errors.
      probeMcpToolNames.lastError = lastError;
    }
  }
}
probeMcpToolNames.lastError = null;
