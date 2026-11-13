# Upstream issue draft — dsh-llm-pi-ai failure classification misses concurrency-limit rejections

> Filed against: https://github.com/deepseek-ai/deepseek-harness (apps/cli, package `@deepseek-ai/dsh-llm-pi-ai`)
> Filed: 2026-10-04 · from paas change `add-llm-retry-resilience` (task 5.3)

## Title

`dsh-llm-pi-ai`: classifyPiAiError's message-pattern classification leaves gateway concurrency rejections unclassified (PI_AI_ERROR), so `dsh-llm-retry` correctly refuses to retry a transient failure

## Body

**Environment**: `@deepseek-ai/dsh` 0.1.1-rc.2, `dsh-llm-pi-ai` adapter, `dsh-llm-retry` plugin loaded (dsh-base bundle default), behind an OpenAI-compatible gateway ([Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)).

**What happens**: when the gateway rejects a streaming request with an in-stream SSE error payload whose message is `Concurrency limit exceeded for user, please retry later` (sub2api's per-user concurrency admission; HTTP 200 + `data: {"error":{...}}`), `classifyPiAiError` matches none of its patterns — the message contains neither a status code (`\b429\b`) nor the words `rate.?limit` — so it falls through to the `PI_AI_ERROR` bucket. `PI_AI_ERROR` is deliberately outside the default retryable set, and `dsh-llm-retry` behaves exactly as designed: the agent turn dies.

This is transient by any semantic measure: nothing durable was produced, and the same request succeeds on retry. The failure only becomes fatal because classification depends on the *wording* of the rejection rather than the response's semantics.

**Reproduction** (self-contained): a scripted OpenAI-compatible endpoint that answers the first N requests with

```
HTTP/200 content-type: text/event-stream
data: {"error":{"message":"Concurrency limit exceeded for user, please retry later","type":"concurrency_limit"}}

data: [DONE]
```

then plain completions, plus a real dsh with provider profile:

- **without** `retryPolicy` → turn ends `{"kind":"error","error":{"code":"PI_AI_ERROR","message":"Concurrency limit exceeded for user, please retry later"}}`, zero `llm/retry` events.
- **with** `retryPolicy.retryableCodes` including `PI_AI_ERROR` → the same rejection is retried and the turn completes (`llm/retry` + `llm/retry-started` events observed).

**Ask**: classification for OpenAI-compatible gateways should prefer response semantics over message-wording regexes — e.g. map the SSE error payload's `type`/HTTP status when present, and/or treat known admission-control wordings ("concurrency limit") as `RATE_LIMIT`. Wording-based classification will keep leaking novel-but-transient gateway errors into the unretryable fallback bucket.

**Workaround** (what we ship): provider profiles carry an explicit `retryPolicy` whose `retryableCodes` includes `PI_AI_ERROR`, trading bounded blind retries of unknown errors for turn survival.
