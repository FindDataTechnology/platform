// MCP depth tool-surface helpers (polish-facet-catalog-depth).
//
// Pure, dependency-free .ts so `node --test scripts/test-mcp-depth-tools.mjs`
// imports it directly (repo convention: behavior legs run in e2e/真机, pure
// functions are unit-tested in scripts/). JSX stays in McpCatalog.tsx.

// The shape McpCatalog feeds these helpers — a subset of the depth view's
// tool rows; structural typing keeps the helpers testable with plain
// fixtures.
export type ToolLike = {
  name: string;
  description: string;
  annotation?: { name: string | null; summary: string | null } | null;
};

export type ToolGroup<T> = {
  // null = the「其他」bucket: single-member prefix groups and names without
  // an underscore prefix merge here (anti-fragmentation, design D2). It
  // always renders LAST, regardless of alphabetical order.
  prefix: string | null;
  tools: T[];
};

// Group tools by the segment before the first "_" in the tool name
// (alerts_* / compute_* — the zero-data signal the registry's tool_list
// already carries). Groups with a single member fold into the 其他 bucket.
// Prefix groups sort alphabetically; in-group order preserves the registry's
// declaration order.
export function groupToolsByPrefix<T extends ToolLike>(tools: T[]): ToolGroup<T>[] {
  const buckets = new Map<string, T[]>();
  const other: T[] = [];
  for (const tool of tools) {
    const idx = tool.name.indexOf("_");
    // idx <= 0: no underscore, or a leading one (name starts with "_") — both
    // carry no usable prefix signal.
    if (idx <= 0) {
      other.push(tool);
      continue;
    }
    const prefix = tool.name.slice(0, idx);
    const list = buckets.get(prefix);
    if (list) list.push(tool);
    else buckets.set(prefix, [tool]);
  }

  const groups: ToolGroup<T>[] = [];
  const folded: T[] = [...other];
  for (const prefix of [...buckets.keys()].sort()) {
    const list = buckets.get(prefix)!;
    if (list.length === 1) folded.push(list[0]);
    else groups.push({ prefix, tools: list });
  }
  if (folded.length > 0) groups.push({ prefix: null, tools: folded });
  return groups;
}

// Client-side filter over the depth tool surface: case-insensitive includes
// across everything the visitor can read on the card — the raw name, the
// localized human label, and the displayed summary (annotation summary when
// present, raw description otherwise — the same「注释优先、原文兜底」the card
// renders; matching the raw text too is what makes the filter useful on the
// 193 unannotated wire-cell tools).
export function filterTools<T extends ToolLike>(tools: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tools;
  return tools.filter((t) =>
    [t.name, t.annotation?.name ?? "", t.annotation?.summary ?? "", t.description ?? ""]
      .join("\n")
      .toLowerCase()
      .includes(needle),
  );
}

// ~4 preview lines at text-xs in a narrow grid column: content longer than
// this (or carrying many hard line breaks — DSL parameter blocks) gets the
// expand affordance; shorter text renders fully with no affordance.
export function descriptionExceedsPreview(text: string): boolean {
  return text.length > 160 || text.split("\n").length > 4;
}
