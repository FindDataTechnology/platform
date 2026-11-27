// Reasoning-trace stripping (fix-external-team-chat-lane B5).
//
// The walkthrough (docs/product-intro-walkthrough-2026-10-30.md) caught a
// visitor-visible leak: a web chat answer began with a literal
// `<thinking>Let me check what wire-ops tools are available…</thinking>` —
// the model's reasoning trace reached the transcript as ordinary text. The
// bot lane has stripped this since 2026-10-29 (the ⑨ defect, server/bots.js);
// the web text path had no equivalent.
//
// One implementation, two call sites (bot out-bound + web text) — a second
// copy would drift, and the drift is exactly what the walkthrough caught.

const REASONING_BLOCK_RE = /<(thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi;
const REASONING_OPEN_RE = /<(thinking|reasoning|thought)>[\s\S]*$/i;

// The tag names the stripper knows. Both the open and the close side use it.
const OPEN_TAGS = ["thinking", "reasoning", "thought"];
const CLOSE_TAGS = OPEN_TAGS.map((t) => `</${t}>`);
const OPEN_TAGS_LITERAL = OPEN_TAGS.map((t) => `<${t}>`);

// Strip reasoning traces from a complete message body.
export function stripReasoningLeak(body) {
  let s = String(body ?? "");
  s = s.replace(REASONING_BLOCK_RE, "");
  // An unterminated trace (stream cut mid-thought) swallows the rest of the
  // message: drop from the stray open tag to the end rather than leak it.
  s = s.replace(REASONING_OPEN_RE, "");
  return s.trim();
}

// The longest suffix of `buf` that could still grow into one of `literals`
// (a partial tag). Everything before it is safe to emit.
function partialTagSuffix(buf, literals) {
  const max = Math.max(...literals.map((l) => l.length)) - 1;
  for (let n = Math.min(max, buf.length); n > 0; n--) {
    const tail = buf.slice(buf.length - n);
    if (literals.some((l) => l.startsWith(tail))) return tail;
  }
  return "";
}

// Streaming variant for delta-by-delta output: a reasoning block can span
// several deltas, so per-delta stripping alone leaks the pieces around the
// split. This holds back any tail that could still become a reasoning tag
// and drops a block that starts but never closes — the same semantics as
// stripReasoningLeak on a complete body.
export function createReasoningLeakFilter() {
  let buf = ""; // text not yet emitted
  let inBlock = false; // an open tag was seen; its close has not arrived
  return {
    // Feed one delta; returns the text that may be shown (possibly "").
    push(delta) {
      buf += String(delta ?? "");
      let out = "";
      for (;;) {
        if (inBlock) {
          const close = CLOSE_TAGS.reduce((best, tag) => {
            const i = buf.indexOf(tag);
            if (i === -1) return best;
            if (!best || i < best.index) return { index: i, tag };
            return best;
          }, null);
          if (!close) {
            // No close tag yet: keep only what could still become one.
            buf = partialTagSuffix(buf, CLOSE_TAGS);
            return out;
          }
          buf = buf.slice(close.index + close.tag.length);
          inBlock = false;
          continue;
        }
        const open = OPEN_TAGS_LITERAL.reduce((best, tag) => {
          const i = buf.toLowerCase().indexOf(tag);
          if (i === -1) return best;
          if (!best || i < best.index) return { index: i, tag };
          return best;
        }, null);
        if (!open) {
          // Nothing opens a block here — emit everything except a possible
          // partial open tag at the tail.
          const keep = partialTagSuffix(buf, OPEN_TAGS_LITERAL);
          out += buf.slice(0, buf.length - keep.length);
          buf = keep;
          return out;
        }
        out += buf.slice(0, open.index);
        buf = buf.slice(open.index + open.tag.length);
        inBlock = true;
      }
    },
    // End of turn: whatever is held is a dangling open/close tag — dropped,
    // matching stripReasoningLeak on a body that never closed its block.
    flush() {
      buf = "";
      inBlock = false;
      return "";
    },
  };
}
