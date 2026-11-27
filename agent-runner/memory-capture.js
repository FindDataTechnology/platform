// Platform-seam memory capture (add-fleet-memory-v1 D6; fix-memory-capture-p0
// D1): the manager already sees every turn's events at the same seam usage
// events flow through — this client turns those observations into hooks-shaped
// events for the fleet memory capture API. Fail-open by contract: no capture
// failure may ever affect a turn, and gaps are logged, never retried forever.
//
// Every queued event carries the namespace of the deployment that produced it
// (one runner hosts many). Flush groups the batch by namespace and POSTs one
// body per group, so a queue holding observations from several deployments can
// never deliver A's events into B's namespace — the single-namespace field this
// file used to keep was exactly that cross-deployment misfile channel.

const FLUSH_MS = 2000;
const MAX_BACKOFF_MS = 60_000;
const BATCH = 100;

// One-line compact JSON for pre-tool-use summaries (fix-memory-capture-p0 D3);
// dsh hands tool arguments over as a raw JSON string, so parse-first keeps the
// summary canonical instead of double-escaped.
export function compactJsonText(value, maxChars) {
  let s;
  if (typeof value === "string") {
    try { s = JSON.stringify(JSON.parse(value)); } catch { s = value; }
  } else {
    try { s = JSON.stringify(value); } catch { s = String(value); }
  }
  s = String(s ?? "");
  const max = Math.max(1, Number(maxChars) || 1);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export class MemoryCapture {
  constructor({ url, token, fetchImpl = fetch, log = console, now = () => Date.now() } = {}) {
    this.url = String(url || "").replace(/\/+$/, "");
    this.token = String(token || "");
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.now = now;
    this.queue = []; // { namespace, event }
    this.timer = null;
    this.backoffMs = 0;
    this.droppedBatches = 0;
  }

  get enabled() {
    return Boolean(this.url && this.token);
  }

  // Observe one lifecycle event from the manager's viewpoint (hooks-shaped:
  // user-prompt-submit / pre-tool-use / post-tool-use / stop …). Pure enqueue —
  // network happens on the flush timer, never on the turn's path.
  observe({ namespace, sessionId, event = "stop", toolName = null, summary = "", at } = {}) {
    if (!this.enabled || !namespace || !sessionId) return;
    const e = {
      event: String(event || "stop"),
      session_id: String(sessionId),
      agent: "platform-manager",
      summary: String(summary ?? "").slice(0, 2000),
      at: at ?? new Date(this.now()).toISOString(),
    };
    if (toolName) e.tool_name = String(toolName).slice(0, 200);
    this.queue.push({ namespace: String(namespace), event: e });
    this.#scheduleFlush();
  }

  #scheduleFlush() {
    if (this.timer) return;
    const delay = FLUSH_MS + this.backoffMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#flush().catch(() => {});
    }, delay);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async #flush() {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, BATCH);
    const groups = new Map();
    for (const item of batch) {
      if (!groups.has(item.namespace)) groups.set(item.namespace, []);
      groups.get(item.namespace).push(item.event);
    }
    let failedAny = false;
    for (const [namespace, events] of groups) {
      try {
        const res = await this.fetchImpl(`${this.url}/capture`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ events, namespace }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        // Fail-open per GROUP: this namespace's events requeue with a counted
        // gap line, never retried into infinity and never thrown into a turn's
        // path; the other namespaces in the same flush already went out.
        failedAny = true;
        this.droppedBatches += 1;
        const room = Math.max(0, BATCH - this.queue.length);
        this.queue.unshift(...batch.filter((i) => i.namespace === namespace).slice(0, room));
        this.backoffMs = Math.min(MAX_BACKOFF_MS, (this.backoffMs || 1000) * 2);
        this.log.warn?.(`[agent-runner] memory capture gap #${this.droppedBatches} ns=${namespace} (${e.message}); turns unaffected`);
        this.#scheduleFlush();
      }
    }
    if (!failedAny) this.backoffMs = 0;
  }

  async drain() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.#flush().catch(() => {});
  }
}
