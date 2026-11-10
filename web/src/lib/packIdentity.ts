// ── Market card identity derivations (overhaul-market-catalog-presentation P2) ──
//
// The two data-side derivations the card needs, kept as pure functions so the
// card stays a renderer and the tests can pin the chains without React.

// Canonical line word → the seal character. The words are the server's stable
// identity strings (pack-category-lines zh main track — the value the facet
// filter carries back), so this table keys on them rather than on a new id.
// The pairing with lib/pack-taxonomy.js is pinned by
// scripts/test-pack-display-identity.mjs (a sixth line that misses here is a
// drift caught by that test, never silently by the renderer).
const LINE_MARK_CHARS: Record<string, string> = {
  "壹座 · 智能体团队": "壹",
  "识律 · 法律智能": "律",
  "柏讯 · 数据与情报": "柏",
  "谦面 · 业务流": "谦",
  "萬星 · 智能体连接": "万",
};

/** The single character for a pack's seal. A declared line → its brand char;
 *  unmapped/suppressed → the first character of the displayed name (honest
 *  derivation from what is already on screen, never a guess about a line). */
export function markCharOf(line: string | undefined, name: string | undefined): string {
  if (line && LINE_MARK_CHARS[line]) return LINE_MARK_CHARS[line];
  const chars = Array.from((name ?? "").trim());
  return chars.length > 0 ? (chars[0] ?? "?") : "?";
}

// Same character ranges as lib/pack-manifest.js displayWidth (the publish
// gate's own measure) — the card must budget width exactly as the server does.
const CJK_WIDTH_RE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u3040-\u30FF\u3190-\u319F\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF]/;

/** CJK-aware display width (a full-width char counts 2). */
export function displayWidth(value: string): number {
  let n = 0;
  for (const ch of value) n += CJK_WIDTH_RE.test(ch) ? 2 : 1;
  return n;
}

// A card promise fits at most two lines: 60 display widths ≈ one full Latin
// line or two CJK lines. Longer text is cut at a boundary, never mid-word.
const PROMISE_MAX_WIDTH = 60;

/** The card's one-line promise: the first sentence of a longer text —
 *  terminated at 。！？, or a Latin .!? that ends the sentence (next char
 *  whitespace/end, so "v1.2" never cuts) — never a half-clause. */
export function firstSentence(text: string | undefined): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  for (let i = 0; i < t.length; i++) {
    const ch = t.charAt(i);
    if (ch === "。" || ch === "！" || ch === "？") return clipToWidth(t.slice(0, i + 1));
    if ((ch === "." || ch === "!" || ch === "?") && (i + 1 >= t.length || /\s/.test(t.charAt(i + 1)))) {
      return clipToWidth(t.slice(0, i + 1));
    }
  }
  return clipToWidth(t);
}

function clipToWidth(s: string): string {
  if (displayWidth(s) <= PROMISE_MAX_WIDTH) return s;
  // Prefer the last clause/space boundary past half the budget; otherwise cut
  // at the fitting width and mark the cut with an ellipsis.
  let width = 0;
  let cut = s.length;
  let lastSpace = -1;
  let lastPunct = -1;
  for (let i = 0; i < s.length; i++) {
    width += displayWidth(s.charAt(i));
    if (width > PROMISE_MAX_WIDTH - 1) {
      cut = i;
      break;
    }
    if (s.charAt(i) === " " || s.charAt(i) === "\u3000") lastSpace = i;
    if (/[，、；：,;:]/.test(s.charAt(i))) lastPunct = i;
  }
  const end = lastSpace > Math.floor(cut / 2) ? lastSpace : lastPunct > Math.floor(cut / 2) ? lastPunct : cut;
  return `${s.slice(0, end).trimEnd()}…`;
}
