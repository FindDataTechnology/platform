// ── Facade → fleet-observer reporter (add-fleet-event-backbone 6.3) ─────────
//
// Cross-process reporting while the facade still lives in the paas gateway
// (program slice ② moves it into the Wanxing plane and swaps this for the
// in-process store write). In-memory queue + timer flush + retry: the
// facade's request path never blocks on observability. Settled rows report
// with the usage row's id as the event id — deterministic, so the pending
// sweep and the inline settle can both report the same row exactly once on
// the observer. Inert without a URL.

import { randomBytes } from "node:crypto";

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(now) {
  let ts = now;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ENC[ts % 32] + out;
    ts = Math.floor(ts / 32);
  }
  const rnd = randomBytes(10);
  for (let i = 0; i < 16; i++) {
    const b = rnd[i >> 1];
    out += ENC[i % 2 ? b & 0x0f : b >> 4];
  }
  return out;
}

const QUEUE_CAP = 20_000;

export function createFleetReporter({ url, token, source = "facade", fetchImpl = null, now = Date.now, flushIntervalMs = 5_000, maxBatch = 500, log = null }) {
  const say = log ?? (() => {});
  const queue = [];
  let timer = null;
  let flushing = false;

  const report = ({ kind, agent, payload = {}, id = null }) => {
    if (!url) return;
    queue.push({
      id: id ?? ulid(now()),
      source,
      agent,
      kind,
      ts: now(),
      payload,
    });
    while (queue.length > QUEUE_CAP) queue.shift();
  };

  async function flush() {
    if (!url || flushing || queue.length === 0) return;
    flushing = true;
    try {
      const batch = queue.slice(0, maxBatch);
      const res = await (fetchImpl ?? fetch)(`${url.replace(/\/+$/, "")}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        say(`flush refused (${res.status}) — keeping ${queue.length}`);
        return;
      }
      queue.splice(0, batch.length);
    } catch (e) {
      say(`flush failed: ${e?.message || e} — keeping ${queue.length}`);
    } finally {
      flushing = false;
    }
  }

  return {
    report,
    flush,
    start() {
      if (!url || timer) return;
      void flush();
      timer = setInterval(() => void flush(), flushIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      void flush();
    },
  };
}
