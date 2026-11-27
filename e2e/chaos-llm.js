// Scripted OpenAI-compatible chaos gateway (add-llm-retry-resilience).
//
// One local endpoint that plays "the model" for a real dsh runtime, with
// controllable failure injection — the platform's resilience contract is
// probed against it, never against a real upstream:
//
//   POST /v1/chat/completions  — behavior per the current script:
//     mode "pass"               → plain SSE text completion ("ok").
//     mode "delegate2"          → the FIRST request after a control reset
//                                 answers two PARALLEL `subagent` tool_calls
//                                 (children then hit "pass"); everything else
//                                 answers text.
//     mode "concurrency-chaos"  → the first `rejectCount` requests are
//                                 rejected with the sub2api concurrency
//                                 message (the rejection that started this
//                                 change: text that defeats the adapter's
//                                 message-pattern classification); then pass.
//     mode "invalid-fatal"      → the first `rejectCount` requests are
//                                 rejected as invalid_request (classifies
//                                 INVALID_REQUEST — permanently fatal even
//                                 with the retry policy on; drives the
//                                 subagent-failure-card scenario).
//     mode "chart"              → the answer is an ```echarts fence (a live
//                                 chart for the mobile/web chart lanes); the
//                                 series comes from the control `shape`
//                                 (bar|line|pie|scatter) or, absent that, the
//                                 last user turn's wording; default bar.
//     mode "slow"               → every answer is delayed by `delayMs`
//                                 (default 8000) before the normal text
//                                 completion. Gives a spec a deterministically
//                                 LONG turn — the state turn-dispatch's queue
//                                 needs in order to be observable at all
//                                 (concurrent-chat-sessions e2e).
//   POST /__chaos/control       — { mode, rejectCount, shape } to re-arm.
//
// Rejection shapes (the wire form of the concurrency message):
//   "sse-error"  HTTP 200 + SSE `data: {"error": {...}}` (in-stream failure)
//   "http-429"   HTTP 429 + JSON error body
//   "http-503"   HTTP 503 + plain-text body
//
// Dual use: importable (probe-llm-retry.mjs) and standalone
// (`node e2e/chaos-llm.js`, port from CHAOS_LLM_PORT, default 3199) so a
// Playwright run can point LLM_BASE_URL here and drive the real app.

import http from "node:http";

const CONCURRENCY_MESSAGE = "Concurrency limit exceeded for user, please retry later";
const INVALID_MESSAGE = "invalid request: quota frame exceeded for this key";

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function textChunk(id, text) {
  return [
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

// One deterministic echarts option per series — the mobile chart lane asserts
// chart-ok/!chart-fallback per prompt, so these must render with a default
// echarts build (no plugins, no dataZoom).
export function chartOption(series) {
  const base = { animation: false };
  if (series === "line") {
    return { ...base, xAxis: { type: "category", data: ["Mon", "Tue", "Wed", "Thu"] }, yAxis: { type: "value" }, series: [{ type: "line", smooth: true, data: [120, 200, 150, 280] }] };
  }
  if (series === "pie") {
    return { ...base, series: [{ type: "pie", radius: "70%", data: [{ name: "A", value: 40 }, { name: "B", value: 32 }, { name: "C", value: 28 }] }] };
  }
  if (series === "scatter") {
    return { ...base, xAxis: { type: "value" }, yAxis: { type: "value" }, series: [{ type: "scatter", data: [[10, 8], [8, 5], [13, 12], [9, 9], [11, 6]] }] };
  }
  return { ...base, xAxis: { type: "category", data: ["a", "b", "c"] }, yAxis: { type: "value" }, series: [{ type: "bar", data: [1, 2, 3] }] };
}

export function chartFence(series) {
  return "```echarts\n" + JSON.stringify(chartOption(series)) + "\n```";
}

function chartSeriesFrom(state, messages) {
  if (["bar", "line", "pie", "scatter"].includes(state.shape)) return state.shape;
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content.toLowerCase() : "";
  if (/line|折线/.test(text)) return "line";
  if (/pie|饼/.test(text)) return "pie";
  if (/scatter|散点/.test(text)) return "scatter";
  return "bar";
}

function toolCallsChunk(id) {
  const call = (i, prompt, description) => ({
    index: i,
    id: `chaos-call-${i}`,
    type: "function",
    function: { name: "subagent", arguments: JSON.stringify({ description, prompt, run_in_background: false }) },
  });
  return [
    {
      id,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", tool_calls: [call(0, "Reply with only the word: one", "chaos child one"), call(1, "Reply with only the word: two", "chaos child two")] },
          finish_reason: null,
        },
      ],
    },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

export function startChaosLlm({ port = 0, host = "127.0.0.1" } = {}) {
  const state = { mode: "pass", rejectCount: 0, skipCount: 0, shape: "sse-error", rejectKind: null, rejectedThisArm: 0, servedThisArm: 0, delegatedThisArm: false, delayMs: 8000 };
  const requests = []; // { t, mode, model, stream, rejected, lastRole, hasSubagentTool }

  const reject = (res, kind) => {
    const message = kind === "invalid" ? INVALID_MESSAGE : CONCURRENCY_MESSAGE;
    state.rejectedThisArm += 1;
    requests[requests.length - 1].rejected = kind;
    if (state.shape === "sse-error") {
      // In-stream failure: HTTP 200, then an SSE error payload — the wire
      // form whose message text carries no status code anywhere.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ error: { message, type: kind === "invalid" ? "invalid_request_error" : "concurrency_limit" } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else if (state.shape === "http-429") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message, type: "concurrency_limit" } }));
    } else {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end(message);
    }
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/__chaos/control") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (typeof body.mode === "string") state.mode = body.mode;
        if (Number.isInteger(body.rejectCount)) state.rejectCount = body.rejectCount;
        if (Number.isInteger(body.skip)) state.skipCount = body.skip;
        if (typeof body.shape === "string") state.shape = body.shape;
        if (body.rejectKind === "invalid" || body.rejectKind === "concurrency") state.rejectKind = body.rejectKind;
        if (Number.isInteger(body.delayMs) && body.delayMs >= 0) state.delayMs = body.delayMs;
        // Re-arm: the rejection budget, the pre-rejection skip window, and the
        // one-shot delegation trigger all restart for the requests that follow.
        state.rejectedThisArm = 0;
        state.servedThisArm = 0;
        state.delegatedThisArm = false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ mode: state.mode, rejectCount: state.rejectCount, skip: state.skipCount, shape: state.shape, delayMs: state.delayMs }));
        return;
      }
      if (req.method === "GET" && req.url === "/__chaos/requests") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(requests));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404);
        res.end();
        return;
      }
      let json = null;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* non-JSON body */
      }
      const stream = json?.stream === true;
      const messages = Array.isArray(json?.messages) ? json.messages : [];
      const lastRole = messages.length ? (messages[messages.length - 1].role ?? null) : null;
      const hasSubagentTool = (json?.tools ?? []).some((t) => t?.function?.name === "subagent" || t?.name === "subagent");
      const served = requests.length;
      requests.push({ t: Date.now(), mode: state.mode, model: json?.model ?? null, stream, rejected: null, lastRole, hasSubagentTool });
      state.servedThisArm += 1;
      console.log(`[chaos] req #${served} mode=${state.mode} shape=${state.shape} stream=${stream} role=${lastRole}`);

      // Armed rejections burn after the skip window (any request kind —
      // parent or child). `skip` lets a scenario spare the early requests
      // (e.g. title generation and the parent's own call) so the rejections
      // land on chosen victims.
      if (state.rejectedThisArm < state.rejectCount && state.servedThisArm > state.skipCount) {
        reject(res, state.rejectKind ?? (state.mode === "invalid-fatal" ? "invalid" : "concurrency"));
        return;
      }

      // Scripted success. Delegation trigger: the FIRST tool-roster-bearing
      // user-turn request after a control reset answers two PARALLEL subagent
      // tool_calls; every other request answers plain text. Request-body shape
      // (not arrival order) picks the trigger, so stray auxiliary calls (e.g.
      // title generation) cannot eat it.
      const isDelegateFirst =
        state.mode === "delegate2" && !state.delegatedThisArm && lastRole === "user" && hasSubagentTool;
      if (isDelegateFirst) state.delegatedThisArm = true;
      const answerText = state.mode === "chart" ? chartFence(chartSeriesFrom(state, messages)) : "ok";
      if (state.mode === "slow" && state.delayMs > 0) {
        setTimeout(() => answerNow(res, stream, isDelegateFirst, served, answerText), state.delayMs);
        return;
      }
      answerNow(res, stream, isDelegateFirst, served, answerText);
    });
  });

  // One success answer — factored out so the slow mode can defer it.
  function answerNow(res, stream, isDelegateFirst, served, answerText = "ok") {
    if (stream) {
      sse(res, isDelegateFirst ? toolCallsChunk(`chaos-${served}`) : textChunk(`chaos-${served}`, answerText));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chaos-${served}`,
          object: "chat.completion",
          choices: [
            isDelegateFirst
              ? {
                  index: 0,
                  message: {
                    role: "assistant",
                    tool_calls: [0, 1].map((i) => ({
                      id: `chaos-call-${i}`,
                      type: "function",
                      function: { name: "subagent", arguments: JSON.stringify({ description: `chaos child ${i === 0 ? "one" : "two"}`, prompt: `Reply with only the word: ${i === 0 ? "one" : "two"}`, run_in_background: false }) },
                    })),
                  },
                  finish_reason: "tool_calls",
                }
              : { index: 0, message: { role: "assistant", content: answerText }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      server.unref();
      resolve({
        url: `http://${host}:${actual}/v1`,
        controlUrl: `http://${host}:${actual}`,
        state,
        requests,
        control: (patch) =>
          fetch(`http://${host}:${actual}/__chaos/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          }).then((r) => r.json()),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Standalone entry (e2e): `node e2e/chaos-llm.js` — serve until killed by the
// Playwright webServer teardown (same process group).
if (process.argv[1] && process.argv[1].endsWith("chaos-llm.js")) {
  const port = Number(process.env.CHAOS_LLM_PORT || 3288);
  startChaosLlm({ port }).then((g) => {
    console.log(`[chaos-llm] listening on ${g.controlUrl} (LLM base ${g.url})`);
    // Keep the process alive in standalone mode (the listener is unref'd).
    setInterval(() => {}, 1 << 30);
  });
}
