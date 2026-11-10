// The chart-fence contract shared by the server's capture path and the web's
// library-entry badge: a ```echarts fence whose body parses as a JSON object is
// a chart, and its library identity is sha256(JSON.stringify(parsed)) — the
// exact rule resources.js applies when capturing. Keeping the rule here lets
// the badge correlate a rendered fence with a captured resource row by
// content_hash without any server round-trip.
//
// The hash is async because browsers only expose WebCrypto; node exposes the
// same subtle.digest, so this module runs identically in both runtimes (and in
// tests).

const CHART_FENCE = /```echarts[ \t]*\r?\n([\s\S]*?)```/g;

// Fence bodies that satisfy the rendering contract (JSON object), in order.
export function extractChartFences(text: string): string[] {
  if (typeof text !== "string" || !text.includes("```echarts")) return [];
  const bodies: string[] = [];
  for (const match of text.matchAll(CHART_FENCE)) {
    const body = match[1]?.trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) bodies.push(body);
    } catch {
      // not a chart: renderers fall back to a code block, capture skips it
    }
  }
  return bodies;
}

// sha256(JSON.stringify(JSON.parse(body))) — null when the body is not a chart
// option. Whitespace inside the fence never matters: the hash is over the
// canonical re-serialization.
export async function canonicalChartHash(fenceBody: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceBody.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The set of content hashes a text's chart fences would capture to.
export async function chartHashesInText(text: string): Promise<string[]> {
  const hashes: string[] = [];
  for (const body of extractChartFences(text)) {
    const hash = await canonicalChartHash(body);
    if (hash) hashes.push(hash);
  }
  return hashes;
}
