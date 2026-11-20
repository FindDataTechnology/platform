// Resilience contract baseline (add-llm-retry-resilience, ADR-0016): every
// generated route retries transient model-request failures with bounded
// backoff. The fallback bucket (PI_AI_ERROR) must be in the set because the
// adapter classifies by failure-text patterns — a gateway whose rejection
// wording defeats the patterns (sub2api's "Concurrency limit exceeded for
// user" carries neither "429" nor "rate limit") lands there, and an
// unrecognized error that produced no durable content is still transient.
// Bound: 5 attempts, 1s→15s exponential, 20% jitter.
//
// LEAF MODULE — this file must import nothing (fix-dsh-profile-self-check).
// It lived in `dsh-profile.js` and `llm-providers.js` imported it from there,
// which closed an edge llm-providers → dsh-profile while dsh-profile imports
// llm-providers lazily. Laziness is not enough: `dsh-profile.js` carries a
// top-level await (its self-check block), so it is an ASYNC module, and when
// it is the entry point the lazy edge is taken *while it is still
// evaluating-async*. The spec then makes llm-providers' evaluation wait for
// that async module to finish — which waits for llm-providers. Deadlock:
// `node dsh-profile.js` printed only the dotenv banner and exited 13
// ("Detected unsettled top-level await") every time, so the shipped guard
// could never have run. Both sides now depend on this leaf instead.
export const RETRY_POLICY = Object.freeze({
  mode: "normal",
  maxRetries: 5,
  retryableCodes: [
    "EMPTY_RESPONSE",
    "RATE_LIMIT",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
    "PI_AI_ERROR",
  ],
  backoff: { initialDelayMs: 1000, maxDelayMs: 15000, jitterRatio: 0.2 },
});
