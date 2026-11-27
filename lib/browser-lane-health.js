// ── Shared browser lane: reachability for the health + memory faces ─────────
//
// slim-browser-lane-footprint 3.2. Once the lane is a pod-level service, its
// state cannot be read from a cell's process table any more — the faces need to
// say "the shared browser service is up (or down)" explicitly, because that is
// now the single point every cell's browser tools depend on.
//
// Two consumers, one probe: /healthz (deployment liveness) and the memory face
// row (footprint + a grey state when unreachable). The probe is cached for a
// short TTL so a polling cockpit cannot turn into a request storm against the
// service it is measuring.

const DEFAULT_TTL_MS = 2000;

// BROWSER_SHARED_MCP_URL points at the MCP endpoint; the service's own health
// face lives at /healthz on the same origin.
export function browserLaneHealthUrl(env = process.env) {
  const raw = (env.BROWSER_SHARED_MCP_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}/healthz`;
  } catch {
    return null;
  }
}

async function defaultFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, body };
  } catch {
    return { ok: false, body: null };
  } finally {
    clearTimeout(timer);
  }
}

export function createBrowserLaneHealthProbe({
  env = process.env,
  fetchImpl = defaultFetch,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = 1000,
  now = Date.now,
} = {}) {
  const url = browserLaneHealthUrl(env);
  let cached = null;
  let checkedAt = 0;
  return {
    get configured() {
      return url != null;
    },
    get url() {
      return url;
    },
    // Never throws: an unreachable lane is a state, not an error.
    async probe() {
      if (!url) return { configured: false, reachable: false };
      if (cached && now() - checkedAt < ttlMs) return cached;
      let ok = false;
      let body = null;
      try {
        ({ ok, body } = await fetchImpl(url, timeoutMs));
      } catch {
        // An unreachable lane is a STATE, not an error — the faces must render
        // "down", never a 500.
        ok = false;
        body = null;
      }
      cached = {
        configured: true,
        url,
        reachable: Boolean(ok && body?.ok !== false),
        ...(body?.sessions != null ? { sessions: body.sessions } : {}),
        ...(body?.upstream?.mode ? { upstreamMode: body.upstream.mode } : {}),
        checkedAt: now(),
      };
      checkedAt = now();
      return cached;
    },
  };
}
