// Memory panel API (add-unified-memory-and-outputs 3.3): thin client over the
// cell's /api/memory proxy — the panel never talks to fd-memory directly.

export interface MemoryEntry {
  path: string;
  title: string;
  project: string;
  layer: "L0" | "L1" | "L2";
  type?: string;
  sources?: string[];
  tags?: string[];
  tier?: string;
  source_ref?: string | null;
  ts: string;
}

export interface MemoryQuery {
  scope?: string;
  layer?: string;
  tier?: string;
  tags?: string[];
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

function toQuery(q: MemoryQuery): string {
  const u = new URLSearchParams();
  if (q.scope) u.set("scope", q.scope);
  if (q.layer) u.set("layer", q.layer);
  if (q.tier) u.set("tier", q.tier);
  if (q.tags?.length) u.set("tag", q.tags.join(","));
  if (q.since) u.set("since", q.since);
  if (q.until) u.set("until", q.until);
  if (q.limit != null) u.set("limit", String(q.limit));
  if (q.offset != null) u.set("offset", String(q.offset));
  const qs = u.toString();
  return qs ? `?${qs}` : "";
}

export async function listMemoryEntries(q: MemoryQuery = {}): Promise<{ items: MemoryEntry[] }> {
  const res = await fetch(`/api/memory/entries${toQuery(q)}`, { credentials: "same-origin" });
  if (!res.ok) {
    let code = "memory_read_failed";
    try { code = ((await res.json()) as { code?: string }).code ?? code; } catch { /* non-JSON */ }
    throw Object.assign(new Error(code), { code });
  }
  const doc = (await res.json()) as { items?: MemoryEntry[] };
  return { items: Array.isArray(doc.items) ? doc.items : [] };
}

export async function listDeployerMemoryEntries(rootKey: string, q: MemoryQuery = {}): Promise<{ items: MemoryEntry[] }> {
  const u = new URLSearchParams({ rootKey });
  const extra = toQuery(q);
  const res = await fetch(`/api/memory/deployer-entries?${u.toString()}${extra ? `&${extra.slice(1)}` : ""}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error("memory_read_failed");
  const doc = (await res.json()) as { items?: MemoryEntry[] };
  return { items: Array.isArray(doc.items) ? doc.items : [] };
}

// Pack memory policy (add-pack-memory-declaration 3.4): the four-column read
// face for the pack root a team shares. The row set is the MEMORY SERVICE's
// answer, not ours — this client only names the shape, so a column added
// upstream arrives here as data rather than as a code change.
export interface PolicyRow {
  declared: string | number | null;
  inherited_from: string | null;
  effective: string | number | null;
  executed: boolean;
  // Present only when the STORED row could not be parsed (out-of-band write,
  // older version, restore). When set, `effective` is not a declaration in
  // force — the panel must say so rather than render a number.
  invalid?: { code: string; message: string; level: string };
}

export interface PackPolicy {
  rootKey: string;
  project?: string;
  rows: Record<string, PolicyRow>;
  not_executed?: string[];
  deployment_default?: Record<string, string | number>;
  // Keys nobody knows: they produce no row at all, so this list is the only
  // place they can appear.
  stored_invalid?: Array<{ level: string; key: string; code: string; message: string }>;
  // Where the policy lives. The scope is the PACK root, shared by every team
  // landed from it — never render it as "this team only".
  policy_root?: string;
  scope?: string;
}

export async function getPackPolicy(packId: string): Promise<PackPolicy> {
  const res = await fetch(`/api/memory/policy?packId=${encodeURIComponent(packId)}`, { credentials: "same-origin" });
  if (!res.ok) {
    let code = "memory_read_failed";
    try { code = ((await res.json()) as { code?: string }).code ?? code; } catch { /* non-JSON */ }
    throw Object.assign(new Error(code), { code });
  }
  return (await res.json()) as PackPolicy;
}

// Tier promotion proposals (add-tier-promotion-candidates 5.1): AI proposes
// draft→stable but never applies it — the owner sees each pending proposal
// here and accepts or ignores. Reusing the /api/memory proxy identity seam.
export interface PromotionProposal {
  path: string;
  project?: string;
  type?: string;
  title: string;
  current_tier: string;
  proposed_tier: string;
  reason: string;
  proposed_by: string;
  proposed_at: string;
}

export async function listPromotions(scope?: string): Promise<{ proposals: PromotionProposal[] }> {
  const u = new URL("/api/memory/promotions");
  if (scope?.trim()) u.searchParams.set("scope", scope.trim());
  const res = await fetch(u.toString(), { credentials: "same-origin" });
  if (!res.ok) {
    let code = "memory_read_failed";
    try { code = ((await res.json()) as { code?: string }).code ?? code; } catch { /* non-JSON */ }
    throw Object.assign(new Error(code), { code });
  }
  const doc = (await res.json()) as { proposals?: PromotionProposal[] };
  return { proposals: Array.isArray(doc.proposals) ? doc.proposals : [] };
}

async function promotionGesture(kind: "accept" | "ignore", path: string): Promise<{ ok: boolean; stale?: boolean; tier?: string }> {
  const res = await fetch(`/api/memory/promotions/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ path }),
  });
  if (res.status === 409) return { ok: false, stale: true };
  if (!res.ok) {
    let code = "memory_gesture_failed";
    try { code = ((await res.json()) as { code?: string }).code ?? code; } catch { /* non-JSON */ }
    throw Object.assign(new Error(code), { code });
  }
  const doc = (await res.json()) as { tier?: string };
  return { ok: true, tier: doc.tier };
}

export const acceptPromotion = (path: string) => promotionGesture("accept", path);
export const ignorePromotion = (path: string) => promotionGesture("ignore", path);
