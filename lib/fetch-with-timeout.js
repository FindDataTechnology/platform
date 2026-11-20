// ── Outbound fetch timeout discipline (openspec: harden-cell-execution-reliability) ──
//
// Every outgoing HTTP call from platform processes carries a bounded timeout:
// fetchWithTimeout() wraps fetch with a default deadline (env
// PLATFORM_FETCH_TIMEOUT_MS, 10s) that any call site may override per call.
// Timeout failures surface as structured FetchTimeoutError (code "FETCH_TIMEOUT",
// retryable) instead of hangs; network-class transport failures classify as
// retryable via isRetryableFetchError(), while 4xx-semantic refusals do not
// (isRetryableHttpStatus() for call sites that convert non-ok responses).
//
// Scope of the deadline: it bounds the call until RESPONSE HEADERS arrive;
// body streaming afterwards is intentionally not bounded here so SSE/stream
// lanes keep working (undici's own headersTimeout/bodyTimeout backstop the
// rest). Lanes that stream for their whole lifetime (chat completions with
// stream:true, reverse-proxy pass-throughs) are exempt from the wrapper with
// an inline comment at the call site — same discipline as the exemption note
// this spec mandates.

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const TIMEOUT_ENV_KEY = "PLATFORM_FETCH_TIMEOUT_MS";

// The effective default deadline, read at call time (not module load) so
// tests and one-shot scripts can retune it via env without reimporting.
export function platformFetchTimeoutMs(env = process.env) {
  const raw = Number(env[TIMEOUT_ENV_KEY]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FETCH_TIMEOUT_MS;
}

export class FetchTimeoutError extends Error {
  constructor(timeoutMs, url) {
    super(`outbound fetch timed out after ${timeoutMs}ms${url ? `: ${url}` : ""}`);
    this.name = "FetchTimeoutError";
    this.code = "FETCH_TIMEOUT";
    this.retryable = true;
    this.timeoutMs = timeoutMs;
  }
}

// HTTP-level retryability, for call sites that turn a non-ok response into an
// Error: 408/429/5xx are transient (retry), other 4xx are semantic refusals
// (bad request, auth, policy — retrying verbatim cannot succeed).
export function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

// Structured retryability verdict for a thrown fetch failure:
//   timeout (FetchTimeoutError, or a raw TimeoutError leaked from
//   AbortSignal.timeout) → retryable — the endpoint stalled, not the request;
//   network-class transport failure (TypeError "fetch failed", optionally with
//   an undici/errno cause code) → retryable;
//   caller-initiated abort (AbortError) → NOT retryable — the caller cancelled;
//   anything else (4xx-semantic conversions, unexpected shapes) → not retryable.
export function isRetryableFetchError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  if (err.code === "FETCH_TIMEOUT" || err.name === "FetchTimeoutError") return true;
  if (err.name === "TimeoutError") return true;
  if (err.name === "AbortError") return false;
  if (err instanceof TypeError && /fetch failed/i.test(String(err.message || ""))) {
    const causeCode = err.cause?.code;
    return typeof causeCode !== "string" || RETRYABLE_NETWORK_CODES.has(causeCode);
  }
  return false;
}

// Compose the caller's signal (if any) with the deadline signal so BOTH can
// cancel: a caller abort keeps its own reason (AbortError), the deadline
// carries the structured FetchTimeoutError as its abort reason. AbortSignal.any
// exists since Node 20.3; the listener fallback covers older runtimes.
function composeSignals(caller, deadline) {
  if (!caller) return deadline.signal;
  if (caller.aborted) return caller;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, deadline.signal]);
  const composed = new AbortController();
  const relay = (from) => () => composed.abort(from.reason);
  caller.addEventListener("abort", relay(caller), { once: true });
  deadline.signal.addEventListener("abort", relay(deadline.signal), { once: true });
  return composed.signal;
}

// The shared wrapper. `opts.timeoutMs` overrides the env default per call site;
// `opts.fetchImpl` threads a module's injected fetch seam (testability) through
// the deadline; `opts.env` reads the default out of a non-process env object.
// Rejections pass through untranslated except that a deadline breach rejects
// with FetchTimeoutError — the abort reason rides the signal, so injected test
// fetches that honor `init.signal` surface it naturally.
export function fetchWithTimeout(input, init = {}, opts = {}) {
  const impl = opts.fetchImpl ?? fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : platformFetchTimeoutMs(opts.env);
  const url = typeof input === "string" ? input : (input?.url ?? "");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new FetchTimeoutError(timeoutMs, url)), timeoutMs);
  let promise;
  try {
    promise = Promise.resolve(
      impl(input, { ...init, signal: composeSignals(init.signal, deadline) }),
    );
  } catch (err) {
    // A synchronously throwing impl (bad mock, invalid request shape) must not
    // leak the pending timer.
    clearTimeout(timer);
    throw err;
  }
  // The deadline covers the wait for response headers; once the promise
  // settles (headers in, or failed) the timer is gone and body streaming is
  // free-running per the module comment above.
  return promise.finally(() => clearTimeout(timer));
}
