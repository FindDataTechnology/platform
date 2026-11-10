// ── Registry client (runner side) ───────────────────────────────────────────
//
// Read-only view of the registry as the runtime distribution plane: which a2a
// agents exist (the runner's catalog), and the skill bodies a deployment
// descriptor references. Writes happen only at deploy time (lib/agent-serving).

function client(registryUrl, token, fetchImpl) {
  const doFetch = fetchImpl
    ? (p, init) => fetchImpl(p, init)
    : (p, init = {}) =>
        fetch(registryUrl + p, {
          ...init,
          headers: {
            Accept: "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...init.headers,
          },
        });
  return async (p) => {
    const res = await doFetch(p);
    if (!res.ok) throw new Error(`registry GET ${p} failed (${res.status})`);
    return res.json();
  };
}

// Hosted subset: enabled a2a agents that carry a paas deployment descriptor
// (metadata.packId), sharded by runner assignment (add-runner-fleet-sharding
// D1): an entry tagged metadata.runner_id belongs to that runner; untagged
// entries belong to the default runner (config default = the runner's own
// fleet id, so the legacy single-runner deployment keeps the whole untagged
// fleet with zero migration).
export function createRegistryClient({ registryUrl, token: tokenOpt, registryToken, fetchImpl, runnerId = null, defaultRunnerId = null }) {
  const token = tokenOpt ?? registryToken;
  const get = client(registryUrl, token, fetchImpl);

  // Paginated list read (registry-list-completeness): the registry defaults to
  // limit=20 and reports has_next, so one page is not the full set. A runner
  // that read a single page would silently stop serving the tail of its fleet.
  const LIST_PAGE_LIMIT = 500;
  const LIST_MAX_PAGES = 100;
  async function listAllPages(path) {
    const items = [];
    let offset = 0;
    let complete = false;
    let reportedTotal = null;
    const seenFirst = new Set();
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const doc = await get(`${path}?limit=${LIST_PAGE_LIMIT}&offset=${offset}`);
      const rows = Array.isArray(doc) ? doc : (doc?.agents ?? doc?.items ?? []);
      const firstPath = rows.length ? (rows[0]?.path ?? rows[0]?.name ?? null) : null;
      if (page > 0 && firstPath !== null && seenFirst.has(firstPath)) break;
      if (firstPath !== null) seenFirst.add(firstPath);
      items.push(...rows);
      const total = Number.isFinite(Number(doc?.total_count)) ? Number(doc.total_count) : null;
      if (total !== null) reportedTotal = total;
      const hasNext =
        typeof doc?.has_next === "boolean"
          ? doc.has_next
          : total !== null
            ? items.length < total
            : rows.length >= LIST_PAGE_LIMIT;
      if (!hasNext) {
        complete = true;
        break;
      }
      if (rows.length === 0) break;
      const nextOffset = offset + rows.length;
      if (nextOffset <= offset) break;
      offset = nextOffset;
    }
    if (!complete) {
      console.warn(
        `[agent-runner] ${path}: truncated read — retrieved ${items.length} of ${reportedTotal ?? "?"} entries`,
      );
    }
    return items;
  }

  return {
    async listServedAgents() {
      const rows = await listAllPages("/api/agents");
      return rows.filter(
        (a) =>
          a &&
          a.is_enabled !== false &&
          String(a.supported_protocol || "").toLowerCase() === "a2a" &&
          a.metadata &&
          typeof a.metadata === "object" &&
          a.metadata.packId &&
          // Sharding filter: no runnerId configured = the pre-fleet hosting
          // behavior (every qualifying entry), matching the v1 contract.
          (runnerId == null || (a.metadata.runner_id ?? defaultRunnerId ?? runnerId) === runnerId),
      );
    },

    async fetchSkillContent(contentPath) {
      const p = contentPath.startsWith("/") ? contentPath : `/${contentPath}`;
      const doc = await get(`/api/skills${p}/content`);
      if (typeof doc?.content !== "string") throw new Error(`no content returned for ${contentPath}`);
      return doc.content;
    },

    // MCP endpoint for a registry server name — the same convention the
    // market's configTemplate uses (`{REGISTRY_URL}/{name}/mcp`), called with
    // the runner's service credential (design D8).
    mcpUrlFor(name) {
      return `${registryUrl}/${name}/mcp`;
    },
  };
}
