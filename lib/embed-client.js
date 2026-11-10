// ── Library embedding client (optional semantic rung) ───────────────────────
//
// Talks to an OpenAI-compatible `/embeddings` endpoint (the 词元 lane is one).
// Deliberately tiny and injectable: `createEmbedder({ fetchImpl, config })`
// returns a plain object, so tests fake the transport instead of stubbing a
// network library.
//
// Two disciplines carried over from the memory lane (memory-digest-embed-lane),
// implemented here rather than imported — that module is coupled to digest
// rendering, this one must stay a dependency-free client:
//
//   1. `dimensions` is ALWAYS sent explicitly. ciyuan-embedding-lane: the
//      dimension is a contract only when the caller requests it; omitted, the
//      account's pinned provider decides, and a provider switch would silently
//      make every stored vector incomparable.
//   2. The wait budget is derived from recent REAL latencies (p90 x margin),
//      clamped to configured bounds — not a fixed constant, and not "wait
//      forever". Slow samples are recorded too, so a bimodal lane cannot
//      collapse the budget to zero.
//
// This module NEVER throws for a degraded lane: callers get a classified result
// and decide. That keeps the library usable when the lane is down (the lexical
// rung still answers).

// Retryable means "the same request may succeed later". Anything else is a
// permanent mismatch — retrying it just burns quota.
const RETRYABLE_HINTS = [
  "429", "rate limit", "status=5", "timeout", "timed out",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "socket hang up", "fetch failed",
];

export function isRetryableFailure(err) {
  const text = `${err?.name || ""} ${err?.message || ""}`.toLowerCase();
  return RETRYABLE_HINTS.some((h) => text.includes(h.toLowerCase()));
}

export class EmbedError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "EmbedError";
    this.retryable = retryable;
  }
}

// ── Config ─────────────────────────────────────────────────────────────────
//
// Off unless a base URL is configured: the rung is opt-in, and "no provider
// configured" must never be a runtime surprise.
export function readEmbedConfig(env = process.env) {
  const baseUrl = String(env.LIBRARY_EMBED_BASE_URL || "").trim();
  return {
    baseUrl,
    apiKey: String(env.LIBRARY_EMBED_API_KEY || "").trim(),
    model: String(env.LIBRARY_EMBED_MODEL || "").trim(),
    dimensions: Number(env.LIBRARY_EMBED_DIMENSIONS) || 0,
    // Budget bounds in ms; the effective wait is derived from recent latencies.
    budgetFloorMs: Number(env.LIBRARY_EMBED_BUDGET_FLOOR_MS) || 800,
    budgetCeilingMs: Number(env.LIBRARY_EMBED_BUDGET_CEILING_MS) || 8000,
    batchSize: Number(env.LIBRARY_EMBED_BATCH) || 16,
    configured: Boolean(baseUrl && env.LIBRARY_EMBED_MODEL),
  };
}

// ── Adaptive budget ────────────────────────────────────────────────────────
//
// p90 of recent successful latencies x margin, clamped. Samples are kept in
// insertion order and trimmed to a window; timeouts are recorded so the budget
// does not "learn" only from fast calls.
export function createLatencyBudget({
  window = 50, margin = 1.5, floorMs = 800, ceilingMs = 8000,
} = {}) {
  const samples = [];
  const clamp = (v) => Math.max(floorMs, Math.min(ceilingMs, v));
  return {
    record(ms) {
      samples.push(ms);
      if (samples.length > window) samples.shift();
    },
    // No samples yet: the ceiling is the safe default (first call may be cold).
    next() {
      if (!samples.length) return clamp(ceilingMs);
      const sorted = [...samples].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9));
      return clamp(Math.round(sorted[idx] * margin));
    },
    samples: () => [...samples],
  };
}

// ── Client ─────────────────────────────────────────────────────────────────

export function createEmbedder({ config, fetchImpl = globalThis.fetch } = {}) {
  const cfg = config || readEmbedConfig();
  const budget = createLatencyBudget({
    floorMs: cfg.budgetFloorMs, ceilingMs: cfg.budgetCeilingMs,
  });

  async function embedBatch(texts) {
    if (!cfg.configured) {
      throw new EmbedError("嵌入通道未配置（LIBRARY_EMBED_BASE_URL / MODEL 缺失）", {
        retryable: false,
      });
    }
    const body = { model: cfg.model, input: texts };
    if (cfg.dimensions) body.dimensions = cfg.dimensions; // explicit, always

    const wait = budget.next();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), wait);
    const startedAt = Date.now();
    let res;
    try {
      res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // A budget timeout is a degradation, not a bug: classify it retryable.
      const timedOut = err?.name === "AbortError";
      throw new EmbedError(
        timedOut ? `embed 超预算（${wait}ms）` : `embed 请求失败：${err?.message || err}`,
        { retryable: timedOut || isRetryableFailure(err), cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new EmbedError(`embed 上游 ${res.status}: ${detail.slice(0, 200)}`, {
        retryable: res.status === 429 || res.status >= 500,
      });
      throw err;
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new EmbedError("embed 响应不是合法 JSON", { retryable: true, cause: err });
    }
    const data = json?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new EmbedError(
        `embed 响应形状不符：期望 ${texts.length} 条，收到 ${Array.isArray(data) ? data.length : "非数组"}`,
        { retryable: false },
      );
    }

    const vectors = data.map((d) => d?.embedding);
    const dims = new Set(vectors.map((v) => (Array.isArray(v) ? v.length : -1)));
    if (dims.size !== 1 || dims.has(-1)) {
      throw new EmbedError("embed 响应内向量长度不一致", { retryable: false });
    }
    const dim = [...dims][0];
    // The requested dimension is a contract: a provider that answers another
    // width is a mismatch to reject, not something to store and discover later.
    if (cfg.dimensions && dim !== cfg.dimensions) {
      throw new EmbedError(
        `embed 维度漂移：请求 ${cfg.dimensions}，返回 ${dim}`, { retryable: false },
      );
    }

    budget.record(Date.now() - startedAt);
    return { vectors, model: cfg.model, dim };
  }

  return { embedBatch, budget, config: cfg };
}

// Float32 vector <-> Buffer, for the BLOB column.
export function encodeVector(vec) {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeVector(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// Cosine similarity over Float32Array. Vectors from a normalising provider are
// unit-length, but we do not assume it.
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
