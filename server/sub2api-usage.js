// ── 萬星词元 usage attribution (run-card-bridge) ─────────────────────────────
//
// The billing truth for a turn is sub2api's `usage_logs.actual_cost`, read
// through the authenticated GET /api/v1/usage face. A task card has no run id,
// so attribution is by execution window: each usage row is assigned to the one
// card whose [first history time, last history time] contains it. If a row
// falls in more than one card's window, it is NOT attributed to either — a
// double count is worse than an unknown.
//
// Failures (no key, unreachable, non-200) return an empty map; the board then
// shows USD as unknown. This module never invents a number.

const DAY_MS = 86_400_000;

export function usageEndpoint(llmBase) {
  const url = new URL(llmBase);
  return `${url.origin}/api/v1/usage`;
}

export function cardWindow(card) {
  const times = (card.history ?? [])
    .map((entry) => Date.parse(entry?.time ?? ""))
    .filter((t) => Number.isFinite(t));
  if (times.length) return { start: Math.min(...times), end: Math.max(...times) };
  const start = Date.parse(card.flow?.stakedAt ?? "");
  const end = Date.parse(card.flow?.verdict?.at ?? "");
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return { start, end };
  return null;
}

export function attributeUsage(rows, cards) {
  const windows = cards
    .map((card) => ({ id: card.id, window: cardWindow(card) }))
    .filter((entry) => entry.window);
  const out = new Map();
  for (const { id } of windows) out.set(id, { usd: 0, rows: 0, ambiguous: false });

  for (const row of rows ?? []) {
    const at = Date.parse(row?.created_at ?? "");
    const cost = Number(row?.actual_cost);
    if (!Number.isFinite(at) || !Number.isFinite(cost)) continue;
    const hits = windows.filter(({ window }) => at >= window.start && at <= window.end);
    if (hits.length === 1) {
      const entry = out.get(hits[0].id);
      entry.usd += cost;
      entry.rows += 1;
    } else if (hits.length > 1) {
      // Ambiguous: refuse to attribute rather than count it twice.
      for (const { id } of hits) out.get(id).ambiguous = true;
    }
  }

  for (const [id, entry] of out) {
    if (entry.rows === 0 && !entry.ambiguous) out.delete(id);
  }
  return out;
}

export async function readUsageWindow({ start, end, env = process.env, fetchImpl = fetch, maxPages = 10 } = {}) {
  const base = env.LLM_BASE_URL;
  const key = env.LLM_API_KEY;
  if (!base || !key) throw new Error("LLM_BASE_URL / LLM_API_KEY not configured");
  const endpoint = usageEndpoint(base);
  const startDate = new Date(start).toISOString().slice(0, 10);
  const endDate = new Date(end + DAY_MS).toISOString().slice(0, 10);

  const rows = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      page: String(page),
      page_size: "100",
      sort_by: "created_at",
      sort_order: "asc",
    });
    const response = await fetchImpl(`${endpoint}?${params}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`usage HTTP ${response.status}`);
    const doc = await response.json().catch(() => ({}));
    const data = doc?.data ?? doc;
    const items = Array.isArray(data?.items) ? data.items : [];
    rows.push(...items);
    if (items.length < 100 || page >= Number(data?.pages ?? 1)) break;
  }
  return rows.filter((row) => {
    const at = Date.parse(row?.created_at ?? "");
    return Number.isFinite(at) && at >= start && at <= end;
  });
}
