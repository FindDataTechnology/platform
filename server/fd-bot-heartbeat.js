// fd-bot heartbeat (adopt-fd-bot-transport 8.1).
//
// The failure this prevents: fd-bot dies, every bot row on it silently delivers
// nothing, and the cell looks exactly like "nobody is messaging the bot". A
// transport that is DOWN and a channel that is QUIET must not read the same, or
// the outage is discovered by a customer.
//
// Shape: poll /health; after N consecutive failures log one STABLE-tagged line
// and fire the operator's alert hook ONCE per outage (not once per poll — an
// alert every 30s is noise that trains people to ignore it). Recovery also logs,
// so the end of an outage is visible.
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

export const DOWN_TAG = "[fd-bot][transport-unavailable]";
export const UP_TAG = "[fd-bot][transport-recovered]";

export function createFdBotHeartbeat({
  url = () => (process.env.FD_BOT_URL || "").replace(/\/+$/, ""),
  threshold = Number(process.env.FD_BOT_HEARTBEAT_FAILS) || 3,
  intervalMs = Number(process.env.FD_BOT_HEARTBEAT_MS) || 30_000,
  fetchImpl = null,
  alert = null,
  log = console,
} = {}) {
  let failures = 0;
  let down = false;
  let timer = null;

  async function probe() {
    const base = url();
    if (!base) return { state: "unconfigured" }; // no fd-bot transport in use
    try {
      const r = await fetchWithTimeout(`${base}/health`, {}, { fetchImpl, timeoutMs: 5_000 });
      // Drain the body: an unread response poisons the next call.
      await r.text();
      if (r.ok) {
        if (down) {
          down = false;
          failures = 0;
          log.log(`${UP_TAG} fd-bot is answering again at ${base}`);
          await alert?.({ kind: "recovered", url: base });
        } else {
          failures = 0;
        }
        return { state: "up" };
      }
      throw new Error(`health answered ${r.status}`);
    } catch (err) {
      failures += 1;
      if (!down && failures >= threshold) {
        down = true;
        // Stable tag + actionable sentence. The operator cannot act on
        // "fetch failed"; they can act on "IM delivery on every fd-bot bot is
        // stopped".
        log.error(
          `${DOWN_TAG} fd-bot unreachable at ${base} after ${failures} attempts (${err.message}). ` +
            "Bots on the fd-bot transport are receiving nothing; in-cell bots are unaffected.",
        );
        await alert?.({ kind: "down", url: base, attempts: failures, error: err.message });
      }
      return { state: "down", failures };
    }
  }

  function start() {
    if (timer) return timer;
    timer = setInterval(() => void probe(), intervalMs);
    timer.unref?.();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    probe,
    start,
    stop,
    // Introspection for tests and for an ops read face.
    get status() {
      return { down, failures, threshold };
    },
  };
}
