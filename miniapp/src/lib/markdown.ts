// A small, dependency-free markdown parser for the mini-program renderer.
//
// Why not mp-html: registering a native npm component requires a
// devtools-side "构建 npm" step, and streaming partial markdown is a known
// perf trap there anyway. This parser covers exactly the subset the spec
// names — headings, paragraphs, lists, quotes, code fences, pipe tables,
// links, bold/italic/inline code — and emits data the Taro renderer turns
// into plain Text/View nodes (no HTML string ever exists, so there is no
// injection surface).
//
// Pure functions, unit-tested under node (src/lib/markdown.test.mjs).

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "link"; text: string; href: string };

export type MdNode =
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "hr" };

// Inline tokenizer: code spans win over emphasis, emphasis over links, all
// scanned left-to-right. No nesting inside emphasis (avoids regex cliffs).
const INLINE_TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  while (rest.length > 0) {
    const m = INLINE_TOKEN.exec(rest);
    if (!m || m.index === undefined) break;
    if (m.index > 0) out.push({ type: "text", text: rest.slice(0, m.index) });
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push({ type: "code", text: tok.slice(1, -1) });
    } else if (tok.startsWith("**")) {
      out.push({ type: "strong", text: tok.slice(2, -2) });
    } else if (tok.startsWith("*")) {
      out.push({ type: "em", text: tok.slice(1, -1) });
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      if (link) out.push({ type: "link", text: link[1] ?? "", href: link[2] ?? "" });
      else out.push({ type: "text", text: tok });
    }
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) out.push({ type: "text", text: rest });
  return out;
}

const FENCE = /^```(\w*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP = /^\s*\|?[\s:|-]+\|?\s*$/;

function splitRow(line: string): string[] {
  const inner = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  return inner.split("|").map((c) => c.trim());
}

// Parse markdown into block nodes. Tolerant by design: anything unrecognized
// becomes paragraph text, and an unterminated fence closes at end-of-input
// (streamed content is completed before this runs, but a malformed document
// must never throw).
export function parseMarkdown(src: string): MdNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const nodes: MdNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence (or EOF)
      nodes.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    if (HR.test(line)) {
      nodes.push({ kind: "hr" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      nodes.push({
        kind: "heading",
        level: Math.min(6, (heading[1] ?? "#").length),
        inlines: parseInline(heading[2] ?? ""),
      });
      i++;
      continue;
    }

    // Table: a header row followed by a separator row.
    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      const header = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? "")) {
        rows.push(splitRow(lines[i] ?? "").map(parseInline));
        i++;
      }
      nodes.push({ kind: "table", header, rows });
      continue;
    }

    const listItem = LIST_ITEM.exec(line);
    if (listItem) {
      const ordered = /^\d/.test(listItem[2] ?? "");
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i] ?? "");
        if (!m) break;
        items.push(parseInline(m[3] ?? ""));
        i++;
      }
      nodes.push({ kind: "list", ordered, items });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body: string[] = [quote[1] ?? ""];
      i++;
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i] ?? "");
        if (!m) break;
        body.push(m[1] ?? "");
        i++;
      }
      nodes.push({ kind: "quote", inlines: parseInline(body.join(" ")) });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: consecutive non-blank lines that don't start another block.
    const body: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (
        next.trim() === "" ||
        FENCE.test(next) ||
        HEADING.test(next) ||
        HR.test(next) ||
        LIST_ITEM.test(next) ||
        QUOTE.test(next) ||
        (TABLE_ROW.test(next) && TABLE_SEP.test(lines[i + 1] ?? ""))
      ) {
        break;
      }
      body.push(next);
      i++;
    }
    nodes.push({ kind: "paragraph", inlines: parseInline(body.join("\n")) });
  }

  return nodes;
}

// An `echarts` fence body must be a single JSON object; anything else becomes
// an ordinary code block (mirrors the web renderer's contract).
export function parseChartOption(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
