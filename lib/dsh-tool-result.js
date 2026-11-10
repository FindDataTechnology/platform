// dsh `tool/result` parsing, single source (fix-memory-capture-p0 D4).
// Production dsh emits the FLAT shape — message.content is the MCP content
// array and isError sits beside it — while some readers historically assumed
// the WRAPPER shape (message.content[0] = { toolCallId, isError, content: [...] }).
// On a prod cell 704/704 recorded events were flat (2026-10-22): both shapes
// must parse identically. Consumed by server/dsh-events.js (cell WS/persist
// path) and agent-runner/harness/dsh.js (L0 memory observation path) so the
// runner's observations can never diverge from what the cell persisted.

// `ev` is one dsh session.event of type "tool/result". The wrapper shape keeps
// the first content block's nested array as-is (the diagnostic rewrites patch
// its first text block in place); `resultText` is the text blocks joined, null
// when there is none.
export function parseToolResult(ev) {
  const msg = ev?.data?.message;
  const first = msg?.content?.[0];
  const resultBlocks = Array.isArray(first?.content)
    ? first.content
    : Array.isArray(msg?.content)
      ? msg.content
      : null;
  const resultText = Array.isArray(resultBlocks)
    ? resultBlocks.filter((b) => b?.type === "text").map((b) => b.text).join("") || null
    : null;
  return {
    callId: msg?.source?.callId ?? first?.toolCallId,
    resultBlocks,
    resultText,
    isError: !!ev?.data?.error || !!first?.isError || !!msg?.isError,
  };
}
