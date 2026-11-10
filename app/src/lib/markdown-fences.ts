// Fenced-block tokenizer for assistant text (task 1.1 of
// automate-nonweb-acceptance). The renderer used to split on a regex that
// dropped the language marker, so an ```echarts fence could only ever become
// a code block. This keeps the language and the closed/open state so the
// renderer can route chart fences to ChartView while a still-streaming fence
// stays a code block.

export type FenceToken =
  | { kind: "text"; body: string }
  | { kind: "code"; lang: string; body: string; closed: boolean };

const DELIMITER = /(```[^\n]*\n?)/g;

export function tokenizeFences(text: string): FenceToken[] {
  const parts = text.split(DELIMITER);
  const tokens: FenceToken[] = [];
  let open: { lang: string } | null = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 1) {
      // A delimiter: odd position by construction, so opener/closer alternate.
      if (open) {
        const last = tokens.at(-1);
        if (last?.kind === "code") last.closed = true;
        open = null;
      } else {
        open = { lang: part.replace(/^```/, "").replace(/\n$/, "").trim() };
      }
      continue;
    }
    if (!part) continue;
    if (open) tokens.push({ kind: "code", lang: open.lang, body: part, closed: false });
    else tokens.push({ kind: "text", body: part });
  }
  return tokens;
}

// The chart route: only an `echarts` fence whose body parses to a plain
// object becomes a chart; anything else falls back to a code block.
export function chartOptionFromFence(token: FenceToken): Record<string, unknown> | null {
  if (token.kind !== "code") return null;
  if (token.lang.toLowerCase() !== "echarts") return null;
  try {
    const parsed = JSON.parse(token.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}