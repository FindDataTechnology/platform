// The hermetic dead-LLM stand-in (baseline-debt fix, 2026-10-22): every
// request answers 401 immediately — a FATAL class for the dsh retry policy
// (AUTH is not in RETRY_POLICY.retryableCodes), so a turn against it ends in
// one HTTP roundtrip.
//
// Why not a closed port (the old 127.0.0.1:9): connection refused classifies
// as TRANSPORT — retryable — and every real e2e turn then burned the full
// 5-step backoff ladder (1s→15s + 20% jitter ≈ 24-36s). That straddled the
// suite's 30s idle waits (the chat-polish 8.3-8.4 / composer-stop dead-LLM
// flake family) and bled still-streaming turns into later tests through the
// connect-time adoption of the running session.
//
// Part of the Playwright webServer command chain (same process group, killed
// on teardown). Port: E2E_DEAD_LLM_PORT (default 3187). Runs that need a
// different model source (smoke's real providers, llm-retry's chaos gateway)
// keep overriding LLM_BASE_URL as before.
import http from "node:http";

const PORT = Number(process.env.E2E_DEAD_LLM_PORT || 3187);

const server = http.createServer((req, res) => {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: { message: `e2e dead llm: ${req.method} ${req.url} answered 401` },
    }),
  );
});

server.on("error", (err) => {
  console.error(`[dead-llm] port ${PORT} unavailable:`, err.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dead-llm] listening on http://127.0.0.1:${PORT} (every request → 401)`);
});
