// scripts/lib/dsh-contracts/dummy-llm.mjs — the local OpenAI-compatible dummy
// endpoint the contracts runner (and the pod-shape measurement) own: records
// every request (headers, model, system prompt, last user text) and answers
// with a well-formed completion so probe turns settle cleanly. A request whose
// final message carries the [HOLD] marker parks without a response until
// release() — the contract-visible stand-in for a slow upstream.
//
// No @deepseek-ai/* imports (kept off the adapter list by design).

import http from "node:http";

export function startDummyLlm() {
  const requests = [];
  const held = [];
  const release = () => {
    for (const h of held.splice(0)) h();
  };

  const partsText = (content) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => (typeof p?.text === "string" ? p.text : "")).join(" ")
        : "";
  const systemTextOf = (messages) => {
    const m = Array.isArray(messages) ? messages.find((x) => x?.role === "system") : null;
    return m ? partsText(m.content) : null;
  };
  const lastTextOf = (messages) => {
    const m = Array.isArray(messages) ? messages.at(-1) : null;
    return m ? partsText(m.content) : null;
  };
  const allTextOf = (messages) =>
    Array.isArray(messages) ? messages.map((m) => partsText(m?.content)).join("\n") : null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let json = null;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* non-JSON body */
      }
      requests.push({
        t: Date.now(),
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || "",
        model: json?.model ?? null,
        stream: json?.stream === true,
        // Per-session composition's black-box evidence: the system prompt, the
        // last user text, and the FULL history text — a conversation request's
        // final message can be an injected system-reminder (skills etc.), so
        // marker correlation must scan the whole history, not the tail.
        system: systemTextOf(json?.messages) ?? null,
        lastUser: lastTextOf(json?.messages) ?? null,
        allText: allTextOf(json?.messages) ?? null,
      });
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      // Only the FINAL message parks (a history marker must not park every
      // later step of the same turn).
      const msgs = Array.isArray(json?.messages) ? json.messages : [];
      const holdMarker = lastTextOf(msgs).includes("[HOLD]");
      if (holdMarker) {
        held.push(() => answer(res, json));
        return;
      }
      answer(res, json);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      // unref: the endpoint must never keep the process alive.
      server.unref();
      resolvePromise({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        heldCount: () => held.length,
        release,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function answer(res, json) {
  if (json?.stream) {
    // Canonical OpenAI SSE: every chunk line is `data: <json>` — a bare JSON
    // line is silently dropped by the SSE reader and the turn dies with "Stream
    // ended without finish_reason" after the retry ladder (found by ⑩, whose
    // turns were the first contracts to need a COMPLETE turn, not just arrival).
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "dsh-contracts", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "dsh-contracts", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "dsh-contracts",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  }
}
